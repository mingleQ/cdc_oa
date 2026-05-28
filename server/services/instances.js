const { db, now } = require("../db");
const { parseJson } = require("../core/util");
const wf = require("./workflow");
const approval = require("./approval");
const forms = require("./forms");
const { getInstanceById } = require("../repository");

// 由表单数据推导标题，便于列表与通知展示。
function deriveTitle(schema, data, fallback) {
  const d = data || {};
  if (d.title) return String(d.title);
  const firstText = (schema || []).find((f) => ["text", "textarea"].includes(f.type) && d[f.key]);
  if (firstText) return String(d[firstText.key]).slice(0, 50);
  return fallback || "申请";
}

// 创建自定义业务类型实例并进入流程首节点（统一引擎）。
function createInstance(user, businessTypeCode, data) {
  const bt = forms.getBusinessType(businessTypeCode);
  if (!bt || bt.status !== "active") return { error: "业务类型不存在或已停用" };
  const form = forms.getEnabledForm(businessTypeCode);
  const schema = form ? form.schema : [];
  for (const f of schema) {
    if (f.required && !String((data || {})[f.key] ?? "").trim()) return { error: `「${f.label}」必填` };
  }
  const workflow = wf.getEnabledWorkflow(businessTypeCode);
  const title = deriveTitle(schema, data, bt.name);
  const id = db.prepare(`
    INSERT INTO form_instances (business_type_code, form_id, form_version, title, summary, applicant_id, dept_id, data_json, status, current_node, current_approver_id, pending_approvers, workflow_id, workflow_step, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', NULL, '', ?, 1, ?, ?)
  `).run(businessTypeCode, form?.id || null, form?.version || 1, title, title, user.id, user.dept_id, JSON.stringify(data || {}), workflow?.id || null, now(), now()).lastInsertRowid;

  if (workflow && workflow.nodes && workflow.nodes.length) {
    approval.enterNode(approval.formInstanceAdapter, getInstanceById(id), workflow.nodes[0], 1);
  } else {
    db.prepare("UPDATE form_instances SET status = 'approved', current_node = '归档', updated_at = ? WHERE id = ?").run(now(), id);
  }
  return { id };
}

module.exports = { createInstance, deriveTitle };
