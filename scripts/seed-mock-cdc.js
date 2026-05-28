// 一次性脚本：为贵港疾控 OA 注入接近真实事业单位规模的人员/部门数据，
// 并把「请假」流程改成「科长 → 分管副主任 → 中心主任 → 归档」四级审批。
//
// 安全策略：执行前先在线备份（better-sqlite3 backup API），随后全部写入放在一个事务里，
// 任一步骤失败立即回滚；表结构不动，只新增行/调整外键引用与流程节点。
//
// 已存在的账号（admin / leader / user）不会被覆盖，原有部门也保留。
// 新增账号默认密码统一为 123456，方便测试登录。
//
// 用法：
//   node scripts/seed-mock-cdc.js
//   OA_DB_PATH=/tmp/oa-copy.sqlite node scripts/seed-mock-cdc.js   # 指向副本演练

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const root = path.resolve(__dirname, "..");
const source = process.env.OA_DB_PATH || path.join(root, "data", "oa.sqlite");
const backupDir = path.join(root, "backups");

if (!fs.existsSync(source)) {
  console.error(`[seed-mock-cdc] 数据库不存在：${source}`);
  process.exit(1);
}

const DEFAULT_PASSWORD = "123456";
const PASSWORD_HASH = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
const now = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// 备份
// ─────────────────────────────────────────────────────────────────────────────
async function backup() {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(backupDir, `oa-${stamp}-premockseed.sqlite`);
  const src = new Database(source, { readonly: true });
  try {
    await src.backup(target);
  } finally {
    src.close();
  }
  console.log(`[seed-mock-cdc] 备份完成：${target}`);
  return target;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主数据
// ─────────────────────────────────────────────────────────────────────────────
//
// 角色：在系统已有 admin / leader / user 之上新增「中心副主任」「中心主任」。
// 二者均设为系统内置角色，可审批，data_scope=all（覆盖中心全部业务范围）。
const ROLES = [
  { code: "vice_director", name: "中心副主任", data_scope: "all", can_approve: 1, is_system: 1 },
  { code: "director", name: "中心主任", data_scope: "all", can_approve: 1, is_system: 1 },
];

// 部门：参照疾控中心常见科室拆分；中心领导单列、业务科与行政后勤并列。
// 旧有部门：办公室(1)、免疫规划科(2)、传染病防制科(3)、检验科(4)、健康教育科(5)、中心领导(6)。
// 旧库中「免疫规划科 / 传染病防制科」误挂在「办公室」下，这里改回平级。
const DEPARTMENTS = [
  // name, sort_order, parent_name(null=顶级), 保留 status=active
  { name: "中心领导", sort: 1, parent: null },
  { name: "办公室", sort: 2, parent: null },
  { name: "人事科", sort: 3, parent: null },
  { name: "财务科", sort: 4, parent: null },
  { name: "免疫规划科", sort: 10, parent: null },
  { name: "传染病防制科", sort: 11, parent: null },
  { name: "急性传染病防制科", sort: 12, parent: null },
  { name: "慢性病防制科", sort: 13, parent: null },
  { name: "结核病防制科", sort: 14, parent: null },
  { name: "艾滋病防制科", sort: 15, parent: null },
  { name: "健康教育科", sort: 20, parent: null },
  { name: "检验科", sort: 21, parent: null },
  { name: "应急办公室", sort: 22, parent: null },
  { name: "信息科", sort: 23, parent: null },
];

// 人员：account 全局唯一；姓名/部门/角色按事业单位编制思路填。
// 已存在：admin(系统管理员)、leader(李主任，免疫规划科 科长)、user(王明，免疫规划科)。
const USERS = [
  // ─── 中心领导 ────────────────────────────────────────────────────────────
  { account: "zhangzhuren",   name: "张志远",  dept: "中心领导",     role: "director" },
  { account: "liufuzhuren",   name: "刘建国",  dept: "中心领导",     role: "vice_director" },  // 分管业务（防制/检验）
  { account: "chenfuzhuren",  name: "陈丽华",  dept: "中心领导",     role: "vice_director" },  // 分管行政（办公室/财务/人事）
  // ─── 办公室 ──────────────────────────────────────────────────────────────
  { account: "ofz_zhao",      name: "赵伟",    dept: "办公室",       role: "leader" },
  { account: "of_zhou",       name: "周婷",    dept: "办公室",       role: "user" },
  { account: "of_wu",         name: "吴磊",    dept: "办公室",       role: "user" },
  // ─── 人事科 ──────────────────────────────────────────────────────────────
  { account: "hr_chief_sun",  name: "孙海燕",  dept: "人事科",       role: "leader" },
  { account: "hr_lin",        name: "林思",    dept: "人事科",       role: "user" },
  // ─── 财务科 ──────────────────────────────────────────────────────────────
  { account: "fin_chief_huang", name: "黄文斌", dept: "财务科",      role: "leader" },
  { account: "fin_xie",       name: "谢雨",    dept: "财务科",       role: "user" },
  // ─── 免疫规划科（沿用既有：李主任 / 王明）──────────────────────────
  { account: "im_li",         name: "李娜",    dept: "免疫规划科",   role: "user" },
  // ─── 传染病防制科 ────────────────────────────────────────────────────────
  { account: "cdi_chief_qin", name: "覃志强",  dept: "传染病防制科", role: "leader" },
  { account: "cdi_he",        name: "何静",    dept: "传染病防制科", role: "user" },
  { account: "cdi_yang",      name: "杨阳",    dept: "传染病防制科", role: "user" },
  // ─── 急性传染病防制科 ────────────────────────────────────────────────────
  { account: "aci_chief_pan", name: "潘建华",  dept: "急性传染病防制科", role: "leader" },
  { account: "aci_zhu",       name: "朱晓敏",  dept: "急性传染病防制科", role: "user" },
  // ─── 慢性病防制科 ────────────────────────────────────────────────────────
  { account: "ncd_chief_lu",  name: "陆青松",  dept: "慢性病防制科", role: "leader" },
  { account: "ncd_xu",        name: "徐丹",    dept: "慢性病防制科", role: "user" },
  // ─── 结核病防制科 ────────────────────────────────────────────────────────
  { account: "tb_chief_liang", name: "梁文",   dept: "结核病防制科", role: "leader" },
  { account: "tb_song",       name: "宋佳",    dept: "结核病防制科", role: "user" },
  // ─── 艾滋病防制科 ────────────────────────────────────────────────────────
  { account: "hiv_chief_mo",  name: "莫怀英",  dept: "艾滋病防制科", role: "leader" },
  { account: "hiv_deng",      name: "邓凯",    dept: "艾滋病防制科", role: "user" },
  // ─── 健康教育科 ──────────────────────────────────────────────────────────
  { account: "he_chief_tan",  name: "谭丽",    dept: "健康教育科",   role: "leader" },
  { account: "he_feng",       name: "冯雪",    dept: "健康教育科",   role: "user" },
  // ─── 检验科 ──────────────────────────────────────────────────────────────
  { account: "lab_chief_wei", name: "韦国梁",  dept: "检验科",       role: "leader" },
  { account: "lab_luo",       name: "罗思源",  dept: "检验科",       role: "user" },
  { account: "lab_jiang",     name: "蒋媛",    dept: "检验科",       role: "user" },
  // ─── 应急办公室 ──────────────────────────────────────────────────────────
  { account: "eoc_chief_fang", name: "方俊",   dept: "应急办公室",   role: "leader" },
  { account: "eoc_du",        name: "杜宇",    dept: "应急办公室",   role: "user" },
  // ─── 信息科 ──────────────────────────────────────────────────────────────
  { account: "it_chief_ma",   name: "马程",    dept: "信息科",       role: "leader" },
  { account: "it_yu",         name: "于浩",    dept: "信息科",       role: "user" },
];

// 请假审批流程（四级）：
//   1. 部门科长 (dept_leader → leader)        当前科室的科长
//   2. 分管副主任 (role: vice_director)        中心副主任
//   3. 中心主任 (role: director)               中心主任
//   4. 归档 (role: admin)                      系统管理员
const LEAVE_WORKFLOW = {
  name: "请假审批流程",
  business_type: "leave",
  nodes: [
    { node_name: "部门负责人审批",   approver_type: "dept_leader", approver_value: "leader",        approve_mode: "single" },
    { node_name: "分管副主任审批",   approver_type: "role",        approver_value: "vice_director", approve_mode: "single" },
    { node_name: "中心主任审批",     approver_type: "role",        approver_value: "director",      approve_mode: "single" },
    { node_name: "归档",             approver_type: "role",        approver_value: "admin",         approve_mode: "single" },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  await backup();
  const db = new Database(source);
  db.pragma("foreign_keys = ON");

  const summary = { rolesAdded: 0, deptsAdded: 0, deptsRehomed: 0, usersAdded: 0, usersSkipped: 0, workflow: null };

  const tx = db.transaction(() => {
    // —— 1) 角色 ——
    const insRole = db.prepare(
      "INSERT INTO roles (code, name, data_scope, can_approve, is_system) VALUES (?, ?, ?, ?, ?)",
    );
    const getRoleByCode = db.prepare("SELECT id FROM roles WHERE code = ?");
    ROLES.forEach((r) => {
      if (!getRoleByCode.get(r.code)) {
        insRole.run(r.code, r.name, r.data_scope, r.can_approve, r.is_system);
        summary.rolesAdded += 1;
      }
    });

    // —— 2) 把新角色挂到现有所有业务模块（与 admin/leader 对齐）——
    const moduleIds = db.prepare("SELECT id, code FROM modules").all();
    const ensureRoleModule = db.prepare(
      "INSERT INTO role_modules (role_id, module_id) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM role_modules WHERE role_id=? AND module_id=?)",
    );
    // 副主任 / 主任 与「部门负责人」可见模块对齐（不含 logs，避免误开操作日志）
    const leaderModules = new Set(["dashboard", "leave", "trip", "vehicle", "document", "stats"]);
    ["vice_director", "director"].forEach((code) => {
      const r = getRoleByCode.get(code);
      if (!r) return;
      moduleIds.filter((m) => leaderModules.has(m.code)).forEach((m) => {
        ensureRoleModule.run(r.id, m.id, r.id, m.id);
      });
    });

    // —— 3) 部门：先建/复用，再把误挂在「办公室」下的两个科改成平级 ——
    const getDeptByName = db.prepare("SELECT id, parent_id FROM departments WHERE name = ?");
    const insDept = db.prepare(
      "INSERT INTO departments (parent_id, name, sort_order, status) VALUES (?, ?, ?, 'active')",
    );
    DEPARTMENTS.forEach((d) => {
      const existing = getDeptByName.get(d.name);
      if (!existing) {
        insDept.run(null, d.name, d.sort);
        summary.deptsAdded += 1;
      }
    });

    // 把旧库里挂在「办公室」下面的科室提到顶级
    const office = getDeptByName.get("办公室");
    if (office) {
      const rehomed = db
        .prepare("UPDATE departments SET parent_id = NULL WHERE parent_id = ? AND name IN ('免疫规划科','传染病防制科')")
        .run(office.id);
      summary.deptsRehomed = rehomed.changes;
    }

    // 同步排序号（确保 UI 顺序符合预期，不影响 id）
    const updSort = db.prepare("UPDATE departments SET sort_order = ? WHERE name = ?");
    DEPARTMENTS.forEach((d) => updSort.run(d.sort, d.name));

    // —— 4) 用户 ——
    const getUserByAccount = db.prepare("SELECT id FROM users WHERE account = ?");
    const insUser = db.prepare(
      "INSERT INTO users (account, password_hash, name, dept_id, role_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    );
    USERS.forEach((u) => {
      if (getUserByAccount.get(u.account)) {
        summary.usersSkipped += 1;
        return;
      }
      const dept = getDeptByName.get(u.dept);
      const role = getRoleByCode.get(u.role);
      if (!dept) throw new Error(`部门不存在：${u.dept}`);
      if (!role) throw new Error(`角色不存在：${u.role}`);
      insUser.run(u.account, PASSWORD_HASH, u.name, dept.id, role.id, now());
      summary.usersAdded += 1;
    });

    // —— 5) 请假流程：停掉旧版，新建一个版本并置为启用 ——
    const maxVer = db.prepare(
      "SELECT COALESCE(MAX(version), 0) AS v FROM workflow_definitions WHERE business_type = ?",
    ).get(LEAVE_WORKFLOW.business_type).v;
    db.prepare("UPDATE workflow_definitions SET enabled = 0 WHERE business_type = ?")
      .run(LEAVE_WORKFLOW.business_type);
    const wfId = db.prepare(
      "INSERT INTO workflow_definitions (business_type, name, version, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
    ).run(LEAVE_WORKFLOW.business_type, LEAVE_WORKFLOW.name, maxVer + 1, now()).lastInsertRowid;

    const insNode = db.prepare(
      "INSERT INTO workflow_nodes (workflow_id, node_name, approver_type, approver_value, condition_json, sort_order, approve_mode) VALUES (?, ?, ?, ?, '{}', ?, ?)",
    );
    LEAVE_WORKFLOW.nodes.forEach((n, idx) => {
      insNode.run(wfId, n.node_name, n.approver_type, n.approver_value, idx + 1, n.approve_mode);
    });
    summary.workflow = { id: wfId, version: maxVer + 1, nodes: LEAVE_WORKFLOW.nodes.length };
  });

  try {
    tx();
  } catch (error) {
    db.close();
    console.error("[seed-mock-cdc] 事务失败，已回滚：", error.message);
    process.exit(1);
  }
  db.close();

  console.log("[seed-mock-cdc] 完成：", JSON.stringify(summary, null, 2));
  console.log(`[seed-mock-cdc] 新账号默认密码：${DEFAULT_PASSWORD}`);
}

main().catch((err) => {
  console.error("[seed-mock-cdc] 异常：", err);
  process.exit(1);
});
