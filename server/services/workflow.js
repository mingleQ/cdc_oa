const { db } = require("../db");
const { parseJson } = require("../core/util");
const { getUserById } = require("../repository");

function getEnabledWorkflow(businessType) {
  const workflow = db.prepare(
    "SELECT * FROM workflow_definitions WHERE business_type = ? AND enabled = 1 ORDER BY version DESC LIMIT 1",
  ).get(businessType);
  if (!workflow) return null;
  workflow.nodes = db.prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order, id").all(workflow.id);
  return workflow;
}

function getWorkflowNodes(workflowId) {
  if (!workflowId) return [];
  return db.prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order, id").all(workflowId);
}

// 解析节点对应的实际审批人
function resolveApprover(node, contextUser, fallbackUser) {
  if (!node) return fallbackUser || null;
  if (node.approver_type === "user") {
    return getUserById(node.approver_value) || fallbackUser || null;
  }
  if (node.approver_type === "dept_leader") {
    if (contextUser?.dept_id) {
      const deptLeader = db.prepare(`
        SELECT u.*, d.name AS dept_name, r.code AS role_code, r.name AS role_name
        FROM users u JOIN departments d ON d.id = u.dept_id JOIN roles r ON r.id = u.role_id
        WHERE r.code = 'leader' AND u.dept_id = ? AND u.status = 'active' ORDER BY u.id LIMIT 1
      `).get(contextUser.dept_id);
      if (deptLeader) return deptLeader;
    }
    return findFirstByRole("leader") || fallbackUser || null;
  }
  if (node.approver_type === "role") {
    if (contextUser?.dept_id) {
      const deptApprover = db.prepare(`
        SELECT u.*, d.name AS dept_name, r.code AS role_code, r.name AS role_name
        FROM users u JOIN departments d ON d.id = u.dept_id JOIN roles r ON r.id = u.role_id
        WHERE r.code = ? AND u.dept_id = ? AND u.status = 'active' ORDER BY u.id LIMIT 1
      `).get(node.approver_value, contextUser.dept_id);
      if (deptApprover) return deptApprover;
    }
    return findFirstByRole(node.approver_value) || fallbackUser || null;
  }
  return fallbackUser || null;
}

function findFirstByRole(roleCode) {
  return db.prepare(`
    SELECT u.*, d.name AS dept_name, r.code AS role_code, r.name AS role_name
    FROM users u JOIN departments d ON d.id = u.dept_id JOIN roles r ON r.id = u.role_id
    WHERE r.code = ? AND u.status = 'active' ORDER BY u.id LIMIT 1
  `).get(roleCode);
}

// 计算分支条件上下文（天数、类别、金额等）
function buildContext(item, fields) {
  const ctx = { category: item.category || "", type: item.type || "" };
  if (item.start_date && item.end_date) {
    const start = new Date(item.start_date);
    const end = new Date(item.end_date);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
      if (dateOnly.test(String(item.start_date)) && dateOnly.test(String(item.end_date))) {
        ctx.days = Math.floor((end - start) / 86400000) + 1;
      } else {
        const hours = Math.max(0, (end - start) / 3600000);
        ctx.days = Math.max(0.5, Math.round((hours / 8) * 2) / 2);
      }
    }
  }
  const data = fields || {};
  Object.keys(data).forEach((key) => {
    if (ctx[key] === undefined) ctx[key] = data[key];
  });
  return ctx;
}

function evalCondition(condition, ctx) {
  if (!condition || !condition.field || condition.op === undefined) return true;
  const left = ctx[condition.field];
  const right = condition.value;
  const ln = Number(left);
  const rn = Number(right);
  const numeric = !Number.isNaN(ln) && !Number.isNaN(rn);
  const a = numeric ? ln : String(left ?? "");
  const b = numeric ? rn : String(right ?? "");
  switch (condition.op) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    case "==": return a === b;
    case "!=": return a !== b;
    default: return true;
  }
}

// 从 fromStep（1 基，当前节点序号）之后查找第一个满足条件的节点
function nextApprovableNode(workflowId, fromStep, ctx) {
  const nodes = getWorkflowNodes(workflowId);
  for (let i = Number(fromStep || 1); i < nodes.length; i += 1) {
    const node = nodes[i];
    const cond = parseJson(node.condition_json, {});
    if (evalCondition(cond, ctx)) return { ...node, step: i + 1 };
  }
  return null;
}

function isArchiveNode(node) {
  return !!node && /归档|办结/.test(node.node_name || "");
}

/* ============ DAG 路由（按边） ============ */

function getWorkflowEdges(workflowId) {
  if (!workflowId) return [];
  return db.prepare("SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY sort_order, id").all(workflowId);
}

// 找到第一条「指向真正下游节点（非结束/非归档）」、且条件满足的出边。
// 返回 { nextNode, step } 或 null；null 表示应当归档。
function routeFromNode(workflowId, fromNodeId, ctx) {
  if (!workflowId || !fromNodeId) return null;
  const edges = getWorkflowEdges(workflowId).filter((e) => e.from_node_id === fromNodeId);
  if (!edges.length) return null;
  const nodes = getWorkflowNodes(workflowId);
  // 优先选「条件命中 + 非终止边」；都不满足时再检查「无条件终止边」
  for (const e of edges) {
    if (e.to_node_id == null) continue; // 终止边稍后处理
    const cond = parseJson(e.condition_json, {});
    if (!evalCondition(cond, ctx)) continue;
    const idx = nodes.findIndex((n) => n.id === e.to_node_id);
    if (idx < 0) continue;
    const target = nodes[idx];
    if (isArchiveNode(target) || target.node_kind === "end") return null;
    return { nextNode: target, step: idx + 1 };
  }
  // 没有可用的非终止边 → 归档
  return null;
}

// 同节点是否存在「直达结束」的出边（用于办理界面给出"直接办结"按钮）
function hasTerminalEdge(workflowId, fromNodeId) {
  if (!workflowId || !fromNodeId) return false;
  const edges = getWorkflowEdges(workflowId).filter((e) => e.from_node_id === fromNodeId);
  return edges.some((e) => e.to_node_id == null);
}

function getNodeById(workflowId, nodeId) {
  if (!nodeId) return null;
  return db.prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? AND id = ?").get(workflowId, nodeId) || null;
}

// 解析节点的全部审批人：approver_value 支持逗号分隔的多角色/多用户（用于并行/会签）。
function resolveApprovers(node, contextUser, fallback) {
  if (!node) return fallback ? [fallback] : [];
  const vals = String(node.approver_value || "").split(",").map((s) => s.trim()).filter(Boolean);
  let users = [];
  if (node.approver_type === "dept_leader" || vals.length <= 1) {
    const u = resolveApprover(node, contextUser, null);
    if (u) users = [u];
  } else {
    vals.forEach((v) => {
      const u = resolveApprover({ ...node, approver_value: v }, contextUser, null);
      if (u) users.push(u);
    });
  }
  const seen = new Set();
  users = users.filter((u) => u && !seen.has(u.id) && seen.add(u.id));
  if (!users.length && fallback) users = [fallback];
  return users;
}

// 取工作流的第 step 个节点（1 基），用于读取当前节点的审批模式等。
function getNodeByStep(workflowId, step) {
  const nodes = getWorkflowNodes(workflowId);
  return nodes[Number(step || 1) - 1] || null;
}

module.exports = {
  getEnabledWorkflow,
  getWorkflowNodes,
  getWorkflowEdges,
  getNodeById,
  resolveApprover,
  resolveApprovers,
  getNodeByStep,
  buildContext,
  evalCondition,
  nextApprovableNode,
  routeFromNode,
  hasTerminalEdge,
  isArchiveNode,
};
