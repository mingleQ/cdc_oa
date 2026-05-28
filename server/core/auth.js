const jwt = require("jsonwebtoken");
const { JWT_SECRET, TOKEN_TTL } = require("../config");
const { getUserById } = require("../repository");

/* ---------------- 鉴权 ---------------- */

function signToken(user) {
  return jwt.sign({ sub: user.id, roleCode: user.role_code }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ message: "未登录" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getUserById(payload.sub);
    if (!user || user.status !== "active") return res.status(401).json({ message: "账号不可用" });
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: "登录已过期" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role_code)) return res.status(403).json({ message: "无权限操作" });
    next();
  };
}

function canApprove(user) {
  if (user && user.can_approve != null) return !!user.can_approve;
  return user.role_code === "admin" || user.role_code === "leader";
}

module.exports = {
  signToken,
  requireAuth,
  requireRole,
  canApprove,
};
