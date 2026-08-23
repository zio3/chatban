import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/** #232: **旧スキーマのDBを黙って受け入れないことを見る番人。**
 *
 * もとは `tasks` → `cards` の移行 (#215) が効くことを見ていた。2026-08-23 に
 * ローカルの全DB (稼働中10件 + ゴミ箱22件) を移行し切ったので移行コードを畳み、
 * 守るものが「移行が効くこと」から「**移行が要るDBを開かないこと**」に変わった。
 *
 * **ここを外すと、いちばん気付きにくい形で壊れる。**`CREATE TABLE IF NOT EXISTS cards` が
 * 空のテーブルを作り、データの入った `tasks` が取り残されて、板が空になったように見える。
 * エラーは出ず、テストも通り、型も通る。**古いDBを開いた人にしか見えない。**
 *
 * 移行そのものは `scripts/migrate-cards.mjs` に移した (バックアップから古いDBを戻したときの出口)。 */

// **実データに触らせない。**store.ts は読み込み時に管理DBを開く (foldDone.test.ts と同じ作法)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-schematest-"));
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
  return db;
}

const names = (db: Database.Database, type: "table" | "view"): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as { name: string }[]).map((r) => r.name);

test("旧スキーマのDBは開かずに止める (黙って空の cards を作らない)", () => {
  const db = legacyDb();
  db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run(112, "語彙をカードに寄せる");

  assert.throws(() => ensureProjectSchema(db), /tasks/);

  // **止めたあとも、元のデータに触っていないこと。**中途半端に作りかけると次が余計に難しくなる
  assert.ok(!names(db, "table").includes("cards"), "止めたはずなのに cards を作っている");
  assert.equal(db.prepare("SELECT COUNT(*) FROM tasks").pluck().get(), 1);
});

test("止めるときは、何をすればいいかを名指しで言う", () => {
  const db = legacyDb();
  // 「移行してください」だけでは、どこに何があるか分からない。**出口の名前を出す**
  assert.throws(() => ensureProjectSchema(db), /migrate-cards\.mjs/);
});

test("いまのスキーマのDBは素通りする (何度開いても同じ)", () => {
  const db = new Database(":memory:");
  ensureProjectSchema(db);
  db.prepare("INSERT INTO cards (id, title) VALUES (1, '普通のカード')").run();

  ensureProjectSchema(db);
  ensureProjectSchema(db);

  assert.equal(db.prepare("SELECT COUNT(*) FROM cards").pluck().get(), 1);
  assert.equal(db.prepare("SELECT title FROM cards WHERE id = 1").pluck().get(), "普通のカード");
  assert.ok(names(db, "view").includes("live_cards"));
});

// **`cards` が在れば、古い `tasks` が横に居ても止めない。**
// 移行し切ったDBに古いコードで触ると、空の `tasks` が復活しうる (2026-08-23 に実測。
// 稼働中10件が全部この形だった)。データは `cards` に在るので、開くのを止める理由はない
test("cards が在れば、古い tasks が残っていても開ける", () => {
  const db = new Database(":memory:");
  ensureProjectSchema(db);
  db.prepare("INSERT INTO cards (id, title) VALUES (1, '本物')").run();
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)");

  ensureProjectSchema(db); // 例外にならない

  assert.equal(db.prepare("SELECT title FROM cards WHERE id = 1").pluck().get(), "本物");
});

test("新規DBには cards が作られる", () => {
  const db = new Database(":memory:");
  ensureProjectSchema(db);

  assert.ok(names(db, "table").includes("cards"));
  assert.equal(db.prepare("SELECT COUNT(*) FROM cards").pluck().get(), 0);
  assert.ok(!names(db, "table").includes("tasks"), "新規DBに古い名前が作られている");
});
