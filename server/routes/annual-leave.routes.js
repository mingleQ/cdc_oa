const { db } = require("../db");
const { requireAuth, requireRole } = require("../core/auth");
const { writeOperationLog } = require("../core/audit");
const { clientIp } = require("../core/util");
const balance = require("../services/leave-balance");

function register(app) {
  // 当前用户自己看自己的年假额度（任何角色可调用）
  app.get("/api/annual-leave/me", requireAuth, (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    res.json(balance.getBalance(req.user.id, year));
  });

  // 管理员：列表全员年假台账（按年）
  app.get("/api/annual-leave", requireAuth, requireRole("admin"), (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    const params = [year];
    let where = "WHERE u.status = 'active'";
    if (req.query.keyword) {
      where += " AND (u.name LIKE ? OR u.account LIKE ?)";
      const k = `%${req.query.keyword}%`;
      params.push(k, k);
    }
    if (req.query.deptId) {
      where += " AND u.dept_id = ?";
      params.push(Number(req.query.deptId));
    }
    const rows = db.prepare(`
      SELECT u.id AS user_id, u.name, u.account, u.entry_date, d.name AS dept,
        COALESCE(ab.total_days, 0) AS total_days,
        COALESCE(ab.used_days, 0) AS used_days
      FROM users u
      JOIN departments d ON d.id = u.dept_id
      LEFT JOIN annual_leave_balance ab ON ab.user_id = u.id AND ab.year = ?
      ${where}
      ORDER BY d.sort_order, u.id
    `).all(...params);
    res.json({ year, items: rows.map((r) => ({ ...r, available_days: Number((r.total_days - r.used_days).toFixed(2)) })) });
  });

  // 管理员：设置某员工某年额度
  app.put("/api/annual-leave/:userId", requireAuth, requireRole("admin"), (req, res) => {
    const userId = Number(req.params.userId);
    const year = Number(req.body.year) || new Date().getFullYear();
    const totalDays = Number(req.body.totalDays);
    if (!Number.isFinite(totalDays) || totalDays < 0) return res.status(400).json({ message: "年假天数应为非负数" });
    const user = db.prepare("SELECT id, name FROM users WHERE id = ?").get(userId);
    if (!user) return res.status(404).json({ message: "用户不存在" });
    const after = balance.setTotal(userId, year, totalDays);
    writeOperationLog(req.user, "基础平台", "设置年假额度", "annual_leave", String(userId), `${user.name} ${year}年 ${totalDays}天`, clientIp(req));
    res.json(after);
  });

  // 管理员：批量设置（按部门或全员，简化版：传 entries=[{userId, totalDays}, year}）
  app.post("/api/annual-leave/bulk", requireAuth, requireRole("admin"), (req, res) => {
    const year = Number(req.body.year) || new Date().getFullYear();
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    let ok = 0;
    entries.forEach((e) => {
      const total = Number(e.totalDays);
      if (!e.userId || !Number.isFinite(total) || total < 0) return;
      balance.setTotal(Number(e.userId), year, total);
      ok += 1;
    });
    writeOperationLog(req.user, "基础平台", "批量设置年假", "annual_leave", "", `${year}年 共 ${ok} 人`, clientIp(req));
    res.json({ ok: true, success: ok });
  });
}

module.exports = { register };
