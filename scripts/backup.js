// 一致性备份脚本：使用 better-sqlite3 在线备份 API，
// 自动包含 WAL 中尚未 checkpoint 的数据，避免直接复制主库导致备份不完整。
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const root = path.resolve(__dirname, "..");
const source = process.env.OA_DB_PATH || path.join(root, "data", "oa.sqlite");
const backupDir = path.join(root, "backups");
const keep = Number(process.env.OA_BACKUP_KEEP || 30);

if (!fs.existsSync(source)) {
  console.error(`数据库不存在：${source}`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(backupDir, `oa-${stamp}.sqlite`);

(async () => {
  const db = new Database(source, { readonly: true });
  try {
    await db.backup(target);
    console.log(`备份完成：${target}`);
  } catch (error) {
    console.error("备份失败：", error.message);
    process.exit(1);
  } finally {
    db.close();
  }

  // 仅保留最近 keep 份备份
  const files = fs.readdirSync(backupDir)
    .filter((name) => /^oa-.*\.sqlite$/.test(name))
    .sort()
    .reverse();
  files.slice(keep).forEach((name) => {
    try { fs.unlinkSync(path.join(backupDir, name)); } catch (e) { /* ignore */ }
  });
})();
