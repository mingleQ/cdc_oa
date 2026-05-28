const { db, now } = require("../db");
const { pageParams, clientIp } = require("../core/util");
const { requireAuth, requireRole } = require("../core/auth");
const { requestVisibleWhere, documentVisibleWhere } = require("../core/permissions");
const { writeOperationLog } = require("../core/audit");

function register(app) {
  /* ============ 工作台 ============ */

  app.get("/api/dashboard", requireAuth, (req, res) => {
    const visible = requestVisibleWhere(req.user, "requests");
    const myPending = db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status='pending' AND current_approver_id = ?").get(req.user.id).c;
    const pendingRequests = db.prepare(`SELECT COUNT(*) AS c FROM requests WHERE status='pending' AND ${visible.sql}`).get(...visible.params).c;
    const approvedRequests = db.prepare(`SELECT COUNT(*) AS c FROM requests WHERE status='approved' AND ${visible.sql}`).get(...visible.params).c;
    const docWhere = documentVisibleWhere(req.user);
    const documents = db.prepare(`SELECT COUNT(*) AS c FROM documents WHERE ${docWhere.sql}`).get(...docWhere.params).c;
    const unread = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0").get(req.user.id).c;
    const notices = db.prepare(`
      SELECT n.*, u.name AS created_by_name
      FROM notices n LEFT JOIN users u ON u.id = n.created_by
      ORDER BY n.published_at DESC, n.id DESC LIMIT 5
    `).all();
    res.json({ stats: { pendingRequests, approvedRequests, documents, myPending, unread }, notices });
  });

  /* ============ 通知公告（仅管理员维护，全员可见） ============ */

  app.get("/api/notices", requireAuth, (req, res) => {
    const params = [];
    let cond = "WHERE 1=1";
    if (req.query.keyword) {
      cond += " AND (n.title LIKE ? OR n.content LIKE ?)";
      const k = `%${req.query.keyword}%`;
      params.push(k, k);
    }
    const total = db.prepare(`SELECT COUNT(*) AS c FROM notices n ${cond}`).get(...params).c;
    const { page, pageSize, limit, offset } = pageParams(req);
    const items = db.prepare(`
      SELECT n.*, u.name AS created_by_name
      FROM notices n LEFT JOIN users u ON u.id = n.created_by
      ${cond} ORDER BY n.published_at DESC, n.id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    res.json({ items, total, page, pageSize });
  });

  app.post("/api/notices", requireAuth, requireRole("admin"), (req, res) => {
    const { title, scope, content, publishedAt } = req.body;
    if (!title || !scope || !content) return res.status(400).json({ message: "标题、范围与正文不能为空" });
    const at = publishedAt || now().slice(0, 10);
    const r = db.prepare(`
      INSERT INTO notices (title, scope, content, published_at, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(title, scope, content, at, req.user.id, now());
    writeOperationLog(req.user, "通知公告", "发布", "notice", String(r.lastInsertRowid), title, clientIp(req));
    res.status(201).json(db.prepare(`
      SELECT n.*, u.name AS created_by_name FROM notices n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?
    `).get(r.lastInsertRowid));
  });

  app.put("/api/notices/:id", requireAuth, requireRole("admin"), (req, res) => {
    const notice = db.prepare("SELECT * FROM notices WHERE id = ?").get(req.params.id);
    if (!notice) return res.status(404).json({ message: "公告不存在" });
    const { title, scope, content, publishedAt } = req.body;
    if (!title || !scope || !content) return res.status(400).json({ message: "标题、范围与正文不能为空" });
    db.prepare(`
      UPDATE notices SET title = ?, scope = ?, content = ?, published_at = ?, updated_at = ? WHERE id = ?
    `).run(title, scope, content, publishedAt || notice.published_at, now(), req.params.id);
    writeOperationLog(req.user, "通知公告", "编辑", "notice", String(req.params.id), title, clientIp(req));
    res.json(db.prepare(`
      SELECT n.*, u.name AS created_by_name FROM notices n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?
    `).get(req.params.id));
  });

  app.delete("/api/notices/:id", requireAuth, requireRole("admin"), (req, res) => {
    const notice = db.prepare("SELECT * FROM notices WHERE id = ?").get(req.params.id);
    if (!notice) return res.status(404).json({ message: "公告不存在" });
    db.prepare("DELETE FROM notices WHERE id = ?").run(req.params.id);
    writeOperationLog(req.user, "通知公告", "删除", "notice", String(req.params.id), notice.title, clientIp(req));
    res.json({ ok: true });
  });

  /* ============ 消息通知 ============ */

  app.get("/api/notifications", requireAuth, (req, res) => {
    const onlyUnread = req.query.unread === "1";
    const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ${onlyUnread ? "AND is_read = 0" : ""} ORDER BY id DESC LIMIT 100`).all(req.user.id);
    const unread = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0").get(req.user.id).c;
    res.json({ items: rows, unread });
  });

  app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
    db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  app.post("/api/notifications/read-all", requireAuth, (req, res) => {
    db.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0").run(req.user.id);
    res.json({ ok: true });
  });

  /* ============ 日志 ============ */

  app.get("/api/logs/operations", requireAuth, requireRole("admin"), (req, res) => {
    const params = [];
    let cond = "WHERE 1=1";
    if (req.query.keyword) { cond += " AND (operator_name LIKE ? OR module_name LIKE ? OR action LIKE ? OR content LIKE ?)"; const k = `%${req.query.keyword}%`; params.push(k, k, k, k); }
    if (req.query.from) { cond += " AND created_at >= ?"; params.push(req.query.from); }
    if (req.query.to) { cond += " AND created_at <= ?"; params.push(`${req.query.to}T23:59:59`); }
    const total = db.prepare(`SELECT COUNT(*) AS c FROM operation_logs ${cond}`).get(...params).c;
    const { page, pageSize, limit, offset } = pageParams(req);
    const items = db.prepare(`SELECT * FROM operation_logs ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ items, total, page, pageSize });
  });

  app.get("/api/logs/login", requireAuth, requireRole("admin"), (req, res) => {
    const params = [];
    let cond = "WHERE 1=1";
    if (req.query.keyword) { cond += " AND (account LIKE ? OR ip LIKE ?)"; const k = `%${req.query.keyword}%`; params.push(k, k); }
    if (req.query.from) { cond += " AND login_time >= ?"; params.push(req.query.from); }
    if (req.query.to) { cond += " AND login_time <= ?"; params.push(`${req.query.to}T23:59:59`); }
    const total = db.prepare(`SELECT COUNT(*) AS c FROM login_logs ${cond}`).get(...params).c;
    const { page, pageSize, limit, offset } = pageParams(req);
    const items = db.prepare(`SELECT * FROM login_logs ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ items, total, page, pageSize });
  });

  /* ============ 健康检查 ============ */

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, time: now() });
  });
}

module.exports = { register };
