const { db, now } = require("../db");

// 天数计算：纯日期走"含首尾整天数"；带 T 时分则按 8 小时 / 天换算并就近 0.5 取整（最少 0.5 天）
// 必须与前端 dayDiff 保持一致，否则年假扣减数与表单提示对不上号
function dayDiff(start, end) {
  if (!start || !end) return 0;
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  if (dateOnly.test(String(start)) && dateOnly.test(String(end))) {
    return Math.max(0, Math.floor((e - s) / 86400000) + 1);
  }
  const hours = Math.max(0, (e - s) / 3600000);
  return Math.max(0.5, Math.round((hours / 8) * 2) / 2);
}

function yearOf(dateStr) {
  if (!dateStr) return new Date().getFullYear();
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return new Date().getFullYear();
  return d.getFullYear();
}

function getBalance(userId, year) {
  const row = db.prepare("SELECT * FROM annual_leave_balance WHERE user_id = ? AND year = ?").get(userId, year);
  if (row) return { ...row, available_days: Number((row.total_days - row.used_days).toFixed(2)) };
  return { user_id: userId, year, total_days: 0, used_days: 0, available_days: 0 };
}

function setTotal(userId, year, totalDays) {
  const cur = db.prepare("SELECT used_days FROM annual_leave_balance WHERE user_id = ? AND year = ?").get(userId, year);
  if (cur) {
    db.prepare("UPDATE annual_leave_balance SET total_days = ?, updated_at = ? WHERE user_id = ? AND year = ?")
      .run(Number(totalDays), now(), userId, year);
  } else {
    db.prepare("INSERT INTO annual_leave_balance (user_id, year, total_days, used_days, updated_at) VALUES (?, ?, ?, 0, ?)")
      .run(userId, year, Number(totalDays), now());
  }
  return getBalance(userId, year);
}

// 申请提交时校验 + 扣减；不够时抛错由路由捕获返回 400
function reserve(userId, year, days) {
  const bal = getBalance(userId, year);
  if (bal.total_days <= 0) {
    const err = new Error(`未设置 ${year} 年年假额度，请联系管理员录入`);
    err.code = 400; throw err;
  }
  if (days > bal.available_days) {
    const err = new Error(`年假可用 ${bal.available_days} 天，本次申请 ${days} 天超额`);
    err.code = 400; throw err;
  }
  db.prepare(`
    INSERT INTO annual_leave_balance (user_id, year, total_days, used_days, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, year) DO UPDATE SET used_days = used_days + ?, updated_at = ?
  `).run(userId, year, bal.total_days, days, now(), days, now());
}

// 驳回 / 撤回时回补
function restore(userId, year, days) {
  db.prepare("UPDATE annual_leave_balance SET used_days = MAX(0, used_days - ?), updated_at = ? WHERE user_id = ? AND year = ?")
    .run(days, now(), userId, year);
}

// 业务封装：根据请求行判断是否需要扣 / 退年假
function reserveForRequest(row, applicantId) {
  if (row.type !== "leave" || row.category !== "年假") return;
  const days = dayDiff(row.start_date, row.end_date);
  if (days <= 0) return;
  reserve(applicantId, yearOf(row.start_date), days);
}

function restoreForRequest(row, applicantId) {
  if (!row || row.type !== "leave" || row.category !== "年假") return;
  const days = dayDiff(row.start_date, row.end_date);
  if (days <= 0) return;
  restore(applicantId, yearOf(row.start_date), days);
}

module.exports = { dayDiff, yearOf, getBalance, setTotal, reserve, restore, reserveForRequest, restoreForRequest };
