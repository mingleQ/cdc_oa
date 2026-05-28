const { db, now } = require("../db");
const { clientIp, parseJson, pageParams, moduleNameForRequest, requestTypeText } = require("../core/util");
const { requireAuth } = require("../core/auth");
const { requestVisibleWhere, canViewRequest } = require("../core/permissions");
const { writeOperationLog, notify } = require("../core/audit");
const { getUserByAccount, getRequestById } = require("../repository");
const wf = require("../services/workflow");
const approval = require("../services/approval");
const leaveBalance = require("../services/leave-balance");

function register(app) {
  /* ============ 业务申请（请假/出差/用车） ============ */

  app.get("/api/requests", requireAuth, (req, res) => {
    const visible = requestVisibleWhere(req.user, "r");
    const params = [...visible.params];
    let where = `WHERE ${visible.sql}`;
    if (req.query.type) { where += " AND r.type = ?"; params.push(req.query.type); }
    if (req.query.status) { where += " AND r.status = ?"; params.push(req.query.status); }
    if (req.query.category) { where += " AND r.category = ?"; params.push(req.query.category); }
    if (req.query.keyword) { where += " AND (r.reason LIKE ? OR u.name LIKE ?)"; params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`); }
    if (req.query.from) { where += " AND r.start_date >= ?"; params.push(req.query.from); }
    if (req.query.to) { where += " AND r.start_date <= ?"; params.push(req.query.to); }
    if (req.query.mine === "1") {
      where += " AND (r.current_approver_id = ? OR (',' || r.pending_approvers || ',') LIKE ?)";
      params.push(req.user.id, `%,${req.user.id},%`);
    }
    const joins = "FROM requests r JOIN departments d ON d.id = r.dept_id JOIN users u ON u.id = r.applicant_id LEFT JOIN users a ON a.id = r.current_approver_id";
    const total = db.prepare(`SELECT COUNT(*) AS c ${joins} ${where}`).get(...params).c;
    const { page, pageSize, limit, offset } = pageParams(req);
    const items = db.prepare(`SELECT r.*, d.name AS dept_name, u.name AS applicant_name, a.name AS approver_name ${joins} ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ items, total, page, pageSize });
  });

  app.post("/api/requests", requireAuth, (req, res) => {
    const { type, category, startDate, endDate, reason, fields, applyTime } = req.body;
    if (!["leave", "trip", "vehicle"].includes(type)) return res.status(400).json({ message: "业务类型不正确" });
    if (!category || !startDate || !endDate || !reason) return res.status(400).json({ message: "申请信息不完整" });
    if (String(endDate) < String(startDate)) return res.status(400).json({ message: "结束时间不能早于开始时间" });
    // 年假：提交时校验额度并预扣，驳回/撤回时由引擎回补
    if (type === "leave" && category === "年假") {
      try { leaveBalance.reserveForRequest({ type, category, start_date: startDate, end_date: endDate }, req.user.id); }
      catch (e) { return res.status(e.code || 400).json({ message: e.message }); }
    }
    const workflow = wf.getEnabledWorkflow(type);
    const firstNode = workflow?.nodes?.[0];
    const fallback = getUserByAccount("leader");
    const approver = wf.resolveApprover(firstNode, req.user, fallback) || fallback;
    const result = db.prepare(`
      INSERT INTO requests (type, category, applicant_id, dept_id, start_date, end_date, reason, fields_json, status, current_node, current_node_id, current_approver_id, apply_time, workflow_id, workflow_step, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(type, category, req.user.id, req.user.dept_id, startDate, endDate, reason, JSON.stringify(fields || {}),
      firstNode?.node_name || "部门负责人审批", firstNode?.id || null, approver?.id || null, applyTime || now(), workflow?.id || null, now(), now());
    if (approver) notify(approver.id, `${requestTypeText(type)}待审批`, `${req.user.name} 提交了${requestTypeText(type)}申请：${reason}`, "request", result.lastInsertRowid);
    writeOperationLog(req.user, moduleNameForRequest(type), "提交申请", "request", String(result.lastInsertRowid), reason, clientIp(req));
    res.status(201).json(getRequestById(result.lastInsertRowid));
  });

  app.get("/api/requests/:id", requireAuth, (req, res) => {
    const request = getRequestById(req.params.id);
    if (!request) return res.status(404).json({ message: "申请不存在" });
    if (!canViewRequest(req.user, request)) return res.status(403).json({ message: "无权限查看" });
    request.fields = parseJson(request.fields_json, {});
    request.approvals = db.prepare("SELECT * FROM approval_records WHERE business_type = 'request' AND business_id = ? ORDER BY id").all(request.id);
    // 流程全景：申请人需要看到链路走到哪一步，所以把全部节点 + 当前审批人姓名一起返回。
    request.workflow_nodes = request.workflow_id
      ? db.prepare("SELECT id, sort_order, node_name, node_type, node_kind, pos_x, pos_y, allow_terminal FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order, id").all(request.workflow_id)
      : [];
    request.workflow_edges = request.workflow_id
      ? db.prepare("SELECT id, from_node_id, to_node_id, label, condition_json FROM workflow_edges WHERE workflow_id = ? ORDER BY sort_order, id").all(request.workflow_id)
      : [];
    request.can_terminate = !!(request.workflow_id && request.current_node_id
      && db.prepare("SELECT 1 FROM workflow_edges WHERE workflow_id = ? AND from_node_id = ? AND to_node_id IS NULL").get(request.workflow_id, request.current_node_id));
    if (request.current_approver_id) {
      const u = db.prepare("SELECT name FROM users WHERE id = ?").get(request.current_approver_id);
      request.current_approver_name = u ? u.name : "";
    }
    // 用车单：附最新一条行车记录，详情页直接展示驾驶员/车号/读表
    if (request.type === "vehicle") {
      request.vehicle_record = db.prepare(`
        SELECT vr.*, v.plate_no, v.driver
        FROM vehicle_records vr
        LEFT JOIN vehicles v ON v.id = vr.vehicle_id
        WHERE vr.request_id = ?
        ORDER BY vr.id DESC LIMIT 1
      `).get(request.id) || null;
    }
    res.json(request);
  });

  // 审批动作统一委托 services/approval（请假/出差/用车与公文共用同一引擎）。
  const a = approval.requestAdapter;
  const run = (fn, req, res) => approval.respond(res, fn(a, req.params.id, req.user, req.body, clientIp(req)));
  app.post("/api/requests/:id/approve", requireAuth, (req, res) => run(approval.approve, req, res));
  app.post("/api/requests/:id/reject", requireAuth, (req, res) => run(approval.reject, req, res));
  app.post("/api/requests/:id/transfer", requireAuth, (req, res) => run(approval.transfer, req, res));
  app.post("/api/requests/:id/add-sign", requireAuth, (req, res) => run(approval.addSign, req, res));
  app.post("/api/requests/:id/withdraw", requireAuth, (req, res) => run(approval.withdraw, req, res));
}

module.exports = { register };
