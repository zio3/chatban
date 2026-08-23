// #232: `tasks` 時代の名残を全DBから消し切る。**移行の仕組みそのものを畳むための前段**。
//
// 実測 (2026-08-23) で分かった状態:
//   - 稼働中の10件は移行済みだが、**空の `tasks` テーブルと空の `task_id` 列が残骸として残っている**
//     (#215 の開発中に、移行後のDBを `CREATE TABLE IF NOT EXISTS tasks` を持つ古いコードで開いたため)
//   - `renameTasksToCards` は「tasks が在って cards が無い」ときだけ動くので、
//     **両方在るこれらのDBでは永久に発火しない**
//   - ゴミ箱の22件は旧スキーマのまま (`cards` が無い)。コード上の復元経路は無く、手で戻す運用
//
// **消す前に必ず空であることを確かめる。**行が入っていたら、そのDBは触らずに報告して飛ばす。
// 「たぶん空」で DROP すると、実録データが黙って消える。
//
//   node scripts/migrate-cards.mjs          # 下見 (何もしない)
//   node scripts/migrate-cards.mjs --apply  # 実行
import Database from "better-sqlite3";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const DATA = process.env.CHATBAN_DATA_DIR ?? "data";

const has = (db, name) =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const count = (db, t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

/** 1つのDBを見る/直す。**戻り値は「何をしたか」の記録**で、判断は全部ここに出す */
function migrate(path) {
  const notes = [];
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");

    // (1) tasks → cards。両方在るときは中身を見てから決める
    if (has(db, "tasks") && !has(db, "cards")) {
      const n = count(db, "tasks");
      if (APPLY) {
        db.exec("DROP VIEW IF EXISTS live_tasks; DROP VIEW IF EXISTS done_tasks;");
        db.exec("ALTER TABLE tasks RENAME TO cards");
      }
      notes.push(`tasks(${n}行) を cards へ改名`);
    } else if (has(db, "tasks") && has(db, "cards")) {
      const n = count(db, "tasks");
      if (n > 0) {
        notes.push(`!! tasks に ${n}行 残っている — **触らない**。人が中身を見て決めること`);
        return { notes, skipped: true };
      }
      if (APPLY) db.exec("DROP TABLE tasks");
      notes.push("空の tasks テーブルを撤去");
    }

    // (2) chat_messages.task_id → card_id
    if (has(db, "chat_messages")) {
      const c = cols(db, "chat_messages");
      if (c.includes("task_id") && !c.includes("card_id")) {
        if (APPLY) db.exec("ALTER TABLE chat_messages RENAME COLUMN task_id TO card_id");
        notes.push("chat_messages.task_id を card_id へ改名");
      } else if (c.includes("task_id") && c.includes("card_id")) {
        const n = db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE task_id IS NOT NULL").get().c;
        if (n > 0) {
          notes.push(`!! task_id が非NULLの行が ${n} — **触らない**`);
          return { notes, skipped: true };
        }
        if (APPLY) db.exec("ALTER TABLE chat_messages DROP COLUMN task_id");
        notes.push("空の chat_messages.task_id 列を撤去");
      }
    }

    // (3) 古い名前のビューは残骸なので落とす (新しい名前は本体が開くときに張り直す)
    for (const v of ["live_tasks", "done_tasks"]) {
      if (has(db, v)) {
        if (APPLY) db.exec(`DROP VIEW IF EXISTS ${v}`);
        notes.push(`古いビュー ${v} を撤去`);
      }
    }
    return { notes, skipped: false };
  } finally {
    db.close();
  }
}

const targets = [];
for (const dir of [join(DATA, "projects"), join(DATA, "trash")]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) if (f.endsWith(".db")) targets.push(join(dir, f));
}

console.log(APPLY ? "=== 実行 ===" : "=== 下見 (--apply で実行) ===");
let touched = 0;
let skipped = 0;
for (const p of targets) {
  const { notes, skipped: sk } = migrate(p);
  if (sk) skipped++;
  if (notes.length === 0) continue;
  touched++;
  console.log(`\n${p}`);
  for (const n of notes) console.log(`  - ${n}`);
}
console.log(`\n対象 ${targets.length} / 変更あり ${touched} / 中身が在って飛ばした ${skipped}`);
