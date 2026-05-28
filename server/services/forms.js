const { db, now } = require("../db");
const { parseJson } = require("../core/util");

const FIELD_TYPES = ["text", "textarea", "select", "date", "datetime", "number"];
const STANDARD_KEYS = ["category", "startDate", "endDate", "reason"];

// 列出业务类型（默认仅启用），按 sort_order 排序。
function listBusinessTypes({ includeDisabled = false } = {}) {
  const where = includeDisabled ? "" : "WHERE status = 'active'";
  return db.prepare(`SELECT * FROM business_types ${where} ORDER BY sort_order, id`).all();
}

function getBusinessType(code) {
  return db.prepare("SELECT * FROM business_types WHERE code = ?").get(code) || null;
}

// 取某业务类型当前启用的表单定义（最高版本），schema_json 解析为数组。
function getEnabledForm(businessTypeCode) {
  const form = db.prepare(`
    SELECT * FROM form_definitions
    WHERE business_type_code = ? AND enabled = 1
    ORDER BY version DESC LIMIT 1
  `).get(businessTypeCode);
  if (!form) return null;
  form.schema = parseJson(form.schema_json, []);
  return form;
}

// 列出某业务类型的所有表单版本（含已停用），schema 解析为数组。
function listForms(businessTypeCode) {
  return db.prepare("SELECT * FROM form_definitions WHERE business_type_code = ? ORDER BY version DESC, id DESC")
    .all(businessTypeCode)
    .map((f) => ({ ...f, schema: parseJson(f.schema_json, []) }));
}

// 校验并规整字段 schema：标识合法且唯一、类型受限、下拉需选项。
function validateSchema(schema) {
  if (!Array.isArray(schema) || schema.length === 0) return { error: "至少配置一个字段" };
  const keys = new Set();
  const out = [];
  for (const f of schema) {
    const key = String(f.key || "").trim();
    const label = String(f.label || "").trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) return { error: `字段标识不合法：「${f.key}」（须字母开头，仅含字母/数字/下划线）` };
    if (keys.has(key)) return { error: `字段标识重复：${key}` };
    keys.add(key);
    if (!label) return { error: `字段「${key}」缺少名称` };
    const type = FIELD_TYPES.includes(f.type) ? f.type : "text";
    const field = { key, label, type, required: !!f.required };
    if (type === "select") {
      const options = (Array.isArray(f.options) ? f.options : []).map((o) => String(o).trim()).filter(Boolean);
      if (!options.length) return { error: `下拉字段「${label}」需至少一个选项` };
      field.options = options;
    }
    out.push(field);
  }
  return { schema: out };
}

// 新建表单版本：停用同业务类型旧版本，启用新版本（与流程版本策略一致）。
function createForm(businessTypeCode, name, schema) {
  const version = (db.prepare("SELECT MAX(version) AS v FROM form_definitions WHERE business_type_code = ?").get(businessTypeCode).v || 0) + 1;
  return db.transaction(() => {
    db.prepare("UPDATE form_definitions SET enabled = 0 WHERE business_type_code = ?").run(businessTypeCode);
    const result = db.prepare("INSERT INTO form_definitions (business_type_code, name, version, enabled, schema_json, created_at) VALUES (?, ?, ?, 1, ?, ?)")
      .run(businessTypeCode, name, version, JSON.stringify(schema), now());
    return { id: result.lastInsertRowid, version };
  })();
}

function enableForm(id) {
  const form = db.prepare("SELECT * FROM form_definitions WHERE id = ?").get(id);
  if (!form) return null;
  db.transaction(() => {
    db.prepare("UPDATE form_definitions SET enabled = 0 WHERE business_type_code = ?").run(form.business_type_code);
    db.prepare("UPDATE form_definitions SET enabled = 1 WHERE id = ?").run(id);
  })();
  return form;
}

// 创建自定义业务类型：业务类型 + 菜单模块 + 授予管理员 + 默认表单 + 默认流程，一次到位。
function createBusinessType({ code, name, icon, category }) {
  const sort = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM business_types").get().m) + 1;
  return db.transaction(() => {
    db.prepare("INSERT INTO business_types (code, name, icon, module_code, category, is_preset, status, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)")
      .run(code, name, icon || "·", code, category || "request", sort, now());
    const mSort = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM modules").get().m) + 1;
    db.prepare("INSERT INTO modules (code, name, sort_order) VALUES (?, ?, ?)").run(code, name, mSort);
    const mod = db.prepare("SELECT id FROM modules WHERE code = ?").get(code);
    // 默认对所有角色开放该业务菜单（管理员之后可在「角色菜单权限」中收紧）。
    if (mod) db.prepare("SELECT id FROM roles").all().forEach((r) => db.prepare("INSERT OR IGNORE INTO role_modules (role_id, module_id) VALUES (?, ?)").run(r.id, mod.id));
    db.prepare("INSERT INTO form_definitions (business_type_code, name, version, enabled, schema_json, created_at) VALUES (?, ?, 1, 1, ?, ?)")
      .run(code, `${name}默认表单`, JSON.stringify([
        { key: "title", label: "标题", type: "text", required: true },
        { key: "reason", label: "说明", type: "textarea", required: true },
      ]), now());
    const wfId = db.prepare("INSERT INTO workflow_definitions (business_type, name, version, enabled, created_at) VALUES (?, ?, 1, 1, ?)")
      .run(code, `${name}默认流程`, now()).lastInsertRowid;
    const insN = db.prepare("INSERT INTO workflow_nodes (workflow_id, node_name, approver_type, approver_value, condition_json, approve_mode, sort_order, allow_terminal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const n1 = insN.run(wfId, "部门负责人审批", "dept_leader", "", "{}", "single", 1, 0).lastInsertRowid;
    const n2 = insN.run(wfId, "归档", "role", "admin", "{}", "single", 2, 1).lastInsertRowid;
    const insE = db.prepare("INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, label, condition_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
    insE.run(wfId, n1, n2, "", "{}", 0);
    insE.run(wfId, n2, null, "", "{}", 0);
    return true;
  })();
}

function updateBusinessType(code, { name, icon, status }) {
  const bt = getBusinessType(code);
  if (!bt) return null;
  db.prepare("UPDATE business_types SET name = ?, icon = ?, status = ? WHERE code = ?")
    .run(name || bt.name, icon || bt.icon, status || bt.status, code);
  if (name) db.prepare("UPDATE modules SET name = ? WHERE code = ?").run(name, code);
  return getBusinessType(code);
}

module.exports = {
  STANDARD_KEYS,
  listBusinessTypes,
  getBusinessType,
  createBusinessType,
  updateBusinessType,
  getEnabledForm,
  listForms,
  validateSchema,
  createForm,
  enableForm,
};
