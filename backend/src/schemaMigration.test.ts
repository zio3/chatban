import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/** #232: **`tasks` → `cards` の移行が生きていることを見る番人。**
 *
 * #215 の改名でいちばん壊れやすいのは移行そのものなのに、ここには1本もテストが無かった。
 * 2026-08-23 の改名作業で実際に踏んだ: 一括置換が SQL 文字列の中まで書き換えて
 * `if (has("cards") && !has("cards"))` / `ALTER TABLE cards RENAME TO cards` になった。
 * **型は通るし、既存のテストも全部通る** — 古いDBを開いたときにだけ、板が空に見える。
 *
 * 守りたいのは3つ:
 *   1. 古い `tasks` が `cards` に化け、**行とIDがそのまま残る** (`#112` は `#112` のまま)
 *   2. 古いビュー (`live_tasks` / `done_tasks`) が残骸として残らない
 *   3. `chat_messages.task_id` が `card_id` に付け替わる
 *
 * DBを使うのは、守りたいものがDDLそのものだから。純粋関数に切り出せる判断が無い。 */

// **実データに触らせない。**store.ts は読み込み時に管理DBを開く (foldDone.test.ts と同じ作法)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-migtest-"));
process.env.CHATBAN_DATA_DIR = dataDir;

const { ensureProjectSchema } = await import("./store.js");

/** #215 以前の姿を、**いまのスキーマから逆算して**作る。
 * 列を手で並べると本物からずれていくので、現行スキーマを一式流してから名前だけ古くする */
function legacyDb() {
  const db = new Database(":memory:");
  ensureProjectSchema(db);
  db.exec("DROP VIEW IF EXISTS live_cards; DROP VIEW IF EXISTS done_cards;");
  db.exec("ALTER TABLE cards RENAME TO tasks");
  db.exec("ALTER TABLE chat_messages RENAME COLUMN card_id TO task_id");
  db.exec("CREATE VIEW live_tasks AS SELECT * FROM tasks WHERE archived = 0;");
  db.exec("CREATE VIEW done_tasks AS SELECT * FROM tasks WHERE status = 'done';");
  return db;
}

const names = (db: Database.Database, type: "table" | "view"): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as { name: string }[]).map((r) => r.name);

test("古いDBを開くと tasks が cards になり、行もIDもそのまま残る", () => {
  const db = legacyDb();
  db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run(112, "語彙をカードに寄せる", "review");
  db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run(232, "コードの識別子から Task を消す");

  ensureProjectSchema(db);

  assert.ok(names(db, "table").includes("cards"), "cards が無い");
  assert.ok(!names(db, "table").includes("tasks"), "古い tasks が残っている");

  const rows = db.prepare("SELECT id, title, status FROM cards ORDER BY id").all();
  assert.deepEqual(rows, [
    { id: 112, title: "語彙をカードに寄せる", status: "review" },
    { id: 232, title: "コードの識別子から Task を消す", status: "todo" },
  ]);
});

test("古いビュー (live_tasks / done_tasks) は残骸として残らない", () => {
  const db = legacyDb();
  ensureProjectSchema(db);

  const views = names(db, "view");
  assert.ok(!views.includes("live_tasks"), "live_tasks が残っている");
  assert.ok(!views.includes("done_tasks"), "done_tasks が残っている");
  // 新しい名前は張り直されている (残骸を消すだけで作り直さないと、次の SELECT で落ちる)
  assert.ok(views.includes("live_cards"), "live_cards が作られていない");
});

test("chat_messages.task_id は card_id に付け替わる", () => {
  const db = legacyDb();
  db.prepare("INSERT INTO chat_messages (role, content, task_id) VALUES ('user', 'これ直して', 112)").run();

  ensureProjectSchema(db);

  const cols = (db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("card_id"), "card_id が無い");
  assert.ok(!cols.includes("task_id"), "古い task_id が残っている");
  assert.equal(db.prepare("SELECT card_id FROM chat_messages").pluck().get(), 112);
});

test("移行は何度流しても同じ結果になる (DBを開くたびに走るため)", () => {
  const db = legacyDb();
  db.prepare("INSERT INTO tasks (id, title) VALUES (1, '一度きり')").run();

  ensureProjectSchema(db);
  ensureProjectSchema(db);
  ensureProjectSchema(db);

  assert.equal(db.prepare("SELECT COUNT(*) FROM cards").pluck().get(), 1);
  assert.equal(db.prepare("SELECT title FROM cards WHERE id = 1").pluck().get(), "一度きり");
});

test("新規DB (tasks が無い) でも素通りして cards ができる", () => {
  const db = new Database(":memory:");
  ensureProjectSchema(db);

  assert.ok(names(db, "table").includes("cards"));
  assert.equal(db.prepare("SELECT COUNT(*) FROM cards").pluck().get(), 0);
});

// **`cards` が既に在るときは古い `tasks` で上書きしない** (人が手で作った側を正とする)。
// store.ts のコメントが約束していることなので、実際にそうなるか見る
test("両方が在れば cards を正として何もしない", () => {
  const db = legacyDb();
  db.prepare("INSERT INTO tasks (id, title) VALUES (1, '古い方')").run();
  db.exec("CREATE TABLE cards AS SELECT * FROM tasks WHERE 0");
  db.prepare("INSERT INTO cards (id, title) VALUES (1, '新しい方')").run();

  ensureProjectSchema(db);

  assert.equal(db.prepare("SELECT title FROM cards WHERE id = 1").pluck().get(), "新しい方");
});
