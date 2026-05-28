const path = require("path");
const fs = require("fs");
const multer = require("multer");

const { db, now } = require("../db");
const { clientIp, today } = require("../core/util");
const { requireAuth } = require("../core/auth");
const { canAccessBusiness } = require("../core/permissions");
const { writeOperationLog } = require("../core/audit");
const { UPLOAD_DIR, ALLOWED_UPLOAD_EXTS, UPLOAD_MAX_BYTES } = require("../config");

/* ---------------- 文件上传（带类型白名单） ---------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(UPLOAD_DIR, today());
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname || "");
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
    },
  }),
  limits: { fileSize: UPLOAD_MAX_BYTES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_UPLOAD_EXTS.includes(ext)) {
      return cb(new Error(`不支持的附件类型：${ext || "未知"}`));
    }
    cb(null, true);
  },
});

function register(app) {
  /* ============ 附件 ============ */

  app.get("/api/attachments/:businessType/:businessId", requireAuth, (req, res) => {
    if (!canAccessBusiness(req.user, req.params.businessType, req.params.businessId)) return res.status(403).json({ message: "无权限查看附件" });
    res.json(db.prepare("SELECT id, original_name, mime_type, size, uploaded_by_name, created_at FROM attachments WHERE business_type = ? AND business_id = ? ORDER BY id DESC")
      .all(req.params.businessType, req.params.businessId));
  });

  app.post("/api/attachments/:businessType/:businessId", requireAuth, (req, res) => {
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ message: err.message || "上传失败" });
      if (!req.file) return res.status(400).json({ message: "未上传文件" });
      if (!canAccessBusiness(req.user, req.params.businessType, req.params.businessId)) {
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({ message: "无权限上传附件" });
      }
      const result = db.prepare(`
        INSERT INTO attachments (business_type, business_id, original_name, stored_path, mime_type, size, uploaded_by, uploaded_by_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.businessType, req.params.businessId, req.file.originalname, req.file.path, req.file.mimetype, req.file.size, req.user.id, req.user.name, now());
      writeOperationLog(req.user, "附件管理", "上传附件", req.params.businessType, String(req.params.businessId), req.file.originalname, clientIp(req));
      res.status(201).json(db.prepare("SELECT id, original_name, mime_type, size, uploaded_by_name, created_at FROM attachments WHERE id = ?").get(result.lastInsertRowid));
    });
  });

  app.get("/api/attachments/:id/download", requireAuth, (req, res) => {
    const file = db.prepare("SELECT * FROM attachments WHERE id = ?").get(req.params.id);
    if (!file) return res.status(404).json({ message: "附件不存在" });
    if (!canAccessBusiness(req.user, file.business_type, file.business_id)) return res.status(403).json({ message: "无权限下载附件" });
    if (!fs.existsSync(file.stored_path)) return res.status(404).json({ message: "附件文件丢失" });
    db.prepare("INSERT INTO attachment_downloads (attachment_id, user_id, user_name, downloaded_at) VALUES (?, ?, ?, ?)")
      .run(file.id, req.user.id, req.user.name, now());
    writeOperationLog(req.user, "附件管理", "下载附件", file.business_type, String(file.business_id), file.original_name, clientIp(req));
    res.download(file.stored_path, file.original_name);
  });

  app.get("/api/attachments/:id/preview", requireAuth, (req, res) => {
    const file = db.prepare("SELECT * FROM attachments WHERE id = ?").get(req.params.id);
    if (!file) return res.status(404).json({ message: "附件不存在" });
    if (!canAccessBusiness(req.user, file.business_type, file.business_id)) return res.status(403).json({ message: "无权限预览附件" });
    if (!fs.existsSync(file.stored_path)) return res.status(404).json({ message: "附件文件丢失" });
    if (!/^(text\/|image\/|application\/pdf)/.test(file.mime_type)) return res.status(415).json({ message: "该附件类型不支持在线预览" });
    res.type(file.mime_type).sendFile(path.resolve(file.stored_path));
  });
}

module.exports = { register };
