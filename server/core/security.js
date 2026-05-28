const {
  LOGIN_MAX_FAILS,
  LOGIN_LOCK_MINUTES,
  RATE_WINDOW_MS,
  RATE_MAX,
} = require("../config");
const { clientIp } = require("./util");

/* ---------------- 登录失败锁定 ---------------- */

const loginFails = new Map();

function loginLockedMinutes(account) {
  const rec = loginFails.get(account);
  if (rec && rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 60000);
  return 0;
}

function recordLoginFail(account) {
  const rec = loginFails.get(account) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILS) {
    rec.until = Date.now() + LOGIN_LOCK_MINUTES * 60000;
    rec.count = 0;
  }
  loginFails.set(account, rec);
}

function clearLoginFail(account) {
  loginFails.delete(account);
}

/* ---------------- 接口限流 ---------------- */

const rateHits = new Map();

function rateLimit(req, res, next) {
  const key = clientIp(req);
  const ts = Date.now();
  let rec = rateHits.get(key);
  if (!rec || rec.reset < ts) {
    rec = { count: 0, reset: ts + RATE_WINDOW_MS };
    rateHits.set(key, rec);
  }
  rec.count += 1;
  if (rec.count > RATE_MAX) return res.status(429).json({ message: "请求过于频繁，请稍后再试" });
  next();
}

setInterval(() => {
  const ts = Date.now();
  for (const [key, rec] of rateHits) if (rec.reset < ts) rateHits.delete(key);
}, 5 * 60 * 1000).unref();

module.exports = {
  rateLimit,
  loginLockedMinutes,
  recordLoginFail,
  clearLoginFail,
};
