const { db, now } = require("../db");
const { clientIp, hashPassword, verifyPassword, publicUser, modulesForRole } = require("../core/util");
const { signToken, requireAuth } = require("../core/auth");
const { loginLockedMinutes, recordLoginFail, clearLoginFail } = require("../core/security");
const { writeOperationLog } = require("../core/audit");
const { getUserByAccount } = require("../repository");

function register(app) {
  /* ============ 认证 ============ */

  app.post("/api/auth/login", (req, res) => {
    const { account, password } = req.body;
    const acc = account || "";
    const locked = loginLockedMinutes(acc);
    if (locked > 0) {
      db.prepare("INSERT INTO login_logs (user_id, account, login_time, ip, result, reason) VALUES (?, ?, ?, ?, ?, ?)")
        .run(null, acc, now(), clientIp(req), "失败", "账号已锁定");
      return res.status(429).json({ message: `登录失败次数过多，账号已锁定，请 ${locked} 分钟后再试` });
    }
    const user = getUserByAccount(acc);
    const ok = !!user && user.status === "active" && verifyPassword(password, user.password_hash);
    db.prepare("INSERT INTO login_logs (user_id, account, login_time, ip, result, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run(user?.id || null, acc, now(), clientIp(req), ok ? "成功" : "失败", ok ? "" : "账号、密码或状态错误");
    if (!ok) {
      recordLoginFail(acc);
      return res.status(401).json({ message: "账号或密码错误" });
    }
    clearLoginFail(acc);
    writeOperationLog(user, "基础平台", "登录系统", "user", String(user.id), `${user.name} 登录系统`, clientIp(req));
    res.json({ token: signToken(user), user: publicUser(user), modules: modulesForRole(user.role_code) });
  });

  app.get("/api/me", requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user), modules: modulesForRole(req.user.role_code) });
  });

  app.post("/api/me/password", requireAuth, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ message: "新密码至少 6 位" });
    if (!verifyPassword(oldPassword, req.user.password_hash)) return res.status(400).json({ message: "原密码错误" });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), req.user.id);
    writeOperationLog(req.user, "基础平台", "修改密码", "user", String(req.user.id), req.user.name, clientIp(req));
    res.json({ ok: true });
  });

  // 员工查看 / 维护自己的档案：电话由本人可改；入职时间由管理员维护，只读
  app.get("/api/me/profile", requireAuth, (req, res) => {
    const u = db.prepare(`
      SELECT u.id, u.account, u.name, u.entry_date, u.phone, d.name AS dept, r.name AS role
      FROM users u JOIN departments d ON d.id = u.dept_id JOIN roles r ON r.id = u.role_id WHERE u.id = ?
    `).get(req.user.id);
    res.json(u);
  });

  app.put("/api/me/profile", requireAuth, (req, res) => {
    const { phone } = req.body;
    db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone || null, req.user.id);
    writeOperationLog(req.user, "基础平台", "更新个人资料", "user", String(req.user.id), `电话:${phone || ""}`, clientIp(req));
    res.json({ ok: true });
  });
}

module.exports = { register };
