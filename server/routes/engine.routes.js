const { db, now } = require("../db");
const { requireAuth, requireRole } = require("../core/auth");
const { clientIp, parseJson, pageParams } = require("../core/util");
const { writeOperationLog } = require("../core/audit");
const { requestVisibleWhere, canViewRequest } = require("../core/permissions");
const { getInstanceById } = require("../repository");
const approval = require("../services/approval");
const instances = require("../services/instances");
const {
  listBusinessTypes, getBusinessType, getEnabledForm, createBusinessType, updateBusinessType,
  listForms, validateSchema, createForm, enableForm,
} = require("../services/forms");

// 系统保留的菜单/视图编码，自定义业务类型不可占用。
const RESERVED_CODES = ["dashboard", "platform", "leave", "trip", "vehicle", "document", "stats", "logs", "instance", "request"];

// 统一「流程 + 表单」引擎接口（业务类型 / 表单设计器 / 自定义业务实例）。
function register(app) {
  /* ---------------- 业务类型 ---------------- */
  app.get("/api/business-types", requireAuth, (req, res) => {
    const includeDisabled = req.query.all === "1" && req.user.role_code === "admin";
    res.json({ items: listBusinessTypes({ includeDisabled }) });
  });

  app.get("/api/business-types/:code/form", requireAuth, (req, res) => {
    const type = getBusinessType(req.params.code);
    if (!type) return res.status(404).json({ message: "业务类型不存在" });
    const form = getEnabledForm(req.params.code);
    if (!form) return res.status(404).json({ message: "该业务类型暂无启用表单" });
    res.json({ businessType: type, form });
  });

  app.post("/api/business-types", requireAuth, requireRole("admin"), (req, res) => {
    const { code, name, icon, category } = req.body;
    if (!code || !/^[a-z][a-z0-9_]*$/.test(code)) return res.status(400).json({ message: "类型标识不合法（小写字母开头，仅含小写字母/数字/下划线）" });
    if (RESERVED_CODES.includes(code)) return res.status(400).json({ message: "该标识为系统保留，请换一个" });
    if (!name || !String(name).trim()) return res.status(400).json({ message: "类型名称必填" });
    if (getBusinessType(code) || db.prepare("SELECT 1 FROM modules WHERE code = ?").get(code)) return res.status(400).json({ message: "标识已被占用" });
    createBusinessType({ code, name: String(name).trim(), icon, category: category === "document" ? "document" : "request" });
    writeOperationLog(req.user, "基础平台", "新增业务类型", "business_type", code, name, clientIp(req));
    res.status(201).json({ ok: true, code });
  });

  app.put("/api/business-types/:code", requireAuth, requireRole("admin"), (req, res) => {
    const updated = updateBusinessType(req.params.code, req.body || {});
    if (!updated) return res.status(404).json({ message: "业务类型不存在" });
    writeOperationLog(req.user, "基础平台", "编辑业务类型", "business_type", req.params.code, updated.name, clientIp(req));
    res.json({ ok: true });
  });

  /* ---------------- 表单设计器（管理员） ---------------- */
  app.get("/api/forms", requireAuth, requireRole("admin"), (req, res) => {
    const bt = req.query.businessType;
    if (!bt) return res.status(400).json({ message: "缺少 businessType 参数" });
    res.json({ items: listForms(bt) });
  });

  app.post("/api/forms", requireAuth, requireRole("admin"), (req, res) => {
    const { businessType, name, schema } = req.body;
    if (!businessType || !getBusinessType(businessType)) return res.status(400).json({ message: "业务类型不存在" });
    if (!name || !String(name).trim()) return res.status(400).json({ message: "表单名称必填" });
    const v = validateSchema(schema);
    if (v.error) return res.status(400).json({ message: v.error });
    const created = createForm(businessType, String(name).trim(), v.schema);
    writeOperationLog(req.user, "基础平台", "保存表单配置", "form", String(created.id), `${businessType} v${created.version} ${name}`, clientIp(req));
    res.status(201).json({ id: created.id, version: created.version });
  });

  app.post("/api/forms/:id/enable", requireAuth, requireRole("admin"), (req, res) => {
    const form = enableForm(req.params.id);
    if (!form) return res.status(404).json({ message: "表单不存在" });
    writeOperationLog(req.user, "基础平台", "启用表单版本", "form", String(form.id), `${form.business_type_code} v${form.version}`, clientIp(req));
    res.json({ ok: true });
  });

  /* ---------------- 自定义业务类型实例（统一引擎） ---------------- */
  app.get("/api/instances", requireAuth, (req, res) => {
    const code = req.query.businessType;
    if (!code) return res.status(400).json({ message: "缺少 businessType 参数" });
    const visible = requestVisibleWhere(req.user, "fi");
    const params = [code, ...visible.params];
    let where = `WHERE fi.business_type_code = ? AND ${visible.sql}`;
    if (req.query.status) { where += " AND fi.status = ?"; params.push(req.query.status); }
    if (req.query.keyword) { where += " AND fi.title LIKE ?"; params.push(`%${req.query.keyword}%`); }
    if (req.query.mine === "1") {
      where += " AND (fi.current_approver_id = ? OR (',' || fi.pending_approvers || ',') LIKE ?)";
      params.push(req.user.id, `%,${req.user.id},%`);
    }
    const joins = "FROM form_instances fi JOIN users u ON u.id = fi.applicant_id JOIN departments d ON d.id = fi.dept_id LEFT JOIN users a ON a.id = fi.current_approver_id";
    const total = db.prepare(`SELECT COUNT(*) AS c ${joins} ${where}`).get(...params).c;
    const { page, pageSize, limit, offset } = pageParams(req);
    const items = db.prepare(`SELECT fi.*, d.name AS dept_name, u.name AS applicant_name, a.name AS approver_name ${joins} ${where} ORDER BY fi.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ items, total, page, pageSize });
  });

  app.post("/api/instances", requireAuth, (req, res) => {
    const { businessType, data } = req.body;
    const r = instances.createInstance(req.user, businessType, data || {});
    if (r.error) return res.status(400).json({ message: r.error });
    writeOperationLog(req.user, getBusinessType(businessType)?.name || "业务申请", "提交申请", "instance", String(r.id), getInstanceById(r.id).title, clientIp(req));
    res.status(201).json(getInstanceById(r.id));
  });

  app.get("/api/instances/:id", requireAuth, (req, res) => {
    const inst = getInstanceById(req.params.id);
    if (!inst) return res.status(404).json({ message: "申请不存在" });
    if (!canViewRequest(req.user, inst)) return res.status(403).json({ message: "无权限查看" });
    inst.data = parseJson(inst.data_json, {});
    inst.approvals = db.prepare("SELECT * FROM approval_records WHERE business_type = 'instance' AND business_id = ? ORDER BY id").all(inst.id);
    const form = getEnabledForm(inst.business_type_code);
    inst.schema = form ? form.schema : [];
    res.json(inst);
  });

  const ia = approval.formInstanceAdapter;
  const irun = (fn, req, res) => approval.respond(res, fn(ia, req.params.id, req.user, req.body, clientIp(req)));
  app.post("/api/instances/:id/approve", requireAuth, (req, res) => irun(approval.approve, req, res));
  app.post("/api/instances/:id/reject", requireAuth, (req, res) => irun(approval.reject, req, res));
  app.post("/api/instances/:id/transfer", requireAuth, (req, res) => irun(approval.transfer, req, res));
  app.post("/api/instances/:id/add-sign", requireAuth, (req, res) => irun(approval.addSign, req, res));
  app.post("/api/instances/:id/withdraw", requireAuth, (req, res) => irun(approval.withdraw, req, res));
}

module.exports = { register };
