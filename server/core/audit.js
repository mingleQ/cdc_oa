const { db, now } = require("../db");

/* ---------------- 日志与审批留痕 ---------------- */

function writeOperationLog(user, moduleName, action, objectType, objectId, content, ip) {
  db.prepare(`
    INSERT INTO operation_logs (operator_id, operator_name, module_name, action, object_type, object_id, content, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user?.id || null, user?.name || "系统", moduleName, action, objectType, objectId, content, ip || "", now());
}

// node_name 是审批发生时所在的流程节点（如「部门负责人审批」），用于前端按节点拼出链路状态；
// action 是该节点上做的动作（同意/驳回/转办/加签/撤回/登记/拟稿/分发）。两者必须分开传，不能再共用一个参数。
function writeApproval(businessType, businessId, user, nodeName, action, comment, approvedAt) {
  const time = approvedAt || now();
  db.prepare(`
    INSERT INTO approval_records (business_type, business_id, node_name, approver_id, approver_name, action, comment, approved_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(businessType, businessId, nodeName || action, user.id, user.name, action, comment || "", time, now());
}

/* ---------------- 站内消息通知 ---------------- */

function notify(userId, title, content, businessType, businessId, category = "todo") {
  if (!userId) return;
  db.prepare(`
    INSERT INTO notifications (user_id, title, content, category, business_type, business_id, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(userId, title, content || "", category, businessType || "", businessId || null, now());
}

module.exports = {
  writeOperationLog,
  writeApproval,
  notify,
};
