const multer = require("multer");
const ExcelJS = require("exceljs");

const { db, now } = require("../db");
const { clientIp, hashPassword, modulesForRole, pageParams } = require("../core/util");
const { requireAuth, requireRole, canApprove } = require("../core/auth");
const { writeOperationLog } = require("../core/audit");
const { getUserById, getRoleById, getDepartmentById } = require("../repository");

// 批量导入用内存存储（小文件，直接解析不落盘）
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

async function sendWorkbook(res, workbook, filename) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  await workbook.xlsx.write(res);
  res.end();
}

const cellText = (row, i) => {
  const v = row.getCell(i).value;
  if (v == null) return "";
  if (typeof v === "object") return String(v.text ?? v.result ?? v.hyperlink ?? "").trim();
  return String(v).trim();
};

// 收集某部门及其所有下级部门的 id（用于"本部门及下级"数据筛选）
function deptSubtreeIds(rootId) {
  const root = Number(rootId);
  if (!root) return [];
  const all = db.prepare("SELECT id, parent_id FROM departments").all();
  const childMap = {};
  all.forEach((d) => { (childMap[d.parent_id || 0] = childMap[d.parent_id || 0] || []).push(d.id); });
  const result = [];
  const stack = [root];
  while (stack.length) {
    const id = stack.pop();
    result.push(id);
    (childMap[id] || []).forEach((c) => stack.push(c));
  }
  return result;
}

function register(app) {
  /* ============ 组织架构 ============ */

  app.get("/api/departments", requireAuth, (req, res) => {
    res.json(db.prepare("SELECT * FROM departments ORDER BY sort_order, id").all());
  });

  app.post("/api/departments", requireAuth, requireRole("admin"), (req, res) => {
    const { name, parentId, sortOrder } = req.body;
    if (!name) return res.status(400).json({ message: "部门名称必填" });
    if (parentId && !getDepartmentById(parentId)) return res.status(400).json({ message: "上级部门不存在" });
    const result = db.prepare("INSERT INTO departments (parent_id, name, sort_order, status) VALUES (?, ?, ?, 'active')")
      .run(parentId || null, name, Number(sortOrder || 0));
    writeOperationLog(req.user, "基础平台", "新增部门", "department", String(result.lastInsertRowid), name, clientIp(req));
    res.status(201).json(getDepartmentById(result.lastInsertRowid));
  });

  app.put("/api/departments/:id", requireAuth, requireRole("admin"), (req, res) => {
    const dept = getDepartmentById(req.params.id);
    if (!dept) return res.status(404).json({ message: "部门不存在" });
    const { name, parentId, sortOrder, status } = req.body;
    if (!name) return res.status(400).json({ message: "部门名称必填" });
    if (Number(parentId) === Number(req.params.id)) return res.status(400).json({ message: "上级部门不能是自身" });
    if (parentId && !getDepartmentById(parentId)) return res.status(400).json({ message: "上级部门不存在" });
    db.prepare("UPDATE departments SET parent_id = ?, name = ?, sort_order = ?, status = ? WHERE id = ?")
      .run(parentId || null, name, Number(sortOrder || 0), status || "active", req.params.id);
    writeOperationLog(req.user, "基础平台", "编辑部门", "department", String(req.params.id), name, clientIp(req));
    res.json(getDepartmentById(req.params.id));
  });

  app.delete("/api/departments/:id", requireAuth, requireRole("admin"), (req, res) => {
    const dept = getDepartmentById(req.params.id);
    if (!dept) return res.status(404).json({ message: "部门不存在" });
    const childCount = db.prepare("SELECT COUNT(*) AS count FROM departments WHERE parent_id = ?").get(req.params.id).count;
    const userCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE dept_id = ?").get(req.params.id).count;
    if (childCount || userCount) return res.status(400).json({ message: "部门下存在子部门或用户，不能删除" });
    db.prepare("DELETE FROM departments WHERE id = ?").run(req.params.id);
    writeOperationLog(req.user, "基础平台", "删除部门", "department", String(req.params.id), dept.name, clientIp(req));
    res.json({ ok: true });
  });

  /* ============ 用户 ============ */

  // 用户列表：分页 + 关键字搜索 + 部门(含下级)/角色/状态筛选 + 排序
  function buildUserQuery(req) {
    const params = [];
    let where = "WHERE 1=1";
    const keyword = (req.query.keyword || "").trim();
    if (keyword) { where += " AND (u.name LIKE ? OR u.account LIKE ?)"; params.push(`%${keyword}%`, `%${keyword}%`); }
    if (req.query.deptId) {
      const ids = deptSubtreeIds(req.query.deptId);
      if (ids.length) { where += ` AND u.dept_id IN (${ids.map(() => "?").join(",")})`; params.push(...ids); }
    }
    if (req.query.roleId) { where += " AND u.role_id = ?"; params.push(Number(req.query.roleId)); }
    if (req.query.status && ["active", "disabled"].includes(req.query.status)) { where += " AND u.status = ?"; params.push(req.query.status); }
    return { where, params };
  }

  app.get("/api/users", requireAuth, requireRole("admin"), (req, res) => {
    const { where, params } = buildUserQuery(req);
    const joins = "FROM users u JOIN departments d ON d.id = u.dept_id JOIN roles r ON r.id = u.role_id";
    const total = db.prepare(`SELECT COUNT(*) AS c ${joins} ${where}`).get(...params).c;
    const sortMap = { name: "u.name", account: "u.account", dept: "d.sort_order", created: "u.created_at", id: "u.id" };
    const sortCol = sortMap[req.query.sortBy] || "u.id";
    const sortDir = String(req.query.sortDir || "").toLowerCase() === "desc" ? "DESC" : "ASC";
    const { page, pageSize, limit, offset } = pageParams(req);
    const items = db.prepare(`
      SELECT u.id, u.account, u.name, u.status, u.dept_id, u.role_id, u.entry_date, u.phone, d.name AS dept, r.name AS role, r.code AS role_code, u.created_at
      ${joins} ${where} ORDER BY ${sortCol} ${sortDir}, u.id LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    res.json({ items, total, page, pageSize });
  });

  // 审批人/分发对象选择器（审批人与公文创建者可用）
  app.get("/api/directory", requireAuth, (req, res) => {
    if (!canApprove(req.user)) return res.status(403).json({ message: "无权限" });
    res.json(db.prepare(`
      SELECT u.id, u.name, d.name AS dept, r.name AS role
      FROM users u JOIN departments d ON d.id = u.dept_id JOIN roles r ON r.id = u.role_id
      WHERE u.status = 'active' ORDER BY d.sort_order, u.id
    `).all());
  });

  // 通用人员选择器（任何登录用户可用，仅返回 id/姓名/部门）
  // 用于出差人员、带队者等业务表单的"挑同事"场景，避免普通员工被审批权限挡住。
  app.get("/api/directory/picker", requireAuth, (req, res) => {
    res.json(db.prepare(`
      SELECT u.id, u.name, d.name AS dept
      FROM users u JOIN departments d ON d.id = u.dept_id
      WHERE u.status = 'active' ORDER BY d.sort_order, u.id
    `).all());
  });

  app.post("/api/users", requireAuth, requireRole("admin"), (req, res) => {
    const { account, password, name, deptId, roleId, entryDate, phone } = req.body;
    if (!account || !password || !name || !deptId || !roleId) return res.status(400).json({ message: "用户信息不完整" });
    if (String(password).length < 6) return res.status(400).json({ message: "初始密码至少 6 位" });
    if (!getDepartmentById(deptId)) return res.status(400).json({ message: "部门不存在" });
    if (!getRoleById(roleId)) return res.status(400).json({ message: "角色不存在" });
    try {
      const result = db.prepare("INSERT INTO users (account, password_hash, name, dept_id, role_id, status, entry_date, phone, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)")
        .run(account, hashPassword(password), name, deptId, roleId, entryDate || null, phone || null, now());
      writeOperationLog(req.user, "基础平台", "新增用户", "user", String(result.lastInsertRowid), `${name}(${account})`, clientIp(req));
      res.status(201).json(getUserById(result.lastInsertRowid));
    } catch (error) {
      res.status(400).json({ message: "账号已存在" });
    }
  });

  app.put("/api/users/:id", requireAuth, requireRole("admin"), (req, res) => {
    const user = getUserById(req.params.id);
    if (!user) return res.status(404).json({ message: "用户不存在" });
    const { name, deptId, roleId, status, entryDate, phone } = req.body;
    if (!name || !deptId || !roleId) return res.status(400).json({ message: "用户信息不完整" });
    if (!getDepartmentById(deptId)) return res.status(400).json({ message: "部门不存在" });
    if (!getRoleById(roleId)) return res.status(400).json({ message: "角色不存在" });
    db.prepare("UPDATE users SET name = ?, dept_id = ?, role_id = ?, status = ?, entry_date = ?, phone = ? WHERE id = ?")
      .run(name, deptId, roleId, status || "active", entryDate || null, phone || null, req.params.id);
    writeOperationLog(req.user, "基础平台", "编辑用户", "user", String(req.params.id), name, clientIp(req));
    res.json(getUserById(req.params.id));
  });

  app.post("/api/users/:id/disable", requireAuth, requireRole("admin"), (req, res) => {
    const user = getUserById(req.params.id);
    if (!user) return res.status(404).json({ message: "用户不存在" });
    if (user.id === req.user.id) return res.status(400).json({ message: "不能禁用当前登录账号" });
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(req.params.id);
    writeOperationLog(req.user, "基础平台", "禁用用户", "user", String(req.params.id), user.name, clientIp(req));
    res.json(getUserById(req.params.id));
  });

  app.post("/api/users/:id/enable", requireAuth, requireRole("admin"), (req, res) => {
    const user = getUserById(req.params.id);
    if (!user) return res.status(404).json({ message: "用户不存在" });
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(req.params.id);
    writeOperationLog(req.user, "基础平台", "启用用户", "user", String(req.params.id), user.name, clientIp(req));
    res.json(getUserById(req.params.id));
  });

  app.post("/api/users/:id/reset-password", requireAuth, requireRole("admin"), (req, res) => {
    const user = getUserById(req.params.id);
    if (!user) return res.status(404).json({ message: "用户不存在" });
    const password = req.body.password || "123456";
    if (String(password).length < 6) return res.status(400).json({ message: "密码至少 6 位" });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), req.params.id);
    writeOperationLog(req.user, "基础平台", "重置密码", "user", String(req.params.id), user.name, clientIp(req));
    res.json({ ok: true });
  });

  // 统计用户在各业务表中的引用，>0 则不允许物理删除（避免破坏历史记录）
  function userReferenceCount(id) {
    const q = (sql) => db.prepare(sql).get(id).c;
    return q("SELECT COUNT(*) AS c FROM requests WHERE applicant_id = ?")
      + q("SELECT COUNT(*) AS c FROM requests WHERE current_approver_id = ?")
      + q("SELECT COUNT(*) AS c FROM documents WHERE created_by = ?")
      + q("SELECT COUNT(*) AS c FROM documents WHERE current_approver_id = ?")
      + q("SELECT COUNT(*) AS c FROM document_receipts WHERE user_id = ?")
      + q("SELECT COUNT(*) AS c FROM vehicle_records WHERE created_by = ?");
  }

  function deleteUserHard(id) {
    db.transaction(() => {
      db.prepare("DELETE FROM notifications WHERE user_id = ?").run(id);
      db.prepare("DELETE FROM users WHERE id = ?").run(id);
    })();
  }

  app.delete("/api/users/:id", requireAuth, requireRole("admin"), (req, res) => {
    const user = getUserById(req.params.id);
    if (!user) return res.status(404).json({ message: "用户不存在" });
    if (user.id === req.user.id) return res.status(400).json({ message: "不能删除当前登录账号" });
    if (userReferenceCount(user.id) > 0) return res.status(400).json({ message: "该用户已有业务/审批记录，不能删除，请改用禁用" });
    deleteUserHard(user.id);
    writeOperationLog(req.user, "基础平台", "删除用户", "user", String(user.id), `${user.name}(${user.account})`, clientIp(req));
    res.json({ ok: true });
  });

  // 批量操作：启用/禁用/调部门/改角色/重置密码/删除
  app.post("/api/users/bulk", requireAuth, requireRole("admin"), (req, res) => {
    const { action, ids, deptId, roleId, password } = req.body;
    const list = Array.isArray(ids) ? [...new Set(ids.map(Number).filter(Boolean))] : [];
    if (!list.length) return res.status(400).json({ message: "请先选择用户" });
    if (!["enable", "disable", "move", "setRole", "reset", "delete"].includes(action)) return res.status(400).json({ message: "不支持的操作" });
    if (action === "move" && !getDepartmentById(deptId)) return res.status(400).json({ message: "目标部门不存在" });
    if (action === "setRole" && !getRoleById(roleId)) return res.status(400).json({ message: "目标角色不存在" });
    const pwd = password || "123456";
    if (action === "reset" && String(pwd).length < 6) return res.status(400).json({ message: "密码至少 6 位" });
    let success = 0; const failed = [];
    list.forEach((id) => {
      const user = getUserById(id);
      if (!user) { failed.push({ id, reason: "用户不存在" }); return; }
      try {
        if (action === "disable") {
          if (user.id === req.user.id) { failed.push({ id, name: user.name, reason: "不能禁用当前账号" }); return; }
          db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(id);
        } else if (action === "enable") {
          db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(id);
        } else if (action === "move") {
          db.prepare("UPDATE users SET dept_id = ? WHERE id = ?").run(Number(deptId), id);
        } else if (action === "setRole") {
          db.prepare("UPDATE users SET role_id = ? WHERE id = ?").run(Number(roleId), id);
        } else if (action === "reset") {
          db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(pwd), id);
        } else if (action === "delete") {
          if (user.id === req.user.id) { failed.push({ id, name: user.name, reason: "不能删除当前账号" }); return; }
          if (userReferenceCount(id) > 0) { failed.push({ id, name: user.name, reason: "有业务记录，请改用禁用" }); return; }
          deleteUserHard(id);
        }
        success += 1;
      } catch (e) { failed.push({ id, name: user.name, reason: "操作失败" }); }
    });
    const actionText = { enable: "批量启用", disable: "批量禁用", move: "批量调部门", setRole: "批量改角色", reset: "批量重置密码", delete: "批量删除" }[action];
    writeOperationLog(req.user, "基础平台", actionText, "user", list.join(","), `成功 ${success}/${list.length}`, clientIp(req));
    res.json({ ok: true, success, failed });
  });

  // 按当前筛选条件导出用户列表（Excel）
  app.get("/api/users/export.xlsx", requireAuth, requireRole("admin"), async (req, res) => {
    const { where, params } = buildUserQuery(req);
    const rows = db.prepare(`
      SELECT u.account, u.name, d.name AS dept, r.name AS role, u.status, u.created_at
      FROM users u JOIN departments d ON d.id = u.dept_id JOIN roles r ON r.id = u.role_id
      ${where} ORDER BY d.sort_order, u.id
    `).all(...params);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("用户");
    ws.columns = [
      { header: "账号", key: "account", width: 18 },
      { header: "姓名", key: "name", width: 16 },
      { header: "部门", key: "dept", width: 22 },
      { header: "角色", key: "role", width: 14 },
      { header: "状态", key: "status", width: 10 },
      { header: "创建时间", key: "created_at", width: 24 },
    ];
    rows.forEach((u) => ws.addRow({ ...u, status: u.status === "active" ? "启用" : "禁用" }));
    ws.getRow(1).font = { bold: true };
    writeOperationLog(req.user, "基础平台", "导出用户", "user", "-", `导出 ${rows.length} 条`, clientIp(req));
    await sendWorkbook(res, wb, `用户列表_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });

  /* ============ 批量导入 ============ */

  app.get("/api/import/template/departments.xlsx", requireAuth, requireRole("admin"), async (req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("部门导入");
    ws.columns = [
      { header: "部门名称(必填)", key: "name", width: 24 },
      { header: "上级部门名称(可空)", key: "parent", width: 24 },
      { header: "排序号(可空)", key: "sort", width: 14 },
    ];
    ws.addRow({ name: "办公室", parent: "", sort: 1 });
    ws.addRow({ name: "免疫规划科", parent: "", sort: 2 });
    ws.addRow({ name: "免疫一组", parent: "免疫规划科", sort: 1 });
    await sendWorkbook(res, wb, "部门导入模板.xlsx");
  });

  app.get("/api/import/template/users.xlsx", requireAuth, requireRole("admin"), async (req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("用户导入");
    ws.columns = [
      { header: "账号(必填)", key: "account", width: 18 },
      { header: "姓名(必填)", key: "name", width: 16 },
      { header: "部门名称(必填)", key: "dept", width: 20 },
      { header: "角色(管理员/部门负责人/普通职工)", key: "role", width: 28 },
      { header: "初始密码(可空,默认123456)", key: "pwd", width: 24 },
    ];
    ws.addRow({ account: "zhangsan", name: "张三", dept: "免疫规划科", role: "普通职工", pwd: "" });
    ws.addRow({ account: "lisi", name: "李四", dept: "办公室", role: "部门负责人", pwd: "" });
    await sendWorkbook(res, wb, "用户导入模板.xlsx");
  });

  app.post("/api/import/departments", requireAuth, requireRole("admin"), importUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "未上传文件" });
    let ws;
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      ws = wb.worksheets[0];
    } catch (e) { return res.status(400).json({ message: "无法解析 Excel 文件" }); }
    const rows = [];
    ws.eachRow((row, n) => { if (n === 1) return; const name = cellText(row, 1); if (name) rows.push({ name, parent: cellText(row, 2), sort: Number(cellText(row, 3)) || 0 }); });
    let created = 0; const errors = [];
    const trx = db.transaction(() => {
      // 第一遍：插入（无上级）
      rows.forEach((r) => {
        const exists = db.prepare("SELECT id FROM departments WHERE name = ?").get(r.name);
        if (exists) { errors.push(`${r.name}：已存在，跳过`); return; }
        db.prepare("INSERT INTO departments (parent_id, name, sort_order, status) VALUES (NULL, ?, ?, 'active')").run(r.name, r.sort);
        created += 1;
      });
      // 第二遍：按名称回填上级
      rows.forEach((r) => {
        if (!r.parent) return;
        const parent = db.prepare("SELECT id FROM departments WHERE name = ?").get(r.parent);
        const self = db.prepare("SELECT id FROM departments WHERE name = ?").get(r.name);
        if (parent && self && parent.id !== self.id) db.prepare("UPDATE departments SET parent_id = ? WHERE id = ?").run(parent.id, self.id);
        else if (!parent) errors.push(`${r.name}：上级部门「${r.parent}」未找到`);
      });
    });
    trx();
    writeOperationLog(req.user, "基础平台", "批量导入部门", "department", "import", `新增${created}个`, clientIp(req));
    res.json({ created, total: rows.length, errors });
  });

  app.post("/api/import/users", requireAuth, requireRole("admin"), importUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "未上传文件" });
    let ws;
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      ws = wb.worksheets[0];
    } catch (e) { return res.status(400).json({ message: "无法解析 Excel 文件" }); }
    let created = 0; const errors = [];
    const rows = [];
    ws.eachRow((row, n) => { if (n === 1) return; const account = cellText(row, 1); if (account) rows.push({ account, name: cellText(row, 2), dept: cellText(row, 3), role: cellText(row, 4), pwd: cellText(row, 5) }); });
    const trx = db.transaction(() => {
      rows.forEach((r) => {
        if (!r.name || !r.dept || !r.role) { errors.push(`${r.account}：信息不完整`); return; }
        if (db.prepare("SELECT id FROM users WHERE account = ?").get(r.account)) { errors.push(`${r.account}：账号已存在`); return; }
        const dept = db.prepare("SELECT id FROM departments WHERE name = ?").get(r.dept);
        const role = db.prepare("SELECT id FROM roles WHERE name = ?").get(r.role);
        if (!dept) { errors.push(`${r.account}：部门「${r.dept}」未找到`); return; }
        if (!role) { errors.push(`${r.account}：角色「${r.role}」未找到`); return; }
        db.prepare("INSERT INTO users (account, password_hash, name, dept_id, role_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)")
          .run(r.account, hashPassword(r.pwd && r.pwd.length >= 6 ? r.pwd : "123456"), r.name, dept.id, role.id, now());
        created += 1;
      });
    });
    trx();
    writeOperationLog(req.user, "基础平台", "批量导入用户", "user", "import", `新增${created}个`, clientIp(req));
    res.json({ created, total: rows.length, errors });
  });

  /* ============ 角色与权限 ============ */

  app.get("/api/roles", requireAuth, requireRole("admin"), (req, res) => {
    const roles = db.prepare("SELECT * FROM roles ORDER BY id").all();
    const modules = db.prepare("SELECT * FROM modules ORDER BY sort_order").all();
    const roleModules = db.prepare("SELECT r.code AS role_code, m.code AS module_code FROM role_modules rm JOIN roles r ON r.id = rm.role_id JOIN modules m ON m.id = rm.module_id").all();
    res.json({ roles, modules, roleModules });
  });

  app.put("/api/roles/:id/modules", requireAuth, requireRole("admin"), (req, res) => {
    const role = getRoleById(req.params.id);
    if (!role) return res.status(404).json({ message: "角色不存在" });
    const moduleCodes = Array.isArray(req.body.moduleCodes) ? req.body.moduleCodes : [];
    db.transaction(() => {
      db.prepare("DELETE FROM role_modules WHERE role_id = ?").run(role.id);
      const insert = db.prepare("INSERT INTO role_modules (role_id, module_id) VALUES (?, ?)");
      moduleCodes.forEach((code) => {
        const module = db.prepare("SELECT * FROM modules WHERE code = ?").get(code);
        if (module) insert.run(role.id, module.id);
      });
    })();
    writeOperationLog(req.user, "基础平台", "配置角色菜单权限", "role", String(role.id), `${role.name}: ${moduleCodes.join(",")}`, clientIp(req));
    res.json({ ok: true, modules: modulesForRole(role.code) });
  });

  const DATA_SCOPES = ["all", "dept_sub", "dept", "self"];

  app.post("/api/roles", requireAuth, requireRole("admin"), (req, res) => {
    const { code, name, dataScope, canApprove } = req.body;
    if (!code || !/^[a-z][a-z0-9_]*$/.test(code)) return res.status(400).json({ message: "角色标识不合法（小写字母开头，仅含小写字母/数字/下划线）" });
    if (!name || !String(name).trim()) return res.status(400).json({ message: "角色名称必填" });
    if (db.prepare("SELECT 1 FROM roles WHERE code = ?").get(code)) return res.status(400).json({ message: "角色标识已存在" });
    const scope = DATA_SCOPES.includes(dataScope) ? dataScope : "self";
    const result = db.prepare("INSERT INTO roles (code, name, data_scope, can_approve, is_system) VALUES (?, ?, ?, ?, 0)")
      .run(code, String(name).trim(), scope, canApprove ? 1 : 0);
    writeOperationLog(req.user, "基础平台", "新增角色", "role", String(result.lastInsertRowid), `${name}(${code}) scope=${scope}`, clientIp(req));
    res.status(201).json({ id: result.lastInsertRowid });
  });

  app.put("/api/roles/:id", requireAuth, requireRole("admin"), (req, res) => {
    const role = getRoleById(req.params.id);
    if (!role) return res.status(404).json({ message: "角色不存在" });
    const { name, dataScope, canApprove } = req.body;
    let scope = DATA_SCOPES.includes(dataScope) ? dataScope : role.data_scope;
    let approve = canApprove ? 1 : 0;
    // 管理员角色固定为全部数据 + 可审批，避免误配置导致超管失权。
    if (role.code === "admin") { scope = "all"; approve = 1; }
    db.prepare("UPDATE roles SET name = ?, data_scope = ?, can_approve = ? WHERE id = ?")
      .run(String(name || role.name).trim(), scope, approve, role.id);
    writeOperationLog(req.user, "基础平台", "编辑角色", "role", String(role.id), `${name || role.name} scope=${scope} approve=${approve}`, clientIp(req));
    res.json({ ok: true });
  });

  app.delete("/api/roles/:id", requireAuth, requireRole("admin"), (req, res) => {
    const role = getRoleById(req.params.id);
    if (!role) return res.status(404).json({ message: "角色不存在" });
    if (role.is_system) return res.status(400).json({ message: "内置角色不可删除" });
    const used = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role_id = ?").get(role.id).c;
    if (used > 0) return res.status(400).json({ message: `该角色下还有 ${used} 名用户，不能删除` });
    db.transaction(() => {
      db.prepare("DELETE FROM role_modules WHERE role_id = ?").run(role.id);
      db.prepare("DELETE FROM roles WHERE id = ?").run(role.id);
    })();
    writeOperationLog(req.user, "基础平台", "删除角色", "role", String(role.id), role.name, clientIp(req));
    res.json({ ok: true });
  });

  /* ============ 流程配置 ============ */

  app.get("/api/workflows", requireAuth, requireRole("admin"), (req, res) => {
    const workflows = db.prepare("SELECT * FROM workflow_definitions ORDER BY business_type, version DESC").all();
    workflows.forEach((workflow) => {
      workflow.nodes = db.prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order, id").all(workflow.id);
      workflow.edges = db.prepare("SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY sort_order, id").all(workflow.id);
    });
    res.json(workflows);
  });

  app.post("/api/workflows", requireAuth, requireRole("admin"), (req, res) => {
    const { businessType, name, nodes, edges } = req.body;
    if (!businessType || !name || !Array.isArray(nodes) || nodes.length === 0) return res.status(400).json({ message: "流程配置不完整" });
    const version = (db.prepare("SELECT MAX(version) AS version FROM workflow_definitions WHERE business_type = ?").get(businessType).version || 0) + 1;
    const id = db.transaction(() => {
      db.prepare("UPDATE workflow_definitions SET enabled = 0 WHERE business_type = ?").run(businessType);
      const result = db.prepare("INSERT INTO workflow_definitions (business_type, name, version, enabled, created_at) VALUES (?, ?, ?, 1, ?)")
        .run(businessType, name, version, now());
      const insertNode = db.prepare(`INSERT INTO workflow_nodes
        (workflow_id, node_name, approver_type, approver_value, condition_json, approve_mode, sort_order, node_type, node_kind, pos_x, pos_y, allow_terminal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      // 关键：前端临时 id 与库 id 的映射
      const idMap = {};
      nodes.forEach((node, index) => {
        const r = insertNode.run(
          result.lastInsertRowid,
          node.nodeName || node.node_name || `节点${index + 1}`,
          node.approverType || "role",
          String(node.approverValue ?? "leader"),
          JSON.stringify(node.condition || {}),
          ["single", "parallel", "countersign"].includes(node.approveMode) ? node.approveMode : "single",
          index + 1,
          String(node.nodeType || ""),
          ["start", "task", "end"].includes(node.nodeKind) ? node.nodeKind : "task",
          Number.isFinite(+node.posX) ? +node.posX : 0,
          Number.isFinite(+node.posY) ? +node.posY : 0,
          node.allowTerminal ? 1 : 0,
        );
        if (node.id != null) idMap[String(node.id)] = r.lastInsertRowid;
        idMap[String(index)] = idMap[String(index)] || r.lastInsertRowid; // 顺序备用映射
      });
      // 入边：若前端送了 edges，按 idMap 转 ID 落库；否则回退到 1→2→…→末→null
      const insertEdge = db.prepare("INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, label, condition_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
      if (Array.isArray(edges) && edges.length) {
        edges.forEach((e, i) => {
          const from = idMap[String(e.from)];
          const to = e.to == null || e.to === "" ? null : idMap[String(e.to)];
          if (!from) return;
          insertEdge.run(result.lastInsertRowid, from, to, String(e.label || ""), JSON.stringify(e.condition || {}), e.sortOrder || i);
        });
      } else {
        // 回退：线性串联
        const rows = db.prepare("SELECT id FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order, id").all(result.lastInsertRowid);
        rows.forEach((r, i) => insertEdge.run(result.lastInsertRowid, r.id, rows[i + 1] ? rows[i + 1].id : null, "", "{}", i));
        if (rows.length) db.prepare("UPDATE workflow_nodes SET allow_terminal = 1 WHERE id = ?").run(rows[rows.length - 1].id);
      }
      writeOperationLog(req.user, "基础平台", "新增流程配置", "workflow", String(result.lastInsertRowid), `${name} v${version}`, clientIp(req));
      return result.lastInsertRowid;
    })();
    const workflow = db.prepare("SELECT * FROM workflow_definitions WHERE id = ?").get(id);
    workflow.nodes = db.prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY sort_order").all(id);
    workflow.edges = db.prepare("SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY sort_order").all(id);
    res.status(201).json(workflow);
  });

  app.post("/api/workflows/:id/enable", requireAuth, requireRole("admin"), (req, res) => {
    const workflow = db.prepare("SELECT * FROM workflow_definitions WHERE id = ?").get(req.params.id);
    if (!workflow) return res.status(404).json({ message: "流程不存在" });
    db.transaction(() => {
      db.prepare("UPDATE workflow_definitions SET enabled = 0 WHERE business_type = ?").run(workflow.business_type);
      db.prepare("UPDATE workflow_definitions SET enabled = 1 WHERE id = ?").run(workflow.id);
    })();
    writeOperationLog(req.user, "基础平台", "启用流程版本", "workflow", String(workflow.id), `${workflow.name} v${workflow.version}`, clientIp(req));
    res.json({ ok: true });
  });
}

module.exports = { register };
