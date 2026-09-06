import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const one = (db: Database.Database, sql: string) => db.prepare(sql).get() as any;

/** #239: **旧スキーマのDBを入口で止める番人を撤去した**ので、バックアップから古いDBを戻して
 * 本体で開くと、空の `cards` が作られて中身の入った `tasks` が取り残される (板が空に見える。エラーは出ない)。
 *
 * 「あとで出たら単純なバグとして扱う」(zio, 2026-08-23) を成り立たせるには、
 * その状態が **`migrate-cards.mjs` 1コマンドで直る**ことが要る。ここはそれを見る番人。
 * 番人を外す代わりに出口を強くした、という対を壊さないため。 */

// **実データに触らせない。**testEnv.ts (`npm test` が --import で先に読む) が置いた隔離ディレクトリを
// そのまま使う。自前で mkdtemp すると終了時の掃除対象から外れて OS temp に残る (Codexレビュー P3)
const dataDir = process.env.CHATBAN_DATA_DIR!;
assert.ok(dataDir && dataDir.includes("chatban-test-data-"), "testEnv.ts の隔離ディレクトリが無い (npm test 経由で走らせる)");

const { ensureProjectSchema } = await import("./store.js");

const script = fileURLToPath(new URL("../scripts/migrate-cards.mjs", import.meta.url));
const backendDir = fileURLToPath(new URL("..", import.meta.url));

function run(apply: boolean) {
  return spawnSync(process.execPath, [script, ...(apply ? ["--apply"] : [])], {
    cwd: backendDir,
    env: { ...process.env, CHATBAN_DATA_DIR: dataDir },
    encoding: "utf8",
  });
}

/** 「番人を外したあとに本体が先に開いた」DBを作る:
 * 旧DB (tasks に中身) → 本体が開く → 空の cards / 空の card_id 列が足される */
function strandedDb(file: string) {
  fs.mkdirSync(path.join(dataDir, "projects"), { recursive: true });
  const db = new Database(path.join(dataDir, "projects", file));
  ensureProjectSchema(db);
  db.exec(`
    DROP VIEW IF EXISTS live_cards; DROP VIEW IF EXISTS done_cards;
    ALTER TABLE cards RENAME TO tasks;
    ALTER TABLE chat_messages RENAME COLUMN card_id TO task_id;
    INSERT INTO tasks (title) VALUES ('取り残された1件'), ('取り残された2件');
    INSERT INTO chat_messages (role, content, task_id) VALUES ('user', 'カードの話', 1);
  `);
  ensureProjectSchema(db); // 本体が開く。番人が無いので空の cards が作られる
  assert.equal(one(db, "SELECT COUNT(*) c FROM cards").c, 0, "前提: 板が空に見える状態になっていない");
  assert.equal(one(db, "SELECT COUNT(*) c FROM tasks").c, 2);
  db.close();
}

test("空の cards + 中身のある tasks は、migrate-cards.mjs --apply で1コマンドで直る", () => {
  strandedDb("1-rescue.db");

  const r = run(true);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /空の cards を捨て、tasks\(2行\) を cards へ改名/);
  assert.match(r.stdout, /task_id\(1件\) を card_id へ改名/);

  const db = new Database(path.join(dataDir, "projects", "1-rescue.db"));
  ensureProjectSchema(db); // 直したあとに本体が開いても壊れない
  assert.deepEqual(
    db.prepare("SELECT title FROM cards ORDER BY id").all().map((r: any) => r.title),
    ["取り残された1件", "取り残された2件"]
  );
  assert.equal(one(db, "SELECT COUNT(*) c FROM sqlite_master WHERE name = 'tasks'").c, 0);
  assert.equal(one(db, "SELECT card_id FROM chat_messages").card_id, 1, "会話の紐付けが失われた");
  assert.equal(one(db, "SELECT COUNT(*) c FROM live_cards").c, 2, "ビューが cards を見ていない");
  db.close();
});

test("両方に中身があるときは触らない (人が中身を見て決める)", () => {
  strandedDb("2-both.db");
  const db = new Database(path.join(dataDir, "projects", "2-both.db"));
  db.exec("INSERT INTO cards (title) VALUES ('新しい側にも1件')");
  db.close();

  const r = run(true);
  assert.equal(r.status, 1, "拒否条件があるのに終了コードが 0");
  assert.match(r.stdout, /両方に中身がある/);

  const after = new Database(path.join(dataDir, "projects", "2-both.db"), { readonly: true });
  assert.equal(one(after, "SELECT COUNT(*) c FROM tasks").c, 2, "拒否したのに書いている");
  assert.equal(one(after, "SELECT COUNT(*) c FROM cards").c, 1);
  after.close();
});
