const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { PORT, DB_PATH, ROOT, CORS_ORIGINS, IS_PROD } = require("./config");
const { bootstrap } = require("./db");
const routes = require("./routes/index");

bootstrap();

const app = express();
app.disable("x-powered-by");

// 跨域：默认仅同源（内网部署）；如配置 OA_CORS_ORIGINS 则按白名单放行。
if (CORS_ORIGINS.length) {
  app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
} else if (!IS_PROD) {
  app.use(cors());
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:"],
      "connect-src": ["'self'"],
      "frame-src": ["'self'", "blob:"],
      "upgrade-insecure-requests": null,
    },
  },
  hsts: false,
  crossOriginResourcePolicy: { policy: "same-origin" },
}));

app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(ROOT, { index: false }));

routes.register(app);

// 统一错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || "服务器内部错误" });
});

const server = app.listen(PORT, () => {
  console.log(`贵港疾控 OA 服务已启动：http://localhost:${PORT}`);
  console.log(`数据库：${DB_PATH}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = app;
