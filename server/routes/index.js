const path = require("path");
const { ROOT } = require("../config");

const authRoutes = require("./auth.routes");
const orgRoutes = require("./org.routes");
const systemRoutes = require("./system.routes");
const requestRoutes = require("./request.routes");
const vehicleRoutes = require("./vehicle.routes");
const documentRoutes = require("./document.routes");
const attachmentRoutes = require("./attachment.routes");
const statsRoutes = require("./stats.routes");
const engineRoutes = require("./engine.routes");
const annualLeaveRoutes = require("./annual-leave.routes");

function register(app) {
  // 按业务域依次挂载（路径互不重叠，顺序与原 routes.js 保持一致的语义）
  authRoutes.register(app);
  orgRoutes.register(app);
  systemRoutes.register(app);
  requestRoutes.register(app);
  vehicleRoutes.register(app);
  documentRoutes.register(app);
  attachmentRoutes.register(app);
  statsRoutes.register(app);
  engineRoutes.register(app);
  annualLeaveRoutes.register(app);

  // 未匹配的 /api 返回 JSON 404，其余交给前端路由
  app.use("/api", (req, res) => res.status(404).json({ message: "接口不存在" }));
  app.get("*", (req, res) => res.sendFile(path.join(ROOT, "index.html")));
}

module.exports = { register };
