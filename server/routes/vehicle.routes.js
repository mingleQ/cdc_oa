const { db, now } = require("../db");
const { clientIp } = require("../core/util");
const { requireAuth, requireRole } = require("../core/auth");
const { requestVisibleWhere } = require("../core/permissions");
const { writeOperationLog } = require("../core/audit");
const { getRequestById } = require("../repository");

function register(app) {
  /* ============ 车辆与行车记录 ============ */

  app.get("/api/vehicles", requireAuth, (req, res) => {
    res.json(db.prepare("SELECT * FROM vehicles ORDER BY id").all());
  });

  app.post("/api/vehicles", requireAuth, requireRole("admin"), (req, res) => {
    const { plateNo, driver, status, mileage } = req.body;
    if (!plateNo || !driver) return res.status(400).json({ message: "车牌和驾驶员必填" });
    const dup = db.prepare("SELECT id FROM vehicles WHERE plate_no = ?").get(plateNo);
    if (dup) return res.status(400).json({ message: "该车牌已存在" });
    const result = db.prepare("INSERT INTO vehicles (plate_no, driver, status, mileage, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(plateNo, driver, status || "空闲", Number(mileage || 0), now());
    writeOperationLog(req.user, "用车管理", "新增车辆", "vehicle", String(result.lastInsertRowid), plateNo, clientIp(req));
    res.status(201).json(db.prepare("SELECT * FROM vehicles WHERE id = ?").get(result.lastInsertRowid));
  });

  app.put("/api/vehicles/:id", requireAuth, requireRole("admin"), (req, res) => {
    const vehicle = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(req.params.id);
    if (!vehicle) return res.status(404).json({ message: "车辆不存在" });
    const { plateNo, driver, status, mileage } = req.body;
    if (!plateNo || !driver) return res.status(400).json({ message: "车牌和驾驶员必填" });
    if (plateNo !== vehicle.plate_no) {
      const dup = db.prepare("SELECT id FROM vehicles WHERE plate_no = ? AND id <> ?").get(plateNo, req.params.id);
      if (dup) return res.status(400).json({ message: "该车牌已存在" });
    }
    db.prepare("UPDATE vehicles SET plate_no = ?, driver = ?, status = ?, mileage = ?, updated_at = ? WHERE id = ?")
      .run(plateNo, driver, status || vehicle.status || "空闲", Number(mileage || 0), now(), req.params.id);
    writeOperationLog(req.user, "用车管理", "编辑车辆", "vehicle", String(req.params.id), plateNo, clientIp(req));
    res.json(db.prepare("SELECT * FROM vehicles WHERE id = ?").get(req.params.id));
  });

  app.delete("/api/vehicles/:id", requireAuth, requireRole("admin"), (req, res) => {
    const vehicle = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(req.params.id);
    if (!vehicle) return res.status(404).json({ message: "车辆不存在" });
    const used = db.prepare("SELECT COUNT(*) AS c FROM vehicle_records WHERE vehicle_id = ?").get(req.params.id).c;
    if (used) return res.status(400).json({ message: `已有 ${used} 条行车记录引用该车辆，无法删除（可改为「停用」）` });
    db.prepare("DELETE FROM vehicles WHERE id = ?").run(req.params.id);
    writeOperationLog(req.user, "用车管理", "删除车辆", "vehicle", String(req.params.id), vehicle.plate_no, clientIp(req));
    res.json({ ok: true });
  });

  app.get("/api/vehicle-records", requireAuth, (req, res) => {
    const visible = requestVisibleWhere(req.user, "requests");
    const rows = db.prepare(`
      SELECT vr.*, v.plate_no, v.driver, r.reason, u.name AS created_by_name
      FROM vehicle_records vr
      LEFT JOIN vehicles v ON v.id = vr.vehicle_id
      LEFT JOIN requests r ON r.id = vr.request_id
      LEFT JOIN users u ON u.id = vr.created_by
      WHERE vr.request_id IS NULL OR vr.request_id IN (SELECT id FROM requests WHERE ${visible.sql})
      ORDER BY vr.id DESC
    `).all(...visible.params);
    res.json(rows);
  });

  app.post("/api/vehicle-records", requireAuth, requireRole("admin", "leader"), (req, res) => {
    const { requestId, vehicleId, startMileage, endMileage, fuelLiters, returnTime, actualStartTime, fuelCount, maintainCount } = req.body;
    const vehicle = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(vehicleId);
    if (!vehicle) return res.status(400).json({ message: "车辆不存在" });
    if (requestId) {
      const request = getRequestById(requestId);
      if (!request || request.type !== "vehicle") return res.status(400).json({ message: "用车申请不存在" });
    }
    const result = db.prepare(`
      INSERT INTO vehicle_records (request_id, vehicle_id, start_mileage, end_mileage, fuel_liters, return_time, actual_start_time, fuel_count, maintain_count, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId || null, vehicleId,
      Number(startMileage || 0), Number(endMileage || 0), Number(fuelLiters || 0),
      returnTime || now(), actualStartTime || null,
      Number(fuelCount || 0), Number(maintainCount || 0),
      req.user.id, now(),
    );
    if (endMileage) db.prepare("UPDATE vehicles SET mileage = ?, status = '空闲' WHERE id = ?").run(Number(endMileage), vehicleId);
    writeOperationLog(req.user, "用车管理", "登记行车记录", "vehicle_record", String(result.lastInsertRowid), vehicle.plate_no, clientIp(req));
    res.status(201).json(db.prepare("SELECT * FROM vehicle_records WHERE id = ?").get(result.lastInsertRowid));
  });

  app.put("/api/vehicle-records/:id", requireAuth, requireRole("admin", "leader"), (req, res) => {
    const record = db.prepare("SELECT * FROM vehicle_records WHERE id = ?").get(req.params.id);
    if (!record) return res.status(404).json({ message: "行车记录不存在" });
    const { startMileage, endMileage, fuelLiters, returnTime, actualStartTime, fuelCount, maintainCount } = req.body;
    db.prepare(`
      UPDATE vehicle_records
      SET start_mileage = ?, end_mileage = ?, fuel_liters = ?, return_time = ?,
          actual_start_time = ?, fuel_count = ?, maintain_count = ?
      WHERE id = ?
    `).run(
      Number(startMileage || 0), Number(endMileage || 0), Number(fuelLiters || 0),
      returnTime || record.return_time,
      actualStartTime != null ? actualStartTime : record.actual_start_time,
      Number(fuelCount != null ? fuelCount : record.fuel_count || 0),
      Number(maintainCount != null ? maintainCount : record.maintain_count || 0),
      req.params.id,
    );
    if (record.vehicle_id && endMileage) db.prepare("UPDATE vehicles SET mileage = ? WHERE id = ?").run(Number(endMileage), record.vehicle_id);
    writeOperationLog(req.user, "用车管理", "编辑行车记录", "vehicle_record", String(req.params.id), `里程 ${startMileage}-${endMileage}`, clientIp(req));
    res.json(db.prepare("SELECT * FROM vehicle_records WHERE id = ?").get(req.params.id));
  });

  app.delete("/api/vehicle-records/:id", requireAuth, requireRole("admin"), (req, res) => {
    const record = db.prepare("SELECT * FROM vehicle_records WHERE id = ?").get(req.params.id);
    if (!record) return res.status(404).json({ message: "行车记录不存在" });
    db.prepare("DELETE FROM vehicle_records WHERE id = ?").run(req.params.id);
    writeOperationLog(req.user, "用车管理", "删除行车记录", "vehicle_record", String(req.params.id), "", clientIp(req));
    res.json({ ok: true });
  });
}

module.exports = { register };
