const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

const DB = path.join(os.tmpdir(), `oa-test-${process.pid}.sqlite`);
const PORT = 4100 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.OA_DB_PATH = DB;
process.env.PORT = String(PORT);
process.env.NODE_ENV = "test";
process.env.OA_LOGIN_MAX_FAILS = "3";

require("../server/server.js");

const headers = (t) => ({ "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) });
const post = async (p, body, t) => fetch(BASE + p, { method: "POST", headers: headers(t), body: JSON.stringify(body || {}) });
const get = async (p, t) => fetch(BASE + p, { headers: headers(t) });

let adminT; let leaderT; let userT;

test("服务启动", async () => {
  await new Promise((r) => setTimeout(r, 600));
  const res = await get("/api/health");
  assert.equal(res.status, 200);
});

test("三类角色登录", async () => {
  adminT = (await (await post("/api/auth/login", { account: "admin", password: "123456" })).json()).token;
  leaderT = (await (await post("/api/auth/login", { account: "leader", password: "123456" })).json()).token;
  const ulogin = await (await post("/api/auth/login", { account: "user", password: "123456" })).json();
  userT = ulogin.token;
  assert.ok(adminT && leaderT && userT);
  assert.ok(!ulogin.modules.some((m) => m.code === "logs"), "普通职工不应有操作日志菜单");
});

test("错误密码 + 登录锁定", async () => {
  for (let i = 0; i < 3; i += 1) await post("/api/auth/login", { account: "lockme", password: "x" });
  const res = await post("/api/auth/login", { account: "lockme", password: "x" });
  assert.equal(res.status, 429, "应触发账号锁定");
});

test("普通职工无权访问管理接口", async () => {
  assert.equal((await get("/api/users", userT)).status, 403);
  assert.equal((await get("/api/logs/operations", userT)).status, 403);
});

test("请假多节点流程 + 分支条件 + 通知", async () => {
  const req = await (await post("/api/requests", { type: "leave", category: "病假", startDate: "2026-06-01", endDate: "2026-06-04", reason: "测试4天" }, userT)).json();
  assert.equal(req.current_node, "部门负责人审批");
  const a1 = await (await post(`/api/requests/${req.id}/approve`, { comment: "同意", approvedAt: "2026-06-01T01:00:00.000Z" }, leaderT)).json();
  assert.equal(a1.current_node, "分管领导审批");
  assert.equal(a1.status, "pending");
  const a2 = await (await post(`/api/requests/${req.id}/approve`, { comment: "准假" }, adminT)).json();
  assert.equal(a2.status, "approved");
  const noti = await (await get("/api/notifications", userT)).json();
  assert.ok(noti.unread >= 1, "申请人应收到通过通知");
  assert.equal((await (await get("/api/requests/" + req.id, userT)).json()).approvals.length, 2);
});

test("短假不触发分支，部门负责人直接归档", async () => {
  const req = await (await post("/api/requests", { type: "leave", category: "事假", startDate: "2026-06-10", endDate: "2026-06-10", reason: "1天" }, userT)).json();
  const a1 = await (await post(`/api/requests/${req.id}/approve`, {}, leaderT)).json();
  assert.equal(a1.status, "approved", "1天请假应一次通过");
});

test("加签 / 转办 / 越权审批", async () => {
  const req = await (await post("/api/requests", { type: "trip", category: "市内出差", startDate: "2026-06-02", endDate: "2026-06-03", reason: "出差", fields: { destination: "南宁", workItems: "调研" } }, userT)).json();
  assert.equal((await post(`/api/requests/${req.id}/approve`, {}, userT)).status, 403);
  const adminId = (await (await get("/api/directory", leaderT)).json()).find((u) => u.name === "系统管理员").id;
  const tr = await (await post(`/api/requests/${req.id}/transfer`, { targetUserId: adminId, comment: "请管理员处理" }, leaderT)).json();
  assert.equal(tr.current_approver_id, adminId);
  assert.equal((await post(`/api/requests/${req.id}/approve`, {}, leaderT)).status, 403);
});

test("公文：来文单位 + 分发 + 精确可见性 + 签名", async () => {
  const userId = (await (await get("/api/directory", adminT)).json()).find((u) => u.name === "王明").id;
  const doc = await (await post("/api/documents", { type: "收文", no: "测〔2026〕1号", title: "防疫通知", sourceUnit: "市卫健委", secret: "内部" }, adminT)).json();
  assert.equal(doc.source_unit, "市卫健委");
  assert.equal((await get(`/api/documents/${doc.id}`, userT)).status, 403);
  await post(`/api/documents/${doc.id}/distribute`, { readerIds: [userId] }, adminT);
  assert.equal((await get(`/api/documents/${doc.id}`, userT)).status, 200);
  await post(`/api/documents/${doc.id}/sign`, { signature: "data:image/png;base64,iVBOR", comment: "已签收" }, userT);
  const detail = await (await get(`/api/documents/${doc.id}`, userT)).json();
  assert.ok(detail.receipts.some((r) => r.signature), "应保存签名");
});

test("公文姓名子串不越权", async () => {
  const docs = await (await get("/api/documents", userT)).json();
  const adminDoc = await (await post("/api/documents", { type: "发文", no: "X", title: "仅管理员可见" }, adminT)).json();
  assert.ok(!docs.items.some((d) => d.id === adminDoc.id));
});

test("列表分页返回结构", async () => {
  const data = await (await get("/api/requests?page=1&pageSize=2", adminT)).json();
  assert.ok(Array.isArray(data.items));
  assert.equal(data.pageSize, 2);
  assert.ok(typeof data.total === "number");
  assert.ok(data.items.length <= 2);
  const logs = await (await get("/api/logs/operations?pageSize=5", adminT)).json();
  assert.ok(Array.isArray(logs.items) && typeof logs.total === "number");
});

test("批量导入部门与用户", async () => {
  const ExcelJS = require("exceljs");
  // 部门导入
  const wbD = new ExcelJS.Workbook();
  const wsD = wbD.addWorksheet("d");
  wsD.addRow(["部门名称", "上级部门", "排序"]);
  wsD.addRow(["导入测试科", "", 9]);
  wsD.addRow(["导入测试一组", "导入测试科", 1]);
  const bufD = await wbD.xlsx.writeBuffer();
  const fd1 = new FormData();
  fd1.append("file", new Blob([bufD]), "d.xlsx");
  const rd = await (await fetch(`${BASE}/api/import/departments`, { method: "POST", headers: { Authorization: `Bearer ${adminT}` }, body: fd1 })).json();
  assert.equal(rd.created, 2);
  // 用户导入
  const wbU = new ExcelJS.Workbook();
  const wsU = wbU.addWorksheet("u");
  wsU.addRow(["账号", "姓名", "部门", "角色", "密码"]);
  wsU.addRow(["imp001", "导入员工", "导入测试科", "普通职工", ""]);
  const bufU = await wbU.xlsx.writeBuffer();
  const fd2 = new FormData();
  fd2.append("file", new Blob([bufU]), "u.xlsx");
  const ru = await (await fetch(`${BASE}/api/import/users`, { method: "POST", headers: { Authorization: `Bearer ${adminT}` }, body: fd2 })).json();
  assert.equal(ru.created, 1);
  // 导入的账号可登录
  const lg = await (await post("/api/auth/login", { account: "imp001", password: "123456" })).json();
  assert.ok(lg.token);
});

test("统计分析", async () => {
  const stats = await (await get("/api/stats/requests?groupBy=type", adminT)).json();
  assert.ok(Array.isArray(stats.rows) && stats.rows.length > 0);
  const docStats = await (await get("/api/stats/documents", adminT)).json();
  assert.ok(Array.isArray(docStats.byType));
});

test("导出 Excel", async () => {
  const res = await get("/api/export/requests.xlsx", adminT);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /spreadsheetml/);
});

test("附件类型白名单拦截可执行文件", async () => {
  const req = await (await post("/api/requests", { type: "leave", category: "事假", startDate: "2026-07-01", endDate: "2026-07-01", reason: "附件测试" }, userT)).json();
  const form = new FormData();
  form.append("file", new Blob(["#!/bin/sh\necho hi"], { type: "application/x-sh" }), "evil.sh");
  const res = await fetch(`${BASE}/api/attachments/request/${req.id}`, { method: "POST", headers: { Authorization: `Bearer ${userT}` }, body: form });
  assert.equal(res.status, 400, "应拒绝 .sh 附件");
});

test("部门层级与删除校验", async () => {
  const parent = await (await post("/api/departments", { name: "测试一级科室" }, adminT)).json();
  const child = await (await post("/api/departments", { name: "测试二级科室", parentId: parent.id }, adminT)).json();
  assert.equal(child.parent_id, parent.id);
  assert.equal((await fetch(`${BASE}/api/departments/${parent.id}`, { method: "DELETE", headers: headers(adminT) })).status, 400);
  assert.equal((await fetch(`${BASE}/api/departments/${child.id}`, { method: "DELETE", headers: headers(adminT) })).status, 200);
});

test.after(() => {
  ["", "-wal", "-shm"].forEach((suffix) => { try { fs.unlinkSync(DB + suffix); } catch (e) { /* ignore */ } });
  setTimeout(() => process.exit(0), 100);
});
