const { db, now } = require("../db");
const { clientIp, today, pageParams } = require("../core/util");
const { requireAuth, requireRole } = require("../core/auth");
const { documentVisibleWhere, canViewDocument, buildReaderIds } = require("../core/permissions");
const { writeOperationLog, writeApproval, notify } = require("../core/audit");
const { getUserByAccount, getUserById, getDocumentById } = require("../repository");
const wf = require("../services/workflow");
const approval = require("../services/approval");

function register(app) {
  /* ============ 公文管理 ============ */

  app.get("/api/documents", requireAuth, (req, res) => {
    const where = documentVisibleWhere(req.user);
    const params = [...where.params];
    let cond = `WHERE ${where.sql}`;
    if (req.query.type) { cond += " AND doc.type = ?"; params.push(req.query.type); }
    if (req.query.status === "archived") {
      // 「已归档」= status approved 且 current_node 落在归档/结束语义节点
      cond += " AND doc.status = 'approved' AND doc.current_node IN ('归档', '办结归档', '结束')";
    } else if (req.query.status) {
      cond += " AND doc.status = ?"; params.push(req.query.status);
    }
    if (req.query.keyword) { cond += " AND (doc.title LIKE ? OR doc.no LIKE ? OR doc.source_unit LIKE ?)"; params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`, `%${req.query.keyword}%`); }
    if (req.query.from) { cond += " AND doc.created_at >= ?"; params.push(req.query.from); }
    if (req.query.to) { cond += " AND doc.created_at <= ?"; params.push(`${req.query.to}T23:59:59`); }
    if (req.query.mine === "1") {
      cond += " AND (doc.current_approver_id = ? OR (',' || doc.pending_approvers || ',') LIKE ?)";
      params.push(req.user.id, `%,${req.user.id},%`);
    }
    const joins = "FROM documents doc JOIN users u ON u.id = doc.created_by";
    const total = db.prepare(`SELECT COUNT(*) AS c ${joins} ${cond}`).get(...params).c;
    const { page, pageSize, limit, offset } = pageParams(req);
    const items = db.prepare(`SELECT doc.*, u.name AS creator_name ${joins} ${cond} ORDER BY doc.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ items, total, page, pageSize });
  });

  // 发文允许普通员工起草（科员→送科长核稿）；收文登记仍限审批人。
  app.post("/api/documents", requireAuth, (req, res) => {
    const { type, no, title, secret, urgency, ownerDept, readers, readerIds, content,
      sourceUnit, mainSend, ccSend, sealNo, docDate,
      originNo, issueDate, copies } = req.body;
    if (!["收文", "发文"].includes(type)) return res.status(400).json({ message: "公文类型不正确" });
    if (type === "收文" && !["admin", "leader"].includes(req.user.role_code)) {
      return res.status(403).json({ message: "无权限登记收文" });
    }
    if (!no || !title) return res.status(400).json({ message: "文号和标题必填" });
    // 发文文号必须含完整序号：闭合括号「〕」之后需要出现数字，避免只填「贵疾控发〔2026〕」前缀
    if (type === "发文" && !/\d/.test(String(no).split("〕").pop() || "")) {
      return res.status(400).json({ message: "发文文号需填写完整序号，如「贵疾控发〔2026〕15号」" });
    }
    // 发文走 document_out 流程；收文继续用 document 流程（阅文卡链路）
    const wfType = type === "发文" ? "document_out" : "document";
    const workflow = wf.getEnabledWorkflow(wfType) || wf.getEnabledWorkflow("document");
    const firstNode = workflow?.nodes?.[0];
    const approver = wf.resolveApprover(firstNode, req.user, getUserByAccount("admin"));
    const result = db.prepare(`
      INSERT INTO documents (type, no, title, secret, urgency, owner_dept, readers, reader_ids, content,
        source_unit, main_send, cc_send, seal_no, doc_date, origin_no, issue_date, copies,
        status, current_node, current_node_id, current_approver_id, created_by, workflow_id, workflow_step, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(type, no, title, secret || "普通", urgency || "平件", ownerDept || req.user.dept_name,
      readers || "", buildReaderIds(readerIds), content || "",
      sourceUnit || "", mainSend || "", ccSend || "", sealNo || "", docDate || today(),
      originNo || "", issueDate || null, Number(copies) || 0,
      firstNode?.node_name || (type === "收文" ? "拟办" : "核稿"), firstNode?.id || null, approver?.id || null, req.user.id, workflow?.id || null, now(), now());
    writeApproval("document", result.lastInsertRowid, req.user, firstNode?.node_name || (type === "收文" ? "拟办" : "核稿"), type === "收文" ? "登记" : "拟稿", `${type}提交`, req.body.approvedAt);
    if (approver && approver.id !== req.user.id) notify(approver.id, `公文待办：${title}`, `${req.user.name} 提交${type}「${title}」`, "document", result.lastInsertRowid);
    writeOperationLog(req.user, "公文管理", `${type}提交`, "document", String(result.lastInsertRowid), title, clientIp(req));
    res.status(201).json(getDocumentById(result.lastInsertRowid));
  });

  app.get("/api/documents/:id", requireAuth, (req, res) => {
    const doc = getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ message: "公文不存在" });
    if (!canViewDocument(req.user, doc)) return res.status(403).json({ message: "无权限查看" });
    doc.approvals = db.prepare("SELECT * FROM approval_records WHERE business_type = 'document' AND business_id = ? ORDER BY id").all(doc.id);
    doc.receipts = db.prepare("SELECT * FROM document_receipts WHERE document_id = ? ORDER BY id").all(doc.id);
    // 解析每个节点「该找谁」：以起草人作为上下文，未到达节点也能预测办理人，便于在时间线上展示
    const drafter = getUserById(doc.created_by) || req.user;
    const fallback = getUserByAccount("admin");
    doc.workflow_nodes = (doc.workflow_id
      ? db.prepare("SELECT id, sort_order, node_name, node_type, node_kind, pos_x, pos_y, allow_terminal, approver_type, approver_value, approve_mode FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order, id").all(doc.workflow_id)
      : []).map((n) => {
        const approvers = wf.resolveApprovers(
          { approver_type: n.approver_type, approver_value: n.approver_value, approve_mode: n.approve_mode },
          drafter, fallback);
        return { ...n, expected_approver_name: approvers.map((u) => u.name).join("、") };
      });
    // 当前待办人姓名（会签/并行时列出全部待签人）
    const pendIds = String(doc.pending_approvers || "").split(",").map((s) => s.trim()).filter(Boolean);
    const curIds = pendIds.length ? pendIds : (doc.current_approver_id ? [String(doc.current_approver_id)] : []);
    doc.current_approver_name = curIds.map((id) => getUserById(id)).filter(Boolean).map((u) => u.name).join("、");
    doc.workflow_edges = doc.workflow_id
      ? db.prepare("SELECT id, from_node_id, to_node_id, label, condition_json FROM workflow_edges WHERE workflow_id = ? ORDER BY sort_order, id").all(doc.workflow_id)
      : [];
    doc.can_terminate = !!(doc.workflow_id && doc.current_node_id
      && db.prepare("SELECT 1 FROM workflow_edges WHERE workflow_id = ? AND from_node_id = ? AND to_node_id IS NULL").get(doc.workflow_id, doc.current_node_id));
    res.json(doc);
  });

  // 审批动作统一委托 services/approval：公文与申请共用同一引擎，补齐驳回/转办/加签/撤回。
  const da = approval.documentAdapter;
  const drun = (fn, req, res) => approval.respond(res, fn(da, req.params.id, req.user, req.body, clientIp(req)));
  app.post("/api/documents/:id/approve", requireAuth, requireRole("admin", "leader"), (req, res) => drun(approval.approve, req, res));
  app.post("/api/documents/:id/reject", requireAuth, requireRole("admin", "leader"), (req, res) => drun(approval.reject, req, res));
  app.post("/api/documents/:id/transfer", requireAuth, requireRole("admin", "leader"), (req, res) => drun(approval.transfer, req, res));
  app.post("/api/documents/:id/add-sign", requireAuth, requireRole("admin", "leader"), (req, res) => drun(approval.addSign, req, res));
  app.post("/api/documents/:id/withdraw", requireAuth, requireRole("admin", "leader"), (req, res) => drun(approval.withdraw, req, res));

  app.post("/api/documents/:id/distribute", requireAuth, requireRole("admin", "leader"), (req, res) => {
    const doc = getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ message: "公文不存在" });
    const ids = Array.isArray(req.body.readerIds) ? req.body.readerIds : [];
    const users = ids.map((id) => getUserById(id)).filter(Boolean);
    if (!users.length) return res.status(400).json({ message: "请选择分发对象" });
    const readers = users.map((u) => u.name).join("、");

    // 发文：分发必须在「分发」节点；分发完成后直接归档（清 token + status=approved）
    // 此处不走 approval.approve，避免「当前 token 审批人」校验阻断管理员或异部门 leader 的分发动作
    const isOutgoing = doc.type === "发文";
    if (isOutgoing) {
      if (doc.status !== "pending" || doc.current_node !== "分发") {
        return res.status(400).json({ message: "当前不在「分发」节点，无法发起分发" });
      }
      const summary = `分发至：${readers}${req.body.comment ? `（${req.body.comment}）` : ""}`;
      db.prepare("DELETE FROM workflow_active_nodes WHERE business_type = 'document' AND business_id = ?").run(doc.id);
      db.prepare(`UPDATE documents
        SET readers = ?, reader_ids = ?, status = 'approved', current_node = '归档',
            current_node_id = NULL, current_approver_id = NULL, pending_approvers = '', updated_at = ?
        WHERE id = ?`).run(readers, buildReaderIds(ids), now(), doc.id);
      writeApproval("document", doc.id, req.user, "分发", "同意", summary, req.body.approvedAt);
      users.forEach((u) => notify(u.id, `公文待阅：${doc.title}`, `${req.user.name} 向您分发${doc.type}「${doc.title}」`, "document", doc.id));
      if (doc.created_by && doc.created_by !== req.user.id) {
        notify(doc.created_by, `发文已归档：${doc.title}`, `${req.user.name} 完成分发，发文已归档`, "document", doc.id, "info");
      }
      writeOperationLog(req.user, "公文管理", "公文分发并归档", "document", String(doc.id), readers, clientIp(req));
      return res.json(getDocumentById(doc.id));
    }

    // 收文：保留旧行为——按指定人范围更新阅读列表，不影响审批节点
    const prevNode = doc.current_node;
    db.prepare("UPDATE documents SET readers = ?, reader_ids = ?, current_node = '分发阅读', updated_at = ? WHERE id = ?")
      .run(readers, buildReaderIds(ids), now(), doc.id);
    writeApproval("document", doc.id, req.user, prevNode, "分发", req.body.comment || readers, req.body.approvedAt);
    users.forEach((u) => notify(u.id, `公文待阅：${doc.title}`, `${req.user.name} 向您分发${doc.type}「${doc.title}」`, "document", doc.id));
    writeOperationLog(req.user, "公文管理", "公文分发", "document", String(doc.id), readers, clientIp(req));
    res.json(getDocumentById(doc.id));
  });

  app.post("/api/documents/:id/read", requireAuth, (req, res) => addReceipt(req, res, "阅读", req.body.comment || "已阅读"));
  app.post("/api/documents/:id/sign", requireAuth, (req, res) => addReceipt(req, res, "签收", req.body.comment || "已签收", req.body.signature));
  app.post("/api/documents/:id/feedback", requireAuth, (req, res) => addReceipt(req, res, "反馈", req.body.comment || ""));
  app.post("/api/documents/:id/print", requireAuth, (req, res) => addReceipt(req, res, "打印", req.body.comment || "打印公文"));
  // 用印登记：盖章/用印动作单独留痕，同时把章号写回主单 seal_no 字段，便于发文存档查看。
  app.post("/api/documents/:id/seal", requireAuth, requireRole("admin", "leader"), (req, res) => {
    const doc = getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ message: "公文不存在" });
    const sealNo = String(req.body.sealNo || "").trim();
    if (!sealNo) return res.status(400).json({ message: "请填写盖章/用印登记号" });
    const comment = `用印登记：${sealNo}${req.body.comment ? ` · ${req.body.comment}` : ""}`;
    db.prepare("UPDATE documents SET seal_no = ?, updated_at = ? WHERE id = ?").run(sealNo, now(), doc.id);
    db.prepare("INSERT INTO document_receipts (document_id, user_id, user_name, action, comment, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(doc.id, req.user.id, req.user.name, "用印", comment, "", now());
    notify(doc.created_by, `用印登记：${doc.title}`, `${req.user.name} 完成用印登记（${sealNo}）`, "document", doc.id, "info");
    writeOperationLog(req.user, "公文管理", "用印登记", "document", String(doc.id), comment, clientIp(req));
    res.json({ ok: true, seal_no: sealNo });
  });

  function addReceipt(req, res, action, comment, signature) {
    const doc = getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ message: "公文不存在" });
    if (!canViewDocument(req.user, doc)) return res.status(403).json({ message: "无权限操作" });
    db.prepare("INSERT INTO document_receipts (document_id, user_id, user_name, action, comment, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(doc.id, req.user.id, req.user.name, action, comment, signature || "", now());
    if (action === "反馈" && doc.created_by !== req.user.id) notify(doc.created_by, `公文反馈：${doc.title}`, `${req.user.name} 反馈：${comment}`, "document", doc.id, "info");
    writeOperationLog(req.user, "公文管理", `${action}公文`, "document", String(doc.id), comment || doc.title, clientIp(req));
    res.json({ ok: true });
  }
}

module.exports = { register };
