// #232: `tasks` 時代の名残を全DBから消し切る。**移行の仕組みそのものを畳むための前段**であり、
// 畳んだあとは「バックアップから古いDBを戻したときの唯一の出口」になる。
//
// #239 で入口の番人 (旧スキーマのDBを開かずに止める refuseLegacySchema) も撤去した。
// なので古いDBを本体で開くと、`CREATE TABLE IF NOT EXISTS cards` が**空の `cards` を作り、
// 中身の入った `tasks` が取り残されて板が空に見える**。エラーは出ない。
// その状態をこのスクリプトが自動で救う: 「空の `cards` + 中身のある `tasks`」なら空側を捨てて改名する
// (`chat_messages` の `card_id` / `task_id` も同じ規則)。**両方に中身があるときだけ**人に委ねる。
//
// 実測 (2026-08-23) で分かった状態:
//   - 稼働中の10件は移行済みだが、**空の `tasks` テーブルと空の `task_id` 列が残骸として残っていた**
//     (#215 の開発中に、移行後のDBを `CREATE TABLE IF NOT EXISTS tasks` を持つ古いコードで開いたため)
//   - ゴミ箱の22件は旧スキーマのまま。コード上の復元経路は無く、手で戻す運用
//
// **設計の要点は3つ (どれもレビュー指摘 2026-08-23 で直したもの):**
//
//   1. **消す前に必ず空であることを確かめる。**行が入っていたら触らずに報告して飛ばす。
//      「たぶん空」で DROP すると、実録データが黙って消える
//   2. **確かめるのを全部先に済ませてから書く。**1つでも拒否条件があれば、**1バイトも書かずに**返す。
//      先に RENAME してから拒否すると、「触らない」と表示しながらDBは変わっている状態になる
//   3. **下見は本当に何もしない。**読み取り専用で開く。`PRAGMA journal_mode = WAL` は
//      DDLを1つも流さなくてもDBの永続設定を変えてしまう
//
//   node scripts/migrate-cards.mjs          # 下見 (読み取り専用で開く)
//   node scripts/migrate-cards.mjs --apply  # 実行 (1DBぶんをトランザクションで)
import Database from "better-sqlite3";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const DATA = process.env.CHATBAN_DATA_DIR ?? "data";

const has = (db, name) =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const count = (db, sql) => db.prepare(sql).get().c;

/** **書かずに見るだけ。**このDBに何をすべきか (`plan`) と、
 * 何があるからやってはいけないか (`refusals`) を先に全部そろえる。
 * 書くかどうかの判断は、これが返ってから1回だけ行う */
function inspect(db) {
  const plan = [];
  const refusals = [];
  const sql = [];

  const tasks = has(db, "tasks");
  const cards = has(db, "cards");

  if (tasks && !cards) {
    const n = count(db, "SELECT COUNT(*) c FROM tasks");
    // ビューは参照先の改名に追随しない (SQLiteはビュー本文を書き換えない)。
    // 壊れたビューを残すと次の SELECT で初めて落ちるので、**先に落としてから**改名する
    sql.push("DROP VIEW IF EXISTS live_tasks", "DROP VIEW IF EXISTS done_tasks");
    sql.push("ALTER TABLE tasks RENAME TO cards");
    plan.push(`tasks(${n}行) を cards へ改名`);
  } else if (tasks && cards) {
    const n = count(db, "SELECT COUNT(*) c FROM tasks");
    const m = count(db, "SELECT COUNT(*) c FROM cards");
    if (n > 0 && m > 0) {
      refusals.push(`tasks に ${n}行、cards に ${m}行 (両方に中身がある) — 人が中身を見て決めること`);
    } else if (n > 0) {
      // #239: 番人を外したあとに本体が先に開いた形。空の cards は本体が作った殻なので捨ててよい。
      // 本体が張った live_cards / done_cards は cards を参照していて、参照先が無い間は RENAME が
      // 「no such table」で落ちる (実測)。先に落とす。本体が次に開くとき張り直す
      sql.push("DROP VIEW IF EXISTS live_cards", "DROP VIEW IF EXISTS done_cards");
      sql.push("DROP TABLE cards");
      sql.push("DROP VIEW IF EXISTS live_tasks", "DROP VIEW IF EXISTS done_tasks");
      sql.push("ALTER TABLE tasks RENAME TO cards");
      plan.push(`空の cards を捨て、tasks(${n}行) を cards へ改名`);
    } else {
      sql.push("DROP TABLE tasks");
      plan.push("空の tasks テーブルを撤去");
    }
  }

  if (has(db, "chat_messages")) {
    const c = cols(db, "chat_messages");
    if (c.includes("task_id") && !c.includes("card_id")) {
      sql.push("ALTER TABLE chat_messages RENAME COLUMN task_id TO card_id");
      plan.push("chat_messages.task_id を card_id へ改名");
    } else if (c.includes("task_id") && c.includes("card_id")) {
      const n = count(db, "SELECT COUNT(*) c FROM chat_messages WHERE task_id IS NOT NULL");
      const m = count(db, "SELECT COUNT(*) c FROM chat_messages WHERE card_id IS NOT NULL");
      if (n > 0 && m > 0) {
        refusals.push(`chat_messages.task_id に ${n}件、card_id に ${m}件 (両方に値がある) — 人が中身を見て決めること`);
      } else if (n > 0) {
        // #239: 本体が空の card_id 列を足したあとの形。空側を捨てて古い列を改名する
        sql.push("ALTER TABLE chat_messages DROP COLUMN card_id");
        sql.push("ALTER TABLE chat_messages RENAME COLUMN task_id TO card_id");
        plan.push(`空の chat_messages.card_id を捨て、task_id(${n}件) を card_id へ改名`);
      } else {
        sql.push("ALTER TABLE chat_messages DROP COLUMN task_id");
        plan.push("空の chat_messages.task_id 列を撤去");
      }
    }
  }

  // 古い名前のビューは残骸なので落とす (新しい名前は本体が開くときに張り直す)
  for (const v of ["live_tasks", "done_tasks"]) {
    if (has(db, v) && !sql.includes(`DROP VIEW IF EXISTS ${v}`)) {
      sql.push(`DROP VIEW IF EXISTS ${v}`);
      plan.push(`古いビュー ${v} を撤去`);
    }
  }

  return { plan, refusals, sql };
}

function handle(path) {
  // 下見は読み取り専用で開く。**開くだけでDBを変えない**ため
  const db = new Database(path, APPLY ? {} : { readonly: true });
  try {
    const { plan, refusals, sql } = inspect(db);

    // **拒否条件が1つでもあれば、1バイトも書かずに返す**
    if (refusals.length > 0) return { plan, refusals, applied: false };
    if (!APPLY || sql.length === 0) return { plan, refusals, applied: false };

    // 途中で落ちたら全部巻き戻す。中途半端に移行されたDBがいちばん厄介
    db.transaction(() => {
      for (const stmt of sql) db.exec(stmt);
    })();
    return { plan, refusals, applied: true };
  } finally {
    db.close();
  }
}

const targets = [];
for (const dir of [join(DATA, "projects"), join(DATA, "trash")]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) if (f.endsWith(".db")) targets.push(join(dir, f));
}

console.log(APPLY ? "=== 実行 ===" : "=== 下見 (読み取り専用。--apply で実行) ===");
let touched = 0;
let refused = 0;
for (const p of targets) {
  const { plan, refusals } = handle(p);
  if (plan.length === 0 && refusals.length === 0) continue;
  if (refusals.length > 0) refused++;
  else touched++;
  console.log(`\n${p}`);
  for (const r of refusals) console.log(`  !! ${r}`);
  if (refusals.length > 0 && plan.length > 0) {
    console.log("  -- 拒否条件があるので、下記は**実行していない**:");
  }
  for (const n of plan) console.log(`  - ${n}`);
}
console.log(`\n対象 ${targets.length} / 変更あり ${touched} / 中身が在って飛ばした ${refused}`);
if (refused > 0) process.exitCode = 1;
