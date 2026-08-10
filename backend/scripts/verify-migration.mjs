// #86: 旧 chatban.db 単一ファイル → 管理DB + プロジェクトDB への移行が
// データを失わないことを確認する。実データではなくコピーに対して走らせること。
// 使い方: DB_PATH=<旧db> CHATBAN_DATA_DIR=<出力先> node scripts/verify-migration.mjs
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

const legacyPath = process.env.DB_PATH;
const dataDir = process.env.CHATBAN_DATA_DIR;
if (!legacyPath || !dataDir) {
  console.error("DB_PATH と CHATBAN_DATA_DIR を指定してください");
  process.exit(1);
}

// 移行前の実数を数えておく
const before = {};
{
  const src = new Database(legacyPath, { readonly: true });
  const tables = src
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  for (const t of tables) before[t] = src.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  src.close();
}

const { migrateLegacyDbIfNeeded, listProjects, projectDb, admin, activeProjectId } = await import("../src/store.js");
migrateLegacyDbIfNeeded();

const projects = listProjects();
const pid = activeProjectId();
const pdb = projectDb(pid);

const after = {};
for (const t of pdb
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((r) => r.name)) {
  after[t] = pdb.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
}
const adminLlm = admin.prepare("SELECT COUNT(*) AS c FROM llm_calls").get().c;
const adminSettings = admin.prepare("SELECT COUNT(*) AS c FROM settings").get().c;

console.log(`プロジェクト: ${projects.map((p) => `#${p.id} ${p.name} (${p.file})`).join(", ")}`);
console.log(`アクティブ  : #${pid}`);
console.log(`旧ファイル残存: ${existsSync(legacyPath) ? "あり (移動できていない!)" : "なし (移動済み)"}`);
console.log("");
console.log("テーブル              移行前 -> 移行後");
let ng = 0;
// projects/project_members は project_id 方式を試した名残の空テーブル。移行で落とすので対象外
const DROPPED = new Set(["projects", "project_members"]);
for (const t of Object.keys(before).sort()) {
  if (DROPPED.has(t)) continue;
  const dest = t === "llm_calls" ? adminLlm : t === "settings" ? adminSettings : after[t];
  const where = t === "llm_calls" || t === "settings" ? " (管理DB)" : "";
  // settings は移行自体が project.active を書き足すので「減っていないこと」を見る
  const ok = t === "settings" ? dest >= before[t] : dest === before[t];
  if (!ok) ng++;
  console.log(`  ${t.padEnd(20)} ${String(before[t]).padStart(5)} -> ${String(dest ?? "-").padStart(5)}${where}  ${ok ? "OK" : "NG"}`);
}

// 中身のサンプル確認 (件数だけでなく実データが読めるか)
const t = pdb.prepare("SELECT id, title, status, assignee FROM tasks ORDER BY id DESC LIMIT 3").all();
console.log("");
console.log("直近タスク:");
for (const r of t) console.log(`  #${r.id} [${r.status}] ${r.assignee ?? "-"} ${r.title}`);
const ctx = pdb.prepare("SELECT text FROM project_context WHERE id = 1").get();
console.log(`前提情報: ${ctx ? ctx.text.length + "文字" : "なし"}`);
console.log(`要約カード: ${pdb.prepare("SELECT COUNT(*) AS c FROM summary_cards").get().c}枚`);

console.log("");
console.log(ng === 0 ? "=> 件数の欠落なし" : `=> ${ng}テーブルで件数不一致`);
process.exit(ng === 0 ? 0 : 1);
