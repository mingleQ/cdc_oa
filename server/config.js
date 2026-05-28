const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const BACKUP_DIR = path.join(ROOT, "backups");

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.OA_DB_PATH || path.join(DATA_DIR, "oa.sqlite");

const DEFAULT_SECRET = "change-this-secret-before-production";
const RAW_SECRET = process.env.OA_JWT_SECRET || "";

// 生产环境必须配置足够强度的 JWT 密钥，否则拒绝启动，避免 token 被伪造。
if (IS_PROD && (!RAW_SECRET || RAW_SECRET === DEFAULT_SECRET || RAW_SECRET.length < 16)) {
  console.error("[启动失败] 生产环境必须设置 OA_JWT_SECRET 环境变量（长度 >= 16 的随机串）。");
  process.exit(1);
}

const JWT_SECRET = RAW_SECRET || (IS_PROD ? "" : DEFAULT_SECRET);

// 允许跨域的来源（逗号分隔）。为空时仅同源（内网部署默认）。
const CORS_ORIGINS = (process.env.OA_CORS_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

// 附件类型白名单（按扩展名）。可通过环境变量覆盖。
const ALLOWED_UPLOAD_EXTS = (process.env.OA_UPLOAD_EXTS ||
  ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.png,.jpg,.jpeg,.gif,.bmp,.webp,.zip,.rar,.7z,.ofd")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const UPLOAD_MAX_BYTES = Number(process.env.OA_UPLOAD_MAX_MB || 50) * 1024 * 1024;

// 登录失败锁定策略
const LOGIN_MAX_FAILS = Number(process.env.OA_LOGIN_MAX_FAILS || 5);
const LOGIN_LOCK_MINUTES = Number(process.env.OA_LOGIN_LOCK_MINUTES || 15);

// 通用接口限流（每窗口最大请求数）
const RATE_WINDOW_MS = Number(process.env.OA_RATE_WINDOW_MS || 60 * 1000);
const RATE_MAX = Number(process.env.OA_RATE_MAX || 600);

const TOKEN_TTL = process.env.OA_TOKEN_TTL || "8h";

module.exports = {
  ROOT,
  DATA_DIR,
  UPLOAD_DIR,
  BACKUP_DIR,
  NODE_ENV,
  IS_PROD,
  PORT,
  DB_PATH,
  JWT_SECRET,
  CORS_ORIGINS,
  ALLOWED_UPLOAD_EXTS,
  UPLOAD_MAX_BYTES,
  LOGIN_MAX_FAILS,
  LOGIN_LOCK_MINUTES,
  RATE_WINDOW_MS,
  RATE_MAX,
  TOKEN_TTL,
};
