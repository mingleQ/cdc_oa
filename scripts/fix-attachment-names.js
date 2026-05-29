/**
 * 一次性修复：把历史附件中被 latin1 误解析的中文文件名还原为 UTF-8。
 * 仅在确认乱码时才改写，幂等安全。可重复执行（已修复的不会再动）。
 *
 *   node scripts/fix-attachment-names.js          # 预览将要修改的记录
 *   node scripts/fix-attachment-names.js --apply  # 实际写入
 */
const { db } = require("../server/db");

const APPLY = process.argv.includes("--apply");

// 高位字符（latin1 补充区 U+0080-U+00FF），mojibake 的特征
const HAS_HIGH = /[-ÿ]/;
// 正常中日韩统一表意文字
const HAS_CJK = /[一-鿿]/;

// latin1->utf8 还原；若还原后出现替换字符说明本就不是被误解析的 UTF-8，保持原值
function tryDecode(name) {
  if (!name) return name;
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return decoded.includes("�") ? name : decoded;
  } catch {
    return name;
  }
}

// 判断是否“看起来像”被误解析的乱码：本身不含正常中文、含高位字符、且还原后能得到中文
function looksGarbled(name) {
  if (!name) return false;
  if (HAS_CJK.test(name)) return false;
  if (!HAS_HIGH.test(name)) return false;
  return HAS_CJK.test(tryDecode(name));
}

const rows = db.prepare("SELECT id, original_name FROM attachments").all();
let count = 0;
const update = db.prepare("UPDATE attachments SET original_name = ? WHERE id = ?");

for (const row of rows) {
  if (!looksGarbled(row.original_name)) continue;
  const fixed = tryDecode(row.original_name);
  count++;
  console.log(`#${row.id}\n  ${row.original_name}\n  -> ${fixed}`);
  if (APPLY) update.run(fixed, row.id);
}

console.log(`\n共 ${count} 条乱码记录${APPLY ? "已修复" : "（预览模式，加 --apply 实际写入）"}。`);
