const bcrypt = require("bcryptjs");
const { db, now } = require("../db");

/* ---------------- 基础工具 ---------------- */

function today() {
  return now().slice(0, 10);
}

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password || "", hash || "");
}

function modulesForRole(roleCode) {
  return db.prepare(`
    SELECT m.code, m.name
    FROM role_modules rm
    JOIN roles r ON r.id = rm.role_id
    JOIN modules m ON m.id = rm.module_id
    WHERE r.code = ?
    ORDER BY m.sort_order
  `).all(roleCode);
}

function publicUser(user) {
  return {
    id: user.id,
    account: user.account,
    name: user.name,
    deptId: user.dept_id,
    dept: user.dept_name,
    roleCode: user.role_code,
    role: user.role_name,
    entryDate: user.entry_date || "",
    phone: user.phone || "",
  };
}

/* ---------------- 文案 ---------------- */

function moduleNameForRequest(type) {
  return { leave: "请假管理", trip: "出差管理", vehicle: "用车管理" }[type] || "业务申请";
}

function requestTypeText(type) {
  return { leave: "请假", trip: "出差", vehicle: "用车" }[type] || type;
}

function businessStatusText(status) {
  return { pending: "待审批", approved: "已通过", rejected: "已驳回", withdrawn: "已撤回", draft: "草稿" }[status] || status;
}

/* ---------------- 分页 ---------------- */

function pageParams(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 20)));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

module.exports = {
  now,
  today,
  clientIp,
  parseJson,
  hashPassword,
  verifyPassword,
  modulesForRole,
  publicUser,
  moduleNameForRequest,
  requestTypeText,
  businessStatusText,
  pageParams,
};
