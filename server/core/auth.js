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

// 默认具备审批能力的角色：管理员、科室负责人、中心主任、副主任。
// 注意：以角色表的 can_approve 标志为准（甲方可在「角色管理」配置），此列表仅作兜底。
const APPROVER_ROLES = ["admin", "leader", "director", "vice_director"];

function canApprove(user) {
  if (user && user.can_approve != null) return !!user.can_approve;
  return APPROVER_ROLES.includes(user?.role_code);
}

// 审批类动作统一用此中间件门控：凡是「可审批」的角色都放行，
// 具体某单据由审批引擎再校验是否本人当前节点。避免把 director/vice_director 等领导挡在门外。
function requireApprover(req, res, next) {
  if (!canApprove(req.user)) return res.status(403).json({ message: "无审批权限" });
  next();
}

module.exports = {
  signToken,
  requireAuth,
  requireRole,
  requireApprover,
  canApprove,
  APPROVER_ROLES,
};
