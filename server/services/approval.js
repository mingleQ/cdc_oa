const { db, now } = require("../db");
const { parseJson, moduleNameForRequest, requestTypeText } = require("../core/util");
const { canApprove } = require("../core/auth");
const { writeOperationLog, writeApproval, notify } = require("../core/audit");
const { getUserById, getUserByAccount, getRequestById, getDocumentById, getInstanceById } = require("../repository");
const wf = require("./workflow");
const leaveBalance = require("./leave-balance");

/* ============================================================
 * 统一审批引擎（Phase 3）
 * 同意 / 驳回 / 加签 / 转办 / 撤回 + 意见留痕，全业务共用。
 * 通过「适配器」屏蔽 requests / documents 的列名差异；两表共享同一套
 * 工作流列（status / current_node / current_approver_id / workflow_step / updated_at）。
 * ============================================================ */

const ok = (item) => ({ item });
const fail = (code, message) => ({ code, message });

// 把服务层结果统一转成 HTTP 响应：失败 → {code,message}；成功 → item。
function respond(res, result) {
  if (result.message) return res.status(result.code).json({ message: result.message });
  return res.json(result.item);
}

// 申请类（请假/出差/用车）适配器
const requestAdapter = {
  table: "requests",
  businessType: "request",
  getById: getRequestById,
  creatorId: (row) => row.applicant_id,
  contextUserId: (row) => row.applicant_id,
  moduleName: (row) => moduleNameForRequest(row.type),
  noun: (row) => requestTypeText(row.type),
  title: (row) => row.reason,
  buildCtx: (row) => wf.buildContext(row, parseJson(row.fields_json, {})),
  fallbackApprover: () => getUserByAccount("leader"),
  rejectNode: "申请人修改",
  canWithdraw: (row, user) => row.applicant_id === user.id,
  withdrawDenyMsg: "只能撤回本人申请",
};

// 公文（收文/发文）适配器
const documentAdapter = {
  table: "documents",
  businessType: "document",
  getById: getDocumentById,
  creatorId: (row) => row.created_by,
  contextUserId: (row) => row.created_by,
  moduleName: () => "公文管理",
  noun: (row) => row.type,
  title: (row) => row.title,
  buildCtx: (row) => wf.buildContext(row, {}),
  fallbackApprover: () => getUserByAccount("admin"),
  rejectNode: "退回修改",
  canWithdraw: (row, user) => row.created_by === user.id,
  withdrawDenyMsg: "只能撤回本人创建的公文",
};

const parsePend = (s) => String(s || "").split(",").map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
const joinPend = (arr) => [...new Set(arr)].join(",");

// 自定义业务类型实例（统一 form_instances 引擎）适配器
const formInstanceAdapter = {
  table: "form_instances",
  businessType: "instance",
  getById: getInstanceById,
  creatorId: (row) => row.applicant_id,
  contextUserId: (row) => row.applicant_id,
  moduleName: (row) => row.type_name || row.business_type_code || "业务申请",
  noun: (row) => row.type_name || row.business_type_code || "申请",
  title: (row) => row.title || row.summary || "",
  buildCtx: (row) => { const d = parseJson(row.data_json, {}); return wf.buildContext({ category: d.category || "" }, d); },
  fallbackApprover: () => getUserByAccount("leader"),
  rejectNode: "申请人修改",
  canWithdraw: (row, user) => row.applicant_id === user.id,
  withdrawDenyMsg: "只能撤回本人申请",
};

// 仅改动共有工作流列；table 来自固定适配器（非用户输入），插值安全。
function setState(table, id, state) {
  db.prepare(`UPDATE ${table} SET status = ?, current_node = ?, current_node_id = ?, current_approver_id = ?, pending_approvers = ?, workflow_step = ?, updated_at = ? WHERE id = ?`)
    .run(state.status, state.current_node, state.current_node_id ?? null, state.current_approver_id ?? null, state.pending_approvers ?? "", state.workflow_step, now(), id);
}

/* ============ Token 引擎：支持并行扇出 + Join 合并 ============ */

function listTokens(adapter, businessId) {
  return db.prepare("SELECT * FROM workflow_active_nodes WHERE business_type = ? AND business_id = ? ORDER BY id")
    .all(adapter.businessType, businessId);
}
function clearTokens(adapter, businessId) {
  db.prepare("DELETE FROM workflow_active_nodes WHERE business_type = ? AND business_id = ?")
    .run(adapter.businessType, businessId);
}
// 旧数据无 token：按 row.current_node_id 补一条，保持引擎统一
function ensureTokensForLegacy(adapter, row) {
  if (!row.workflow_id || !row.current_node_id) return;
  const has = db.prepare("SELECT 1 FROM workflow_active_nodes WHERE business_type = ? AND business_id = ? LIMIT 1").get(adapter.businessType, row.id);
  if (has) return;
  const node = wf.getNodeById(row.workflow_id, row.current_node_id);
  if (!node) return;
  db.prepare(`INSERT INTO workflow_active_nodes (business_type, business_id, workflow_id, node_id, node_name, current_approver_id, pending_approvers, approve_mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    adapter.businessType, row.id, row.workflow_id, node.id, node.node_name,
    row.current_approver_id || null, row.pending_approvers || "", node.approve_mode || "single", now());
}

// 多 token 时把汇总信息回写到主表 current_* 字段，UI 列表仍可用
function syncRowFromTokens(adapter, businessId, step) {
  const tokens = listTokens(adapter, businessId);
  if (!tokens.length) return;
  if (tokens.length === 1) {
    const t = tokens[0];
    setState(adapter.table, businessId, {
      status: "pending", current_node: t.node_name, current_node_id: t.node_id,
      current_approver_id: t.current_approver_id, pending_approvers: t.pending_approvers,
      workflow_step: step || 1,
    });
    return;
  }
  // 并行：列出节点名 + 合并所有审批人，便于 mine 过滤 / 通知统计
  const names = tokens.map((t) => t.node_name).join(" / ");
  const all = [];
  tokens.forEach((t) => {
    if (t.current_approver_id) all.push(t.current_approver_id);
    parsePend(t.pending_approvers).forEach((x) => all.push(x));
  });
  const union = [...new Set(all)];
  setState(adapter.table, businessId, {
    status: "pending", current_node: `并行：${names}`, current_node_id: null,
    current_approver_id: union[0] || null, pending_approvers: union.join(","),
    workflow_step: step || 1,
  });
}

// 进入某节点：按审批模式解析审批人；如已有同节点 token 则合并（Join）
function enterNode(adapter, row, node, step) {
  const dup = db.prepare("SELECT id FROM workflow_active_nodes WHERE business_type = ? AND business_id = ? AND node_id = ?")
    .get(adapter.businessType, row.id, node.id);
  if (dup) { syncRowFromTokens(adapter, row.id, step); return []; }
  const mode = node.approve_mode || "single";
  const ctxUser = getUserById(adapter.contextUserId(row));
  const approvers = wf.resolveApprovers(node, ctxUser, adapter.fallbackApprover());
  const primary = approvers[0] || null;
  const pending = mode === "single" ? [] : approvers.map((u) => u.id);
  db.prepare(`INSERT INTO workflow_active_nodes (business_type, business_id, workflow_id, node_id, node_name, current_approver_id, pending_approvers, approve_mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    adapter.businessType, row.id, row.workflow_id, node.id, node.node_name,
    primary?.id || null, joinPend(pending), mode, now());
  syncRowFromTokens(adapter, row.id, step);
  const noun = adapter.noun(row);
  const label = mode === "countersign" ? "会签" : "审批";
  approvers.forEach((u) => notify(u.id, `${noun}待${label}`, `${ctxUser?.name || ""} 的${noun}流转至「${node.node_name}」：${adapter.title(row)}`, adapter.businessType, row.id));
  return approvers;
}

// 找到 actor 当前可处理的 token；多个 token 时按 actor 匹配
function findActorToken(adapter, businessId, actor) {
  const tokens = listTokens(adapter, businessId);
  return tokens.find((t) => t.current_approver_id === actor.id || parsePend(t.pending_approvers).includes(actor.id)) || null;
}

function isApprover(adapter, row, actor) {
  if (!canApprove(actor)) return false;
  if (row.current_approver_id === actor.id) return true;
  if (parsePend(row.pending_approvers).includes(actor.id)) return true;
  // 多 token 兜底
  ensureTokensForLegacy(adapter, row);
  return !!findActorToken(adapter, row.id, actor);
}

function archive(adapter, row, actor, body, ip) {
  clearTokens(adapter, row.id);
  setState(adapter.table, row.id, { status: "approved", current_node: "归档", current_node_id: null, current_approver_id: null, pending_approvers: "", workflow_step: row.workflow_step });
  const noun = adapter.noun(row);
  notify(adapter.creatorId(row), `${noun}已通过`, `${noun}「${adapter.title(row)}」已审批通过`, adapter.businessType, row.id, "info");
  writeOperationLog(actor, adapter.moduleName(row), "审批通过", adapter.businessType, String(row.id), body.comment || adapter.title(row), ip);
}

function approve(adapter, id, actor, body = {}, ip = "") {
  const row = adapter.getById(id);
  if (!row) return fail(404, "记录不存在");
  if (row.status !== "pending") return fail(400, "当前状态不能审批");
  ensureTokensForLegacy(adapter, row);
  const actorToken = findActorToken(adapter, row.id, actor);
  if (!canApprove(actor) || !actorToken) return fail(403, "无审批权限");

  writeApproval(adapter.businessType, row.id, actor, actorToken.node_name, "同意", body.comment || "", body.approvedAt);

  // 会签：本人通过后若仍有人未签，停留在当前节点等待其余人
  if (actorToken.approve_mode === "countersign") {
    const remaining = parsePend(actorToken.pending_approvers).filter((x) => x !== actor.id);
    if (remaining.length > 0) {
      db.prepare("UPDATE workflow_active_nodes SET current_approver_id = ?, pending_approvers = ? WHERE id = ?")
        .run(remaining[0], joinPend(remaining), actorToken.id);
      syncRowFromTokens(adapter, row.id);
      writeOperationLog(actor, adapter.moduleName(row), "会签同意", adapter.businessType, String(row.id), `剩余 ${remaining.length} 人待会签`, ip);
      return ok(adapter.getById(row.id));
    }
  }

  const ctx = adapter.buildCtx(row);
  // 主动「直接办结」：当前节点有终止边（to=NULL）
  if (body && body.terminate && wf.hasTerminalEdge(row.workflow_id, actorToken.node_id)) {
    archive(adapter, row, actor, body, ip);
    return ok(adapter.getById(row.id));
  }
  // DAG 路由：列出当前节点全部出边，按条件命中筛选；多条命中 = 并行扇出
  const edges = wf.getWorkflowEdges(row.workflow_id).filter((e) => e.from_node_id === actorToken.node_id);
  const matched = edges.filter((e) => wf.evalCondition(parseJson(e.condition_json, {}), ctx));
  // 删除 actor 的 token
  db.prepare("DELETE FROM workflow_active_nodes WHERE id = ?").run(actorToken.id);
  // 入边：跳过终止边 / end 节点
  const arrivedNames = [];
  for (const e of matched) {
    if (e.to_node_id == null) { arrivedNames.push("结束"); continue; }
    const target = wf.getNodeById(row.workflow_id, e.to_node_id);
    if (!target) continue;
    if (target.node_kind === "end" || wf.isArchiveNode(target)) { arrivedNames.push(target.node_name); continue; }
    enterNode(adapter, row, target);
    arrivedNames.push(target.node_name);
  }
  const left = listTokens(adapter, row.id);
  if (!left.length) {
    archive(adapter, row, actor, body, ip);
  } else {
    syncRowFromTokens(adapter, row.id);
    writeOperationLog(actor, adapter.moduleName(row), "审批流转", adapter.businessType, String(row.id),
      `${actorToken.node_name} → ${arrivedNames.join(" + ") || "（无）"}`, ip);
  }
  return ok(adapter.getById(row.id));
}

function reject(adapter, id, actor, body = {}, ip = "") {
  const row = adapter.getById(id);
  if (!row) return fail(404, "记录不存在");
  if (!isApprover(adapter, row, actor)) return fail(403, "无审批权限");
  if (row.status !== "pending") return fail(400, "当前状态不能审批");
  const actorToken = findActorToken(adapter, row.id, actor) || { node_name: row.current_node };
  writeApproval(adapter.businessType, row.id, actor, actorToken.node_name, "驳回", body.comment || "", body.approvedAt);
  clearTokens(adapter, row.id);
  setState(adapter.table, row.id, { status: "rejected", current_node: adapter.rejectNode, current_node_id: null, current_approver_id: null, pending_approvers: "", workflow_step: row.workflow_step });
  if (adapter.businessType === "request") leaveBalance.restoreForRequest(row, row.applicant_id);
  const noun = adapter.noun(row);
  notify(adapter.creatorId(row), `${noun}已驳回`, `${actor.name} 驳回了您的${noun}：${body.comment || adapter.title(row)}`, adapter.businessType, row.id, "info");
  writeOperationLog(actor, adapter.moduleName(row), "审批驳回", adapter.businessType, String(row.id), body.comment || adapter.title(row), ip);
  return ok(adapter.getById(row.id));
}

// 转办 / 加签：只把 actor 自己的 token 交给目标用户，其它并行 token 保持不变
function reassign(adapter, id, actor, body = {}, ip = "", kind) {
  const isSign = kind === "加签";
  const row = adapter.getById(id);
  const target = getUserById(body.targetUserId);
  if (!row) return fail(404, "记录不存在");
  if (!target || target.status !== "active") return fail(400, `${kind}人员不存在或不可用`);
  if (!isApprover(adapter, row, actor)) return fail(403, `无${kind}权限`);
  if (row.status !== "pending") return fail(400, `当前状态不能${kind}`);
  ensureTokensForLegacy(adapter, row);
  const actorToken = findActorToken(adapter, row.id, actor);
  if (!actorToken) return fail(403, `无${kind}权限`);
  writeApproval(adapter.businessType, row.id, actor, actorToken.node_name, kind, body.comment || `${kind}给 ${target.name}`, body.approvedAt);
  db.prepare("UPDATE workflow_active_nodes SET current_approver_id = ?, pending_approvers = '', node_name = ? WHERE id = ?")
    .run(target.id, `${actorToken.node_name}（${kind}）`, actorToken.id);
  syncRowFromTokens(adapter, row.id);
  const noun = adapter.noun(row);
  const verb = isSign ? "加签转给您审批" : "转办给您";
  notify(target.id, `${noun}待审批（${kind}）`, `${actor.name} 将${noun}${verb}：${adapter.title(row)}`, adapter.businessType, row.id);
  writeOperationLog(actor, adapter.moduleName(row), `审批${kind}`, adapter.businessType, String(row.id), `${adapter.title(row)} -> ${target.name}`, ip);
  return ok(adapter.getById(row.id));
}

const transfer = (adapter, id, actor, body, ip) => reassign(adapter, id, actor, body, ip, "转办");
const addSign = (adapter, id, actor, body, ip) => reassign(adapter, id, actor, body, ip, "加签");

function withdraw(adapter, id, actor, body = {}, ip = "") {
  const row = adapter.getById(id);
  if (!row) return fail(404, "记录不存在");
  if (!adapter.canWithdraw(row, actor)) return fail(403, adapter.withdrawDenyMsg);
  if (row.status !== "pending") return fail(400, "当前状态不能撤回");
  const prevApprover = row.current_approver_id;
  const prevNode = row.current_node;
  clearTokens(adapter, row.id);
  setState(adapter.table, row.id, { status: "withdrawn", current_node: "已撤回", current_node_id: null, current_approver_id: null, pending_approvers: "", workflow_step: row.workflow_step });
  if (adapter.businessType === "request") leaveBalance.restoreForRequest(row, row.applicant_id);
  writeApproval(adapter.businessType, row.id, actor, prevNode, "撤回", body.comment || "本人撤回", body.approvedAt);
  const noun = adapter.noun(row);
  if (prevApprover) notify(prevApprover, `${noun}已撤回`, `${actor.name} 撤回了${noun}：${adapter.title(row)}`, adapter.businessType, row.id, "info");
  writeOperationLog(actor, adapter.moduleName(row), "撤回", adapter.businessType, String(row.id), adapter.title(row), ip);
  return ok(adapter.getById(row.id));
}

module.exports = {
  requestAdapter,
  documentAdapter,
  formInstanceAdapter,
  respond,
  enterNode,
  approve,
  reject,
  transfer,
  addSign,
  withdraw,
};
