const ExcelJS = require("exceljs");

const { db } = require("../db");
const { requestTypeText, businessStatusText } = require("../core/util");
const { requireAuth } = require("../core/auth");
const { requestVisibleWhere, documentVisibleWhere } = require("../core/permissions");

async function sendWorkbook(res, workbook, filename) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  await workbook.xlsx.write(res);
  res.end();
}

const REQUEST_GROUP = {
  person: { col: "u.name", label: "申请人" },
  dept: { col: "d.name", label: "部门" },
  type: { col: "r.type", label: "类型" },
  category: { col: "r.category", label: "类别" },
  month: { col: "substr(r.start_date,1,7)", label: "月份" },
  status: { col: "r.status", label: "状态" },
};

function buildRequestStats(user, query) {
  const visible = requestVisibleWhere(user, "r");
  const params = [...visible.params];
  const group = REQUEST_GROUP[query.groupBy] || REQUEST_GROUP.category;
  let where = visible.sql;
  if (query.type) { where += " AND r.type = ?"; params.push(query.type); }
  if (query.from) { where += " AND r.start_date >= ?"; params.push(query.from); }
  if (query.to) { where += " AND r.start_date <= ?"; params.push(query.to); }
  const rows = db.prepare(`
    SELECT ${group.col} AS key,
           COUNT(*) AS count,
           SUM(CAST(julianday(r.end_date) - julianday(r.start_date) + 1 AS INTEGER)) AS days
    FROM requests r
    JOIN users u ON u.id = r.applicant_id
    JOIN departments d ON d.id = r.dept_id
    WHERE ${where}
    GROUP BY key ORDER BY count DESC
  `).all(...params);
  return { label: group.label, rows };
}

function register(app) {
  /* ============ 统计分析 ============ */

  app.get("/api/stats/requests", requireAuth, (req, res) => {
    res.json(buildRequestStats(req.user, req.query));
  });

  app.get("/api/stats/documents", requireAuth, (req, res) => {
    const where = documentVisibleWhere(req.user);
    const params = [...where.params];
    let sql = where.sql;
    if (req.query.from) { sql += " AND created_at >= ?"; params.push(req.query.from); }
    if (req.query.to) { sql += " AND created_at <= ?"; params.push(`${req.query.to}T23:59:59`); }
    const byType = db.prepare(`SELECT type AS key, COUNT(*) AS count FROM documents WHERE ${sql} GROUP BY type`).all(...params);
    const byMonth = db.prepare(`SELECT substr(created_at,1,7) AS key, type, COUNT(*) AS count FROM documents WHERE ${sql} GROUP BY key, type ORDER BY key`).all(...params);
    res.json({ byType, byMonth });
  });

  /* ============ 导出 ============ */

  app.get("/api/export/requests.xlsx", requireAuth, async (req, res) => {
    const visible = requestVisibleWhere(req.user, "r");
    const params = [...visible.params];
    let where = visible.sql;
    if (req.query.type) { where += " AND r.type = ?"; params.push(req.query.type); }
    if (req.query.status) { where += " AND r.status = ?"; params.push(req.query.status); }
    if (req.query.from) { where += " AND r.start_date >= ?"; params.push(req.query.from); }
    if (req.query.to) { where += " AND r.start_date <= ?"; params.push(req.query.to); }
    const rows = db.prepare(`
      SELECT r.id, r.type, r.category, u.name AS applicant_name, d.name AS dept_name, r.start_date, r.end_date, r.reason, r.status, r.current_node, r.apply_time, r.created_at
      FROM requests r JOIN users u ON u.id = r.applicant_id JOIN departments d ON d.id = r.dept_id
      WHERE ${where} ORDER BY r.created_at DESC
    `).all(...params);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("业务申请");
    sheet.columns = [
      { header: "编号", key: "id", width: 8 },
      { header: "类型", key: "type", width: 10 },
      { header: "类别", key: "category", width: 14 },
      { header: "申请人", key: "applicant_name", width: 12 },
      { header: "部门", key: "dept_name", width: 16 },
      { header: "开始日期", key: "start_date", width: 14 },
      { header: "结束日期", key: "end_date", width: 14 },
      { header: "事由", key: "reason", width: 30 },
      { header: "状态", key: "status", width: 10 },
      { header: "当前节点", key: "current_node", width: 16 },
      { header: "申请时间", key: "apply_time", width: 22 },
    ];
    rows.forEach((row) => sheet.addRow({ ...row, type: requestTypeText(row.type), status: businessStatusText(row.status) }));
    await sendWorkbook(res, workbook, "业务申请统计.xlsx");
  });

  app.get("/api/export/documents.xlsx", requireAuth, async (req, res) => {
    const where = documentVisibleWhere(req.user);
    const params = [...where.params];
    let sql = where.sql;
    if (req.query.type) { sql += " AND type = ?"; params.push(req.query.type); }
    if (req.query.status) { sql += " AND status = ?"; params.push(req.query.status); }
    const rows = db.prepare(`
      SELECT id, type, no, title, source_unit, secret, urgency, owner_dept, readers, main_send, cc_send, seal_no, status, current_node, doc_date, created_at
      FROM documents WHERE ${sql} ORDER BY created_at DESC
    `).all(...params);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("公文台账");
    sheet.columns = [
      { header: "编号", key: "id", width: 8 },
      { header: "类型", key: "type", width: 8 },
      { header: "文号", key: "no", width: 22 },
      { header: "标题", key: "title", width: 32 },
      { header: "来文单位", key: "source_unit", width: 20 },
      { header: "密级", key: "secret", width: 8 },
      { header: "紧急程度", key: "urgency", width: 10 },
      { header: "承办科室", key: "owner_dept", width: 16 },
      { header: "传阅范围", key: "readers", width: 24 },
      { header: "主送", key: "main_send", width: 18 },
      { header: "抄送", key: "cc_send", width: 18 },
      { header: "用印登记", key: "seal_no", width: 14 },
      { header: "状态", key: "status", width: 10 },
      { header: "当前节点", key: "current_node", width: 14 },
      { header: "成文日期", key: "doc_date", width: 14 },
    ];
    rows.forEach((row) => sheet.addRow({ ...row, status: businessStatusText(row.status) }));
    await sendWorkbook(res, workbook, "公文台账.xlsx");
  });

  app.get("/api/export/stats-requests.xlsx", requireAuth, async (req, res) => {
    const { label, rows } = buildRequestStats(req.user, req.query);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("业务统计");
    sheet.columns = [
      { header: label, key: "key", width: 22 },
      { header: "数量", key: "count", width: 12 },
      { header: "合计天数", key: "days", width: 12 },
    ];
    rows.forEach((row) => sheet.addRow(row));
    await sendWorkbook(res, workbook, `业务统计-按${label}.xlsx`);
  });

  // 收发文统计导出：按类型 + 按月份两张 sheet
  app.get("/api/export/stats-documents.xlsx", requireAuth, async (req, res) => {
    const where = documentVisibleWhere(req.user);
    const params = [...where.params];
    let sql = where.sql;
    if (req.query.from) { sql += " AND created_at >= ?"; params.push(req.query.from); }
    if (req.query.to) { sql += " AND created_at <= ?"; params.push(`${req.query.to}T23:59:59`); }
    const byType = db.prepare(`SELECT type AS key, COUNT(*) AS count FROM documents WHERE ${sql} GROUP BY type ORDER BY type`).all(...params);
    const byMonth = db.prepare(`SELECT substr(created_at,1,7) AS month, type, COUNT(*) AS count FROM documents WHERE ${sql} GROUP BY month, type ORDER BY month, type`).all(...params);
    const workbook = new ExcelJS.Workbook();
    const s1 = workbook.addWorksheet("按类型");
    s1.columns = [{ header: "类型", key: "key", width: 12 }, { header: "数量", key: "count", width: 12 }];
    byType.forEach((row) => s1.addRow(row));
    const s2 = workbook.addWorksheet("按月份");
    s2.columns = [{ header: "月份", key: "month", width: 14 }, { header: "类型", key: "type", width: 12 }, { header: "数量", key: "count", width: 12 }];
    byMonth.forEach((row) => s2.addRow(row));
    await sendWorkbook(res, workbook, "收发文统计.xlsx");
  });
}

module.exports = { register };
