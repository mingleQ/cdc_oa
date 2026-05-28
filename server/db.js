const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const { DATA_DIR, UPLOAD_DIR, BACKUP_DIR, DB_PATH } = require("./config");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function now() {
  return new Date().toISOString();
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      data_scope TEXT NOT NULL DEFAULT 'self',
      can_approve INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS role_modules (
      role_id INTEGER NOT NULL,
      module_id INTEGER NOT NULL,
      PRIMARY KEY (role_id, module_id),
      FOREIGN KEY (role_id) REFERENCES roles(id),
      FOREIGN KEY (module_id) REFERENCES modules(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      dept_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      FOREIGN KEY (dept_id) REFERENCES departments(id),
      FOREIGN KEY (role_id) REFERENCES roles(id)
    );

    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      scope TEXT NOT NULL,
      content TEXT NOT NULL,
      published_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      applicant_id INTEGER NOT NULL,
      dept_id INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      fields_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      current_node TEXT NOT NULL,
      current_approver_id INTEGER,
      apply_time TEXT,
      workflow_id INTEGER,
      workflow_step INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (applicant_id) REFERENCES users(id),
      FOREIGN KEY (dept_id) REFERENCES departments(id),
      FOREIGN KEY (current_approver_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      no TEXT NOT NULL,
      title TEXT NOT NULL,
      secret TEXT NOT NULL,
      urgency TEXT NOT NULL,
      owner_dept TEXT NOT NULL,
      readers TEXT NOT NULL DEFAULT '',
      reader_ids TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      source_unit TEXT NOT NULL DEFAULT '',
      main_send TEXT NOT NULL DEFAULT '',
      cc_send TEXT NOT NULL DEFAULT '',
      seal_no TEXT NOT NULL DEFAULT '',
      doc_date TEXT,
      origin_no TEXT NOT NULL DEFAULT '',
      issue_date TEXT,
      copies INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      current_node TEXT NOT NULL,
      current_approver_id INTEGER,
      created_by INTEGER NOT NULL,
      workflow_id INTEGER,
      workflow_step INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate_no TEXT NOT NULL,
      driver TEXT NOT NULL,
      status TEXT NOT NULL,
      mileage INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS vehicle_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      vehicle_id INTEGER,
      start_mileage INTEGER,
      end_mileage INTEGER,
      fuel_liters REAL,
      return_time TEXT,
      actual_start_time TEXT,
      fuel_count INTEGER NOT NULL DEFAULT 0,
      maintain_count INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_type TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL,
      node_name TEXT NOT NULL,
      approver_type TEXT NOT NULL,
      approver_value TEXT NOT NULL,
      condition_json TEXT NOT NULL DEFAULT '{}',
      approve_mode TEXT NOT NULL DEFAULT 'single',
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (workflow_id) REFERENCES workflow_definitions(id)
    );

    CREATE TABLE IF NOT EXISTS approval_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_type TEXT NOT NULL,
      business_id INTEGER NOT NULL,
      node_name TEXT NOT NULL,
      approver_id INTEGER NOT NULL,
      approver_name TEXT NOT NULL,
      action TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      approved_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      action TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_type TEXT NOT NULL,
      business_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_by INTEGER NOT NULL,
      uploaded_by_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachment_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attachment_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      downloaded_at TEXT NOT NULL,
      FOREIGN KEY (attachment_id) REFERENCES attachments(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'todo',
      business_type TEXT NOT NULL DEFAULT '',
      business_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id INTEGER,
      operator_name TEXT NOT NULL,
      module_name TEXT NOT NULL,
      action TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      content TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      account TEXT NOT NULL,
      login_time TEXT NOT NULL,
      ip TEXT NOT NULL,
      result TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT ''
    );
  `);
}

function ensureColumn(table, column, definition) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  // 表不存在（PRAGMA 返回空）时静默跳过，避免 runMigrations 在统一引擎建表之前误触发
  if (info.length === 0) return;
  const columns = info.map((item) => item.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function runMigrations() {
  // 兼容旧库：补齐新列
  ensureColumn("requests", "workflow_id", "INTEGER");
  ensureColumn("requests", "workflow_step", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("requests", "apply_time", "TEXT");
  ensureColumn("documents", "workflow_id", "INTEGER");
  ensureColumn("documents", "workflow_step", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("documents", "current_approver_id", "INTEGER");
  ensureColumn("documents", "reader_ids", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("documents", "source_unit", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("documents", "main_send", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("documents", "cc_send", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("documents", "seal_no", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("documents", "doc_date", "TEXT");
  // 阅文卡补充字段：原文件号 / 来文方发文日期 / 份数
  ensureColumn("documents", "origin_no", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("documents", "issue_date", "TEXT");
  ensureColumn("documents", "copies", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("document_receipts", "signature", "TEXT NOT NULL DEFAULT ''");
  // 通知公告 / 车辆台账：补发布人、更新时间，便于"谁发的、谁管理"溯源
  ensureColumn("notices", "created_by", "INTEGER");
  ensureColumn("notices", "updated_at", "TEXT");
  ensureColumn("vehicles", "updated_at", "TEXT");
  // 行车记录补字段：实际用车时间、加油次数、维修次数（旧库平滑升级）
  ensureColumn("vehicle_records", "actual_start_time", "TEXT");
  ensureColumn("vehicle_records", "fuel_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("vehicle_records", "maintain_count", "INTEGER NOT NULL DEFAULT 0");

  // DAG 流程：节点带类型/坐标，新增 workflow_edges 显式建模"谁连到谁"
  ensureColumn("workflow_nodes", "node_type", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("workflow_nodes", "node_kind", "TEXT NOT NULL DEFAULT 'task'");
  ensureColumn("workflow_nodes", "pos_x", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("workflow_nodes", "pos_y", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("workflow_nodes", "allow_terminal", "INTEGER NOT NULL DEFAULT 0");
  // 单据上记录"当前节点 ID"——支持 DAG 路由，比 workflow_step 更准
  ensureColumn("requests", "current_node_id", "INTEGER");
  ensureColumn("documents", "current_node_id", "INTEGER");
  ensureColumn("form_instances", "current_node_id", "INTEGER");
  // 员工档案字段：参加工作时间 + 联系电话
  ensureColumn("users", "entry_date", "TEXT");
  ensureColumn("users", "phone", "TEXT");
  // 年假台账初始化
  db.exec(`
    CREATE TABLE IF NOT EXISTS annual_leave_balance (
      user_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      total_days REAL NOT NULL DEFAULT 0,
      used_days REAL NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (user_id, year)
    );
    CREATE INDEX IF NOT EXISTS idx_alb_user ON annual_leave_balance(user_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL,
      from_node_id INTEGER NOT NULL,
      to_node_id INTEGER,
      label TEXT NOT NULL DEFAULT '',
      condition_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (workflow_id) REFERENCES workflow_definitions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_edges_wf ON workflow_edges(workflow_id, from_node_id);

    -- DAG 并行执行的活跃 token：同一单据可在多个节点同时停留
    CREATE TABLE IF NOT EXISTS workflow_active_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_type TEXT NOT NULL,
      business_id INTEGER NOT NULL,
      workflow_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      node_name TEXT NOT NULL,
      current_approver_id INTEGER,
      pending_approvers TEXT NOT NULL DEFAULT '',
      approve_mode TEXT NOT NULL DEFAULT 'single',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wf_active_biz ON workflow_active_nodes(business_type, business_id);
    CREATE INDEX IF NOT EXISTS idx_wf_active_approver ON workflow_active_nodes(current_approver_id);
  `);

  // 历史线性流程一次性回填为 DAG：n1 -> n2 -> ... -> end
  const wfsNeedEdges = db.prepare(`
    SELECT DISTINCT wd.id FROM workflow_definitions wd
    LEFT JOIN workflow_edges we ON we.workflow_id = wd.id
    WHERE we.id IS NULL
  `).all();
  if (wfsNeedEdges.length) {
    const insertEdge = db.prepare("INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, label, condition_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
    wfsNeedEdges.forEach((wf) => {
      const ns = db.prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order, id").all(wf.id);
      for (let i = 0; i < ns.length; i += 1) {
        const to = ns[i + 1] ? ns[i + 1].id : null; // 末节点 -> 结束（NULL）
        insertEdge.run(wf.id, ns[i].id, to, "", "{}", 1);
      }
      // 末节点 allow_terminal=1
      if (ns.length) db.prepare("UPDATE workflow_nodes SET allow_terminal = 1 WHERE id = ?").run(ns[ns.length - 1].id);
    });
  }

  // 历史数据补默认申请时间
  db.exec("UPDATE requests SET apply_time = created_at WHERE apply_time IS NULL OR apply_time = ''");
}

function createIndexes() {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_applicant ON requests(applicant_id);
    CREATE INDEX IF NOT EXISTS idx_requests_dept ON requests(dept_id);
    CREATE INDEX IF NOT EXISTS idx_requests_type_status ON requests(type, status);
    CREATE INDEX IF NOT EXISTS idx_requests_approver ON requests(current_approver_id);
    CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
    CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
    CREATE INDEX IF NOT EXISTS idx_documents_creator ON documents(created_by);
    CREATE INDEX IF NOT EXISTS idx_approval_business ON approval_records(business_type, business_id);
    CREATE INDEX IF NOT EXISTS idx_receipts_document ON document_receipts(document_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_business ON attachments(business_type, business_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_nodes_wf ON workflow_nodes(workflow_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_oplogs_created ON operation_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_loginlogs_time ON login_logs(login_time);
    CREATE INDEX IF NOT EXISTS idx_vehicle_records_request ON vehicle_records(request_id);
  `);
}

function seedData() {
  const roleCount = db.prepare("SELECT COUNT(*) AS count FROM roles").get().count;
  if (roleCount > 0) return;

  const insertRole = db.prepare("INSERT INTO roles (code, name, data_scope, can_approve, is_system) VALUES (?, ?, ?, ?, 1)");
  insertRole.run("admin", "管理员", "all", 1);
  insertRole.run("leader", "部门负责人", "dept_sub", 1);
  insertRole.run("user", "普通职工", "self", 0);

  const insertModule = db.prepare("INSERT INTO modules (code, name, sort_order) VALUES (?, ?, ?)");
  [
    ["dashboard", "工作台"],
    ["platform", "基础平台"],
    ["leave", "请假管理"],
    ["trip", "出差管理"],
    ["vehicle", "用车管理"],
    ["document", "公文管理"],
    ["stats", "统计分析"],
    ["logs", "操作日志"],
  ].forEach(([code, name], index) => insertModule.run(code, name, index + 1));

  const roleIds = Object.fromEntries(db.prepare("SELECT code, id FROM roles").all().map((item) => [item.code, item.id]));
  const moduleIds = Object.fromEntries(db.prepare("SELECT code, id FROM modules").all().map((item) => [item.code, item.id]));
  const insertRoleModule = db.prepare("INSERT INTO role_modules (role_id, module_id) VALUES (?, ?)");
  Object.keys(moduleIds).forEach((code) => insertRoleModule.run(roleIds.admin, moduleIds[code]));
  ["dashboard", "leave", "trip", "vehicle", "document", "stats"].forEach((code) => {
    insertRoleModule.run(roleIds.leader, moduleIds[code]);
  });
  ["dashboard", "leave", "trip", "vehicle", "document"].forEach((code) => {
    insertRoleModule.run(roleIds.user, moduleIds[code]);
  });

  const insertDept = db.prepare("INSERT INTO departments (parent_id, name, sort_order) VALUES (?, ?, ?)");
  const office = insertDept.run(null, "办公室", 1).lastInsertRowid;
  const immune = insertDept.run(null, "免疫规划科", 2).lastInsertRowid;
  insertDept.run(null, "传染病防制科", 3);
  insertDept.run(null, "检验科", 4);
  insertDept.run(null, "健康教育科", 5);
  insertDept.run(null, "中心领导", 6);

  const hash = bcrypt.hashSync("123456", 10);
  const insertUser = db.prepare("INSERT INTO users (account, password_hash, name, dept_id, role_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)");
  insertUser.run("admin", hash, "系统管理员", office, roleIds.admin, now());
  insertUser.run("leader", hash, "李主任", immune, roleIds.leader, now());
  insertUser.run("user", hash, "王明", immune, roleIds.user, now());

  const insertNotice = db.prepare("INSERT INTO notices (title, scope, content, published_at) VALUES (?, ?, ?, ?)");
  insertNotice.run("端午节值班安排填报", "全中心", "各科室请在本周五前完成节假日值班人员确认。", "2026-05-19");
  insertNotice.run("公文审批流程调整", "办公室", "收文与发文审批默认按当前时间处理，可按流程节点补充审批时间。", "2026-05-18");
  insertNotice.run("车辆使用登记要求", "全中心", "外出采样和下乡用车需提前提交申请，回单位后补充里程与用油信息。", "2026-05-15");

  db.prepare("INSERT INTO vehicles (plate_no, driver, status, mileage) VALUES (?, ?, ?, ?)").run("桂R-CDC01", "覃师傅", "空闲", 64218);
  db.prepare("INSERT INTO vehicles (plate_no, driver, status, mileage) VALUES (?, ?, ?, ?)").run("桂R-CDC02", "黄师傅", "已预约", 58102);
}

function normalizeDefaultAccounts() {
  const immuneDept = db.prepare("SELECT id FROM departments WHERE name = ?").get("免疫规划科");
  if (immuneDept) {
    db.prepare("UPDATE users SET dept_id = ? WHERE account = ? AND name = ?")
      .run(immuneDept.id, "leader", "李主任");
  }
  // 确保 stats 模块存在并对管理员、部门负责人可见（兼容旧库）
  let sm = db.prepare("SELECT id FROM modules WHERE code = 'stats'").get();
  if (!sm) {
    const maxSort = db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM modules").get().m;
    db.prepare("INSERT INTO modules (code, name, sort_order) VALUES ('stats','统计分析',?)").run(maxSort + 1);
    sm = db.prepare("SELECT id FROM modules WHERE code = 'stats'").get();
  }
  ["admin", "leader"].forEach((code) => {
    const role = db.prepare("SELECT id FROM roles WHERE code = ?").get(code);
    if (role && sm) {
      const exists = db.prepare("SELECT 1 FROM role_modules WHERE role_id = ? AND module_id = ?").get(role.id, sm.id);
      if (!exists) db.prepare("INSERT INTO role_modules (role_id, module_id) VALUES (?, ?)").run(role.id, sm.id);
    }
  });
}

// 发文流程节点目标定义（核稿→会签→签发→复核→用印登记→分发→归档）
// 统一在 ensureDefaultWorkflows 和 upgradeDocumentOutEngine 中复用，保证「首次建库」与「老库升级」配置一致。
const DOCUMENT_OUT_NODES = [
  { name: "核稿", approverType: "dept_leader", approverValue: "", mode: "single" },
  { name: "会签", approverType: "role", approverValue: "leader", mode: "countersign" },
  { name: "签发", approverType: "role", approverValue: "admin", mode: "single" },
  { name: "复核", approverType: "role", approverValue: "leader", mode: "single" },
  { name: "用印登记", approverType: "role", approverValue: "leader", mode: "single" },
  { name: "分发", approverType: "role", approverValue: "leader", mode: "single" },
  { name: "归档", approverType: "role", approverValue: "admin", mode: "single" },
];

function ensureDefaultWorkflows() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM workflow_definitions").get().count;
  if (count > 0) return;
  const createWorkflow = db.transaction((businessType, name, nodes) => {
    const result = db.prepare("INSERT INTO workflow_definitions (business_type, name, version, enabled, created_at) VALUES (?, ?, 1, 1, ?)")
      .run(businessType, name, now());
    const insertNode = db.prepare("INSERT INTO workflow_nodes (workflow_id, node_name, approver_type, approver_value, condition_json, approve_mode, sort_order, allow_terminal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    nodes.forEach((node, index) => insertNode.run(
      result.lastInsertRowid,
      node.name,
      node.approverType || "role",
      node.approverValue || "leader",
      JSON.stringify(node.condition || {}),
      node.mode || "single",
      index + 1,
      index === nodes.length - 1 ? 1 : 0,
    ));
  });
  createWorkflow("leave", "请假审批默认流程", [
    { name: "部门负责人审批", approverType: "dept_leader", approverValue: "" },
    { name: "分管领导审批", approverType: "role", approverValue: "admin", condition: { field: "days", op: ">=", value: 3 } },
    { name: "归档", approverType: "role", approverValue: "admin" },
  ]);
  createWorkflow("trip", "出差审批默认流程", [
    { name: "部门负责人审批", approverType: "dept_leader", approverValue: "" },
    { name: "归档", approverType: "role", approverValue: "admin" },
  ]);
  createWorkflow("vehicle", "用车审批默认流程", [
    { name: "科室负责人审批", approverType: "dept_leader", approverValue: "" },
    { name: "办公室审核", approverType: "role", approverValue: "admin" },
    { name: "归档", approverType: "role", approverValue: "admin" },
  ]);
  createWorkflow("document", "公文审批默认流程", [
    { name: "拟办/核稿", approverType: "role", approverValue: "leader" },
    { name: "办结归档", approverType: "role", approverValue: "admin" },
  ]);
  // 发文走独立流程：核稿 → 会签 → 签发 → 复核 → 用印登记 → 分发 → 归档
  // 审批人分层：避免后五节点全部 role=admin 卡在一个人手里
  createWorkflow("document_out", "发文办理默认流程", DOCUMENT_OUT_NODES);
}

/* ============================================================
 * 统一「流程 + 表单」引擎数据模型（Phase 2）
 * 加法式落地：新增 business_types / form_definitions / form_instances，
 * 不迁移 requests / documents 现有数据行——它们继续作为「预置实例」按原路运行。
 * ============================================================ */

// 预置业务类型：把现有请假/出差/用车/公文提升为引擎中的一等配置实体。
const PRESET_BUSINESS_TYPES = [
  { code: "leave", name: "请假", icon: "假", module_code: "leave", category: "request", sort_order: 1 },
  { code: "trip", name: "出差", icon: "差", module_code: "trip", category: "request", sort_order: 2 },
  { code: "vehicle", name: "用车", icon: "车", module_code: "vehicle", category: "request", sort_order: 3 },
  { code: "document", name: "公文", icon: "文", module_code: "document", category: "document", sort_order: 4 },
];

// 预置表单定义：字段 schema 与前端 categoryOptions / requestFields / 公文表单保持一致。
const PRESET_FORMS = {
  leave: [
    { key: "category", label: "请假类别", type: "select", required: true, options: ["事假", "病假", "年假", "婚假", "产假", "丧假", "调休", "其他"] },
    { key: "startDate", label: "开始日期", type: "date", required: true },
    { key: "endDate", label: "结束日期", type: "date", required: true },
    { key: "reason", label: "事由", type: "textarea", required: true },
  ],
  trip: [
    { key: "category", label: "出差类别", type: "radio", required: true, options: ["市内出差", "市外出差", "省外出差"] },
    { key: "startDate", label: "开始日期", type: "date", required: true },
    { key: "endDate", label: "结束日期", type: "date", required: true },
    { key: "personnel", label: "出差人员名单", type: "user-multi", required: false },
    { key: "personnelIds", label: "出差人员ID", type: "hidden", required: false },
    { key: "leader", label: "带队者", type: "text", required: true },
    { key: "workItems", label: "工作事项", type: "textarea", required: true },
    { key: "tripTypes", label: "出差类型", type: "checkbox", required: false, options: ["督导", "调查", "检测", "疫情处理", "开展业务培训", "工作会议", "其他", "参加业务培训", "学术会议", "进修学习"] },
    { key: "destination", label: "出差目的地", type: "text", required: true },
    { key: "taskDocId", label: "任务/公文", type: "doc-ref", required: false },
    { key: "taskDocTitle", label: "任务/公文标题", type: "hidden", required: false },
    { key: "reason", label: "出差事由", type: "textarea", required: true },
    { key: "transportTools", label: "交通工具", type: "checkbox", required: false, options: ["火车", "高铁/动车", "全列软席列车", "汽车", "轮船", "飞机", "单位派车", "租赁车辆", "乘坐出租车往返机场（车站）", "其他"] },
    { key: "budgetAmount", label: "差旅费预算（元）", type: "number", required: true },
    { key: "budgetChannel", label: "差旅费开支渠道", type: "text", required: false },
    { key: "tuitionPerPerson", label: "每人学费（元）", type: "number", required: false },
    { key: "remark", label: "备注", type: "textarea", required: false },
  ],
  vehicle: [
    { key: "category", label: "用车类别", type: "select", required: true, options: ["公务用车", "下乡采样", "会议用车", "应急用车"] },
    { key: "startDate", label: "开始日期", type: "date", required: true },
    { key: "endDate", label: "结束日期", type: "date", required: true },
    { key: "reason", label: "用车事由", type: "textarea", required: true },
    { key: "destinationDetail", label: "用车去向", type: "text", required: true },
    { key: "passengers", label: "乘车人员", type: "text", required: true },
    { key: "passengerCount", label: "乘车人数", type: "number", required: true },
    { key: "startDateTime", label: "起止开始时间", type: "datetime", required: true },
    { key: "endDateTime", label: "起止结束时间", type: "datetime", required: true },
    { key: "durationHours", label: "用车小时数", type: "number", required: false },
    { key: "departTime", label: "出发时间", type: "datetime", required: true },
    { key: "waitLocation", label: "候车地点", type: "text", required: true },
    { key: "deptSuggestion", label: "无中心车时，科室建议", type: "select", required: false, options: ["请选择", "外协调度", "公交出行", "自驾报销", "改期", "取消用车"] },
    { key: "internalContact", label: "本单位联系人", type: "text", required: false },
    { key: "internalPhone", label: "本单位联系电话", type: "text", required: false },
    { key: "externalContact", label: "外单位联系人", type: "text", required: false },
    { key: "externalPhone", label: "外单位联系电话", type: "text", required: false },
    { key: "otherRequirement", label: "其他要求", type: "text", required: false },
    { key: "preassignDriver", label: "调度-驾驶员", type: "text", required: false },
    { key: "preassignVehicleId", label: "调度-车号", type: "text", required: false },
    { key: "remark", label: "备注", type: "text", required: false },
  ],
  document: [
    { key: "no", label: "文号", type: "text", required: true },
    { key: "title", label: "公文标题", type: "text", required: true },
    { key: "docDate", label: "登记/成文日期", type: "date", required: false },
    { key: "sourceUnit", label: "来文单位", type: "text", required: false },
    { key: "mainSend", label: "主送机关", type: "text", required: false },
    { key: "ccSend", label: "抄送机关", type: "text", required: false },
    { key: "secret", label: "密级", type: "select", required: false, options: ["普通", "内部", "秘密", "机密"] },
    { key: "urgency", label: "紧急程度", type: "select", required: false, options: ["平件", "急件", "特急"] },
    { key: "sealNo", label: "用印/盖章登记", type: "text", required: false },
    { key: "content", label: "正文摘要", type: "textarea", required: false },
  ],
};

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function pruneBackups(keep) {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^oa-.*\.sqlite$/.test(name))
    .sort()
    .reverse();
  files.slice(keep).forEach((name) => {
    try { fs.unlinkSync(path.join(BACKUP_DIR, name)); } catch (e) { /* ignore */ }
  });
}

// 迁移前在线一致性备份：先把 WAL 合并进主库再整文件复制，确保备份含最新数据、可回滚。
// 备份失败直接抛出以中止迁移——宁可不迁移，也不在无备份时改动真实库（零丢失原则）。
function backupBeforeMigration(reason) {
  db.pragma("wal_checkpoint(TRUNCATE)");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(BACKUP_DIR, `oa-${stamp}-premigrate.sqlite`);
  fs.copyFileSync(DB_PATH, target);
  console.log(`[迁移前备份] ${reason} -> ${target}`);
  pruneBackups(Number(process.env.OA_BACKUP_KEEP || 30));
  return target;
}

function createEngineSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      module_code TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'request',
      is_preset INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS form_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_type_code TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      schema_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS form_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_type_code TEXT NOT NULL,
      form_id INTEGER,
      form_version INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      applicant_id INTEGER NOT NULL,
      dept_id INTEGER NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      current_node TEXT NOT NULL DEFAULT '',
      current_approver_id INTEGER,
      pending_approvers TEXT NOT NULL DEFAULT '',
      workflow_id INTEGER,
      workflow_step INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (applicant_id) REFERENCES users(id),
      FOREIGN KEY (dept_id) REFERENCES departments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_business_types_status ON business_types(status, sort_order);
    CREATE INDEX IF NOT EXISTS idx_form_definitions_type ON form_definitions(business_type_code, enabled);
    CREATE INDEX IF NOT EXISTS idx_form_instances_type_status ON form_instances(business_type_code, status);
    CREATE INDEX IF NOT EXISTS idx_form_instances_applicant ON form_instances(applicant_id);
    CREATE INDEX IF NOT EXISTS idx_form_instances_approver ON form_instances(current_approver_id);
  `);
}

// 仅在 business_types 为空时灌入预置数据，幂等可重复执行。
function seedEngineData() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM business_types").get().count;
  if (count > 0) return;
  const insertType = db.prepare(`
    INSERT INTO business_types (code, name, icon, module_code, category, is_preset, status, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?)
  `);
  const insertForm = db.prepare(`
    INSERT INTO form_definitions (business_type_code, name, version, enabled, schema_json, created_at)
    VALUES (?, ?, 1, 1, ?, ?)
  `);
  db.transaction(() => {
    PRESET_BUSINESS_TYPES.forEach((type) => {
      insertType.run(type.code, type.name, type.icon, type.module_code, type.category, type.sort_order, now());
      insertForm.run(type.code, `${type.name}默认表单`, JSON.stringify(PRESET_FORMS[type.code] || []), now());
    });
  })();
}

function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

// 统一引擎建表 + 扩列 + 预置；仅在缺表或缺列（首次升级）时触发迁移前备份。
function migrateUnifiedEngine() {
  const needTables = !tableExists("business_types") || !tableExists("form_definitions") || !tableExists("form_instances");
  const needRoleScope = tableExists("roles") && !columnExists("roles", "data_scope");
  const needCols = needRoleScope ||
    (tableExists("workflow_nodes") && !columnExists("workflow_nodes", "approve_mode")) ||
    (tableExists("requests") && !columnExists("requests", "pending_approvers")) ||
    (tableExists("documents") && !columnExists("documents", "pending_approvers")) ||
    (tableExists("form_instances") && !columnExists("form_instances", "pending_approvers"));
  if (needTables || needCols) {
    const hasData = tableExists("users") && db.prepare("SELECT COUNT(*) AS count FROM users").get().count > 0;
    if (hasData) backupBeforeMigration("统一引擎建表/扩列");
    if (needTables) createEngineSchema();
    // 并行/会签所需：节点审批模式 + 实例待办审批人集合（逗号分隔 ID）
    ensureColumn("workflow_nodes", "approve_mode", "TEXT NOT NULL DEFAULT 'single'");
    ensureColumn("requests", "pending_approvers", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("documents", "pending_approvers", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("form_instances", "pending_approvers", "TEXT NOT NULL DEFAULT ''");
    // 可配置数据权限：角色数据范围 + 可审批标志（首次添加时灌入内置三角色默认值）
    if (needRoleScope) {
      ensureColumn("roles", "data_scope", "TEXT NOT NULL DEFAULT 'self'");
      ensureColumn("roles", "can_approve", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn("roles", "is_system", "INTEGER NOT NULL DEFAULT 0");
      db.prepare("UPDATE roles SET data_scope='all', can_approve=1, is_system=1 WHERE code='admin'").run();
      db.prepare("UPDATE roles SET data_scope='dept_sub', can_approve=1, is_system=1 WHERE code='leader'").run();
      db.prepare("UPDATE roles SET data_scope='self', can_approve=0, is_system=1 WHERE code='user'").run();
    }
  }
  seedEngineData();
}

// 用车业务定制升级：表单 schema 与默认审批流程随版本演进（幂等）
function upgradeVehicleEngine() {
  // ① 表单 schema：若 vehicle 表单仍是旧版本（缺关键新字段），整体替换为最新预置 schema
  try {
    const formRow = db.prepare(
      "SELECT * FROM form_definitions WHERE business_type_code = 'vehicle' AND enabled = 1 ORDER BY version DESC LIMIT 1"
    ).get();
    if (formRow) {
      let schema = [];
      try { schema = JSON.parse(formRow.schema_json || "[]"); } catch (e) { schema = []; }
      const keys = new Set(schema.map((f) => f.key));
      const newKeys = ["destinationDetail", "passengerCount", "startDateTime", "endDateTime", "departTime", "waitLocation", "deptSuggestion", "internalContact", "externalContact"];
      const missing = newKeys.some((k) => !keys.has(k));
      if (missing) {
        db.prepare("UPDATE form_definitions SET schema_json = ? WHERE id = ?")
          .run(JSON.stringify(PRESET_FORMS.vehicle), formRow.id);
      }
    }
  } catch (e) { /* business_types / form_definitions 未建则跳过 */ }

  // ② 默认审批流程：若启用版本是 legacy 两节点（部门负责人审批 + 归档），灌入 v+1 三节点版本并禁用旧版
  try {
    const wfRow = db.prepare(
      "SELECT * FROM workflow_definitions WHERE business_type = 'vehicle' AND enabled = 1 ORDER BY version DESC LIMIT 1"
    ).get();
    if (wfRow) {
      const nodes = db.prepare("SELECT node_name FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order").all(wfRow.id);
      const names = nodes.map((n) => n.node_name);
      const isLegacy = names.length === 2 && names[0] === "部门负责人审批" && names[1] === "归档";
      if (isLegacy) {
        const nextVersion = (wfRow.version || 1) + 1;
        db.transaction(() => {
          db.prepare("UPDATE workflow_definitions SET enabled = 0 WHERE id = ?").run(wfRow.id);
          const ins = db.prepare("INSERT INTO workflow_definitions (business_type, name, version, enabled, created_at) VALUES (?, ?, ?, 1, ?)")
            .run("vehicle", "用车审批默认流程", nextVersion, now());
          const insertNode = db.prepare("INSERT INTO workflow_nodes (workflow_id, node_name, approver_type, approver_value, condition_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
          [
            { name: "科室负责人审批", approverType: "dept_leader", approverValue: "" },
            { name: "办公室审核", approverType: "role", approverValue: "admin" },
            { name: "归档", approverType: "role", approverValue: "admin" },
          ].forEach((node, index) => insertNode.run(ins.lastInsertRowid, node.name, node.approverType, node.approverValue, "{}", index + 1));
        })();
      }
    }
  } catch (e) { /* 表不存在时跳过 */ }
}

// 出差业务定制升级：表单 schema 随版本演进（幂等）
// 旧版仅有 destination/companions/transport/workItems，新版加入带队者、出差类型、交通工具、差旅费等
function upgradeTripEngine() {
  try {
    const formRow = db.prepare(
      "SELECT * FROM form_definitions WHERE business_type_code = 'trip' AND enabled = 1 ORDER BY version DESC LIMIT 1"
    ).get();
    if (!formRow) return;
    let schema = [];
    try { schema = JSON.parse(formRow.schema_json || "[]"); } catch (e) { schema = []; }
    const keys = new Set(schema.map((f) => f.key));
    const newKeys = ["personnel", "leader", "tripTypes", "transportTools", "budgetAmount", "remark"];
    const missing = newKeys.some((k) => !keys.has(k));
    if (missing) {
      db.prepare("UPDATE form_definitions SET schema_json = ? WHERE id = ?")
        .run(JSON.stringify(PRESET_FORMS.trip), formRow.id);
    }
  } catch (e) { /* business_types / form_definitions 未建则跳过 */ }
}

// 公文（阅文卡）业务定制升级：将旧版收文流程升级为 5 节点阅文卡链路（幂等）
// 旧：拟办 → 审批 → 归档（或类似 2-3 节点）；新：拟办 → 分管领导阅示 → 中心主任阅示 → 承办科室落实 → 归档
function upgradeDocumentEngine() {
  try {
    const wfRow = db.prepare(
      "SELECT * FROM workflow_definitions WHERE business_type = 'document' AND enabled = 1 ORDER BY version DESC LIMIT 1"
    ).get();
    if (!wfRow) return;
    const nodes = db.prepare("SELECT node_name FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order").all(wfRow.id);
    const names = nodes.map((n) => n.node_name);
    const targetNames = ["拟办", "分管领导阅示", "中心主任阅示", "承办科室落实", "归档"];
    // 已是目标版本则跳过
    if (names.length === targetNames.length && names.every((n, i) => n === targetNames[i])) return;
    const nextVersion = (wfRow.version || 1) + 1;
    db.transaction(() => {
      db.prepare("UPDATE workflow_definitions SET enabled = 0 WHERE id = ?").run(wfRow.id);
      const ins = db.prepare("INSERT INTO workflow_definitions (business_type, name, version, enabled, created_at) VALUES (?, ?, ?, 1, ?)")
        .run("document", "收文阅文卡流程", nextVersion, now());
      const insertNode = db.prepare("INSERT INTO workflow_nodes (workflow_id, node_name, approver_type, approver_value, condition_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
      [
        { name: "拟办", approverType: "role", approverValue: "admin" },
        { name: "分管领导阅示", approverType: "role", approverValue: "leader" },
        { name: "中心主任阅示", approverType: "role", approverValue: "admin" },
        { name: "承办科室落实", approverType: "dept_leader", approverValue: "" },
        { name: "归档", approverType: "role", approverValue: "admin" },
      ].forEach((node, index) => insertNode.run(ins.lastInsertRowid, node.name, node.approverType, node.approverValue, "{}", index + 1));
    })();
  } catch (e) { /* 表不存在时跳过 */ }
}

// 发文流程升级：旧库可能没有 document_out 流程，或配置过期，幂等补齐
// 新链路：核稿 → 会签 → 签发 → 复核 → 用印登记 → 分发 → 归档
// 指纹比对：节点名 + 审批人类型 + 审批人值 + 审批模式 全部命中才认为已对齐。
function upgradeDocumentOutEngine() {
  try {
    const wfRow = db.prepare(
      "SELECT * FROM workflow_definitions WHERE business_type = 'document_out' AND enabled = 1 ORDER BY version DESC LIMIT 1"
    ).get();
    const sig = (n) => `${n.name || n.node_name}|${n.approverType || n.approver_type}|${n.approverValue ?? n.approver_value ?? ""}|${n.mode || n.approve_mode || "single"}`;
    const targetSig = DOCUMENT_OUT_NODES.map(sig).join("\n");
    if (wfRow) {
      const existing = db.prepare("SELECT node_name, approver_type, approver_value, approve_mode FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order").all(wfRow.id);
      if (existing.map(sig).join("\n") === targetSig) return;
    }
    const nextVersion = (wfRow?.version || 0) + 1;
    db.transaction(() => {
      if (wfRow) db.prepare("UPDATE workflow_definitions SET enabled = 0 WHERE id = ?").run(wfRow.id);
      const ins = db.prepare("INSERT INTO workflow_definitions (business_type, name, version, enabled, created_at) VALUES (?, ?, ?, 1, ?)")
        .run("document_out", "发文办理流程", nextVersion, now());
      const wfId = ins.lastInsertRowid;
      const insertNode = db.prepare("INSERT INTO workflow_nodes (workflow_id, node_name, approver_type, approver_value, condition_json, approve_mode, sort_order, allow_terminal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      const nodeIds = DOCUMENT_OUT_NODES.map((node, index) => {
        const r = insertNode.run(wfId, node.name, node.approverType, node.approverValue, "{}", node.mode, index + 1, index === DOCUMENT_OUT_NODES.length - 1 ? 1 : 0);
        return r.lastInsertRowid;
      });
      // 显式建 DAG edges：n1→n2→…→末节点→NULL（终止）
      const insertEdge = db.prepare("INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, label, condition_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
      for (let i = 0; i < nodeIds.length; i += 1) {
        const to = nodeIds[i + 1] || null;
        insertEdge.run(wfId, nodeIds[i], to, "", "{}", 1);
      }
    })();
  } catch (e) { /* 表不存在时跳过 */ }
}

function bootstrap() {
  initSchema();
  runMigrations();
  createIndexes();
  seedData();
  normalizeDefaultAccounts();
  ensureDefaultWorkflows();
  migrateUnifiedEngine();
  upgradeVehicleEngine();
  upgradeTripEngine();
  upgradeDocumentEngine();
  upgradeDocumentOutEngine();
}

module.exports = { db, now, bootstrap };
