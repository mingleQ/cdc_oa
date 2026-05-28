const { db } = require("./db");

/* ---------------- 查询助手 ---------------- */

function getUserByAccount(account) {
  return db.prepare(`
    SELECT u.*, d.name AS dept_name, r.code AS role_code, r.name AS role_name, r.data_scope, r.can_approve
    FROM users u
    JOIN departments d ON d.id = u.dept_id
    JOIN roles r ON r.id = u.role_id
    WHERE u.account = ?
  `).get(account);
}

function getUserById(id) {
  return db.prepare(`
    SELECT u.*, d.name AS dept_name, r.code AS role_code, r.name AS role_name, r.data_scope, r.can_approve
    FROM users u
    JOIN departments d ON d.id = u.dept_id
    JOIN roles r ON r.id = u.role_id
    WHERE u.id = ?
  `).get(id);
}

function getRoleById(id) {
  return db.prepare("SELECT * FROM roles WHERE id = ?").get(id);
}

function getDepartmentById(id) {
  return db.prepare("SELECT * FROM departments WHERE id = ?").get(id);
}

function getRequestById(id) {
  return db.prepare(`
    SELECT r.*, d.name AS dept_name, u.name AS applicant_name, a.name AS approver_name
    FROM requests r
    JOIN departments d ON d.id = r.dept_id
    JOIN users u ON u.id = r.applicant_id
    LEFT JOIN users a ON a.id = r.current_approver_id
    WHERE r.id = ?
  `).get(id);
}

function getDocumentById(id) {
  return db.prepare(`
    SELECT doc.*, u.name AS creator_name, a.name AS approver_name
    FROM documents doc
    JOIN users u ON u.id = doc.created_by
    LEFT JOIN users a ON a.id = doc.current_approver_id
    WHERE doc.id = ?
  `).get(id);
}

function getInstanceById(id) {
  return db.prepare(`
    SELECT fi.*, d.name AS dept_name, u.name AS applicant_name, a.name AS approver_name, bt.name AS type_name, bt.module_code
    FROM form_instances fi
    JOIN users u ON u.id = fi.applicant_id
    JOIN departments d ON d.id = fi.dept_id
    LEFT JOIN users a ON a.id = fi.current_approver_id
    LEFT JOIN business_types bt ON bt.code = fi.business_type_code
    WHERE fi.id = ?
  `).get(id);
}

module.exports = {
  getUserByAccount,
  getUserById,
  getRoleById,
  getDepartmentById,
  getRequestById,
  getDocumentById,
  getInstanceById,
};
