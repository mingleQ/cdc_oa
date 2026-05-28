const { db } = require("../db");
const { getRequestById, getDocumentById, getInstanceById } = require("../repository");

/* ---------------- 可配置数据权限（Phase 5） ----------------
 * 数据范围 data_scope：
 *   all      —— 全部数据
 *   dept_sub —— 本部门及其所有下级部门
 *   dept     —— 仅本部门
 *   self     —— 仅本人
 * 角色未配置时按内置三角色回退（admin=all / leader=dept_sub / user=self）。
 */

function scopeOf(user) {
  if (user.data_scope) return user.data_scope;
  if (user.role_code === "admin") return "all";
  if (user.role_code === "leader") return "dept_sub";
  return "self";
}

// 计算某部门的自身 + 所有下级部门 id（含自身）。
function descendantDeptIds(deptId) {
  const all = db.prepare("SELECT id, parent_id FROM departments").all();
  const children = {};
  all.forEach((d) => { (children[d.parent_id || 0] = children[d.parent_id || 0] || []).push(d.id); });
  const out = []; const stack = [deptId];
  while (stack.length) { const id = stack.pop(); out.push(id); (children[id] || []).forEach((c) => stack.push(c)); }
  return out;
}

function deptNamesForScope(user, scope) {
  const ids = scope === "dept_sub" ? descendantDeptIds(user.dept_id) : [user.dept_id];
  const ph = ids.map(() => "?").join(",");
  return db.prepare(`SELECT name FROM departments WHERE id IN (${ph})`).all(...ids).map((d) => d.name);
}

const parsePend = (s) => String(s || "").split(",").map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);

/* ---------------- 业务申请可见范围 ---------------- */

function requestVisibleWhere(user, alias = "r") {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  const scope = scopeOf(user);
  if (scope === "all") return { sql: "1=1", params: [] };
  if (scope === "self") return { sql: `${col("applicant_id")} = ?`, params: [user.id] };
  const deptIds = scope === "dept_sub" ? descendantDeptIds(user.dept_id) : [user.dept_id];
  const ph = deptIds.map(() => "?").join(",");
  return {
    sql: `(${col("dept_id")} IN (${ph}) OR ${col("applicant_id")} = ? OR ${col("current_approver_id")} = ?)`,
    params: [...deptIds, user.id, user.id],
  };
}

// 公文无 dept_id（仅 owner_dept 文本），按创建/审批/读者 + 部门范围名称匹配。
function documentVisibleWhere(user) {
  const scope = scopeOf(user);
  if (scope === "all") return { sql: "1=1", params: [] };
  const base = "(created_by = ? OR current_approver_id = ? OR reader_ids LIKE ?)";
  const baseParams = [user.id, user.id, `%,${user.id},%`];
  if (scope === "self") return { sql: base, params: baseParams };
  const names = deptNamesForScope(user, scope);
  if (!names.length) return { sql: base, params: baseParams };
  const ph = names.map(() => "?").join(",");
  return { sql: `(${base} OR owner_dept IN (${ph}))`, params: [...baseParams, ...names] };
}

function canViewRequest(user, request) {
  const scope = scopeOf(user);
  if (scope === "all") return true;
  if (request.applicant_id === user.id || request.current_approver_id === user.id) return true;
  if (parsePend(request.pending_approvers).includes(user.id)) return true;
  if (scope === "self") return false;
  const deptIds = scope === "dept_sub" ? descendantDeptIds(user.dept_id) : [user.dept_id];
  return deptIds.includes(request.dept_id);
}

function canViewDocument(user, doc) {
  const scope = scopeOf(user);
  if (scope === "all") return true;
  if (doc.created_by === user.id || doc.current_approver_id === user.id) return true;
  if (parsePend(doc.pending_approvers).includes(user.id)) return true;
  if (String(doc.reader_ids || "").includes(`,${user.id},`)) return true;
  if (scope === "self") return false;
  return deptNamesForScope(user, scope).includes(doc.owner_dept);
}

function canAccessBusiness(user, businessType, businessId) {
  if (businessType === "request") {
    const request = getRequestById(businessId);
    return !!request && canViewRequest(user, request);
  }
  if (businessType === "document") {
    const doc = getDocumentById(businessId);
    return !!doc && canViewDocument(user, doc);
  }
  if (businessType === "instance") {
    const inst = getInstanceById(businessId);
    return !!inst && canViewRequest(user, inst);
  }
  return false;
}

function buildReaderIds(ids) {
  const clean = (Array.isArray(ids) ? ids : []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  return clean.length ? `,${[...new Set(clean)].join(",")},` : "";
}

module.exports = {
  scopeOf,
  descendantDeptIds,
  requestVisibleWhere,
  documentVisibleWhere,
  canViewRequest,
  canViewDocument,
  canAccessBusiness,
  buildReaderIds,
};
