import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

/** 起動時のレガシー移行 (migrateLegacyDbIfNeeded) の検証。
 *
 * ここが壊れると「起動しない」か「記録が消える」のどちらかになるので、実物のファイルで確かめる。
 * 実際に両方踏んでいる:
 *   - 0バイトのファイルが1つ置かれただけで起動不能 (rename 済みで落ちるので症状が1回で消える)
 *   - 例外を「テーブルが無い」の代わりに使い、列違いのDBを空扱いして DROP → コスト記録が全消失
 *
 * サーバーを起動せず、移行関数だけを子プロセスで走らせる。
 * store.ts はモジュール読み込み時にDBを開くので、ケースごとにプロセスを分ける必要がある */
function runMigration(dataDir: string, dbPath: string, scriptDir: string): { ok: boolean; output: string } {
  // -e に渡すとシェルのクォートで壊れるので、実行するものはファイルに書く。
  // store.ts は絶対パス(file URL)で読む — cwd に依存させない
  const entry = join(scriptDir, "run-migration.ts");
  const storeUrl = pathToFileURL(join(process.cwd(), "src", "store.ts")).href;
  writeFileSync(entry, `import { migrateLegacyDbIfNeeded } from ${JSON.stringify(storeUrl)};\nmigrateLegacyDbIfNeeded();\n`);
  try {
    // npx.cmd を execFile で叩くと Windows では EINVAL になる (Node 20+ は .cmd に shell を要求する)。
    // shell を挟むとクォートで壊れるので、node に tsx を読ませて直接動かす
    const output = execFileSync(process.execPath, ["--import", "tsx", entry], {
      cwd: process.cwd(),
      env: { ...process.env, CHATBAN_DATA_DIR: dataDir, DB_PATH: dbPath },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, output: `${e?.message ?? ""}\n${e?.stdout ?? ""}${e?.stderr ?? ""}` };
  }
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "chatban-migration-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 移行対象として通る最低限のChatBan DB。cached_tokens の有無を切り替えられる */
function makeLegacyDb(path: string, opts: { cachedTokens: boolean; llmCalls: number }): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
      assignee TEXT, assign_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, assignee TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE assignment_history (id INTEGER PRIMARY KEY AUTOINCREMENT, task_title TEXT NOT NULL, assignee TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purpose TEXT NOT NULL, model TEXT NOT NULL, routed_model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
      ${opts.cachedTokens ? "cached_tokens INTEGER NOT NULL DEFAULT 0," : ""}
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO tasks (title) VALUES (?)").run("移行されるタスク");
  const cols = opts.cachedTokens
    ? "purpose, model, prompt_tokens, completion_tokens, cached_tokens, elapsed_ms"
    : "purpose, model, prompt_tokens, completion_tokens, elapsed_ms";
  const vals = opts.cachedTokens ? "(?, ?, ?, ?, ?, ?)" : "(?, ?, ?, ?, ?)";
  const ins = db.prepare(`INSERT INTO llm_calls (${cols}) VALUES ${vals}`);
  for (let i = 0; i < opts.llmCalls; i++) {
    if (opts.cachedTokens) ins.run("chat", "m", 10, 5, 3, 100);
    else ins.run("chat", "m", 10, 5, 100);
  }
  db.close();
}

const adminOf = (dataDir: string) => join(dataDir, "chatban-admin.db");
const countLlmCalls = (dataDir: string): number => {
  const db = new Database(adminOf(dataDir), { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) c FROM llm_calls").get() as { c: number }).c;
  } finally {
    db.close();
  }
};
const projectNames = (dataDir: string): string[] => {
  const db = new Database(adminOf(dataDir), { readonly: true });
  try {
    return (db.prepare("SELECT name FROM projects ORDER BY id").all() as { name: string }[]).map((r) => r.name);
  } finally {
    db.close();
  }
};
const countSettings = (dataDir: string): number => {
  const db = new Database(adminOf(dataDir), { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) c FROM settings").get() as { c: number }).c;
  } finally {
    db.close();
  }
};

/** 原本が変わっていないことを、ファイルの中身そのもので確かめる */
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const schemaOf = (path: string): string[] => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all() as { sql: string | null }[])
      .map((r) => r.sql ?? "")
      .filter(Boolean);
  } finally {
    db.close();
  }
};
const taskTitles = (path: string): string[] => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare("SELECT title FROM tasks ORDER BY id").all() as { title: string }[]).map((r) => r.title);
  } finally {
    db.close();
  }
};

test("0バイトのDBファイルは無視して正常に起動する", () => {
  withTempDir((dir) => {
    const legacy = join(dir, "chatban.db");
    writeFileSync(legacy, "");
    const r = runMigration(join(dir, "data"), legacy, dir);
    assert.ok(r.ok, `起動できるべき: ${r.output}`);
    // 取り込まないので原本はそのまま残る
    assert.ok(existsSync(legacy), "触っていない原本が残るべき");
    assert.deepEqual(projectNames(join(dir, "data")), ["マイプロジェクト"]);
  });
});

test("SQLiteですらないファイルは無視して正常に起動する", () => {
  withTempDir((dir) => {
    const legacy = join(dir, "chatban.db");
    writeFileSync(legacy, "これはデータベースではありません");
    const r = runMigration(join(dir, "data"), legacy, dir);
    assert.ok(r.ok, `起動できるべき: ${r.output}`);
    assert.ok(existsSync(legacy), "触っていない原本が残るべき");
    assert.deepEqual(projectNames(join(dir, "data")), ["マイプロジェクト"]);
  });
});

test("tasks だけを持つ別アプリのDBは取り込まない (原本を動かさない)", () => {
  withTempDir((dir) => {
    const legacy = join(dir, "chatban.db");
    const db = new Database(legacy);
    // tasks は一般的な名前なので、これだけで判定すると別アプリのDBを壊す
    db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT, assignee TEXT)");
    db.prepare("INSERT INTO tasks (title) VALUES (?)").run("別アプリのデータ");
    db.close();

    const r = runMigration(join(dir, "data"), legacy, dir);
    assert.ok(r.ok, `起動できるべき: ${r.output}`);
    assert.ok(existsSync(legacy), "原本は元の場所にあるべき");
    assert.deepEqual(projectNames(join(dir, "data")), ["マイプロジェクト"], "取り込んではいけない");

    // 中身も変わっていないこと (スキーマを当てられていない)
    const after = new Database(legacy, { readonly: true });
    const tables = (after.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name
    );
    after.close();
    assert.deepEqual(tables, ["tasks"], "別アプリのDBにテーブルを足していない");
  });
});

test("ChatBanの旧DBは取り込む。コスト記録も引き継ぐ", () => {
  withTempDir((dir) => {
    const legacy = join(dir, "chatban.db");
    makeLegacyDb(legacy, { cachedTokens: true, llmCalls: 3 });
    const dataDir = join(dir, "data");

    const r = runMigration(dataDir, legacy, dir);
    assert.ok(r.ok, `取り込めるべき: ${r.output}`);
    assert.equal(existsSync(legacy), false, "原本は data/projects/ へ移動している");
    assert.deepEqual(projectNames(dataDir), ["ChatBan開発"]);
    assert.equal(countLlmCalls(dataDir), 3, "コスト記録が引き継がれるべき");
  });
});

test("移行の途中で失敗しても、原本も管理DBも変わらない", () => {
  // 以前は「移動してから作業し、失敗したら戻す」形で、戻せていなかった:
  // projectDb() を呼んだ時点で移動後のファイルにスキーマ変更が当たっており、
  // 場所を戻しても中身は別物。settings の upsert も戻せていなかった (既存値の上書きを含む)。
  //
  // 失敗は自然に起こせるものを使う: 管理DBの settings.value は NOT NULL なので、
  // 旧DBに value=NULL の行があると upsert がそこで落ちる
  withTempDir((dir) => {
    const legacy = join(dir, "chatban.db");
    makeLegacyDb(legacy, { cachedTokens: true, llmCalls: 4 });
    const db = new Database(legacy);
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("model.main", "openai/x");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, NULL)").run("壊れている行");
    db.close();

    const before = { hash: sha256(legacy), schema: schemaOf(legacy), tasks: taskTitles(legacy) };
    const dataDir = join(dir, "data");

    const r = runMigration(dataDir, legacy, dir);
    assert.equal(r.ok, false, "失敗するべきケース");
    assert.match(r.output, /手を付けていない/, "原本に触っていないことを伝えるべき");

    // 原本が1バイトも変わっていない (スキーマ変更が当たっていない・データも無事)
    assert.ok(existsSync(legacy), "原本は元の場所にあるべき");
    assert.equal(sha256(legacy), before.hash, "原本のハッシュが変わっている");
    assert.deepEqual(schemaOf(legacy), before.schema, "原本のスキーマが変わっている");
    assert.deepEqual(taskTitles(legacy), before.tasks, "原本のデータが変わっている");

    // 管理DBも元どおり (途中まで入った行が残らない)
    assert.deepEqual(projectNames(dataDir), [], "プロジェクト行が残っている");
    assert.equal(countLlmCalls(dataDir), 0, "コスト記録が中途半端に入っている");
    assert.equal(countSettings(dataDir), 0, "設定が中途半端に入っている");

    // 作業用のコピーも残らない
    const leftovers = existsSync(join(dataDir, "projects"))
      ? readdirSync(join(dataDir, "projects")).filter((f) => f.includes("migrating"))
      : [];
    assert.deepEqual(leftovers, [], "作業用コピーが残っている");
  });
});

test("移動先が既にあって配置に失敗しても、管理DBに何も残らない (次回やり直せる)", () => {
  // 管理DBのトランザクションを先にコミットしてから rename していたときは、
  // ここでプロジェクト行だけが残り、次の起動は listProjects().length > 0 で移行を飛ばす。
  // 「移行できないまま固定される」状態が作れてしまっていた (外部レビュー指摘)
  withTempDir((dir) => {
    const legacy = join(dir, "chatban.db");
    makeLegacyDb(legacy, { cachedTokens: true, llmCalls: 2 });
    const dataDir = join(dir, "data");
    // 1件目のプロジェクトの置き場所を先に埋めておく
    mkdirSync(join(dataDir, "projects"), { recursive: true });
    writeFileSync(join(dataDir, "projects", "1-ChatBan開発.db"), "先客");

    const before = sha256(legacy);
    const r = runMigration(dataDir, legacy, dir);
    assert.equal(r.ok, false, "配置できないので失敗するべき");

    assert.ok(existsSync(legacy), "原本は残るべき");
    assert.equal(sha256(legacy), before, "原本が変わっている");
    assert.deepEqual(projectNames(dataDir), [], "プロジェクト行が残っている (次回の移行が飛ばされる)");
    assert.equal(countLlmCalls(dataDir), 0);
    assert.equal(countSettings(dataDir), 0);
    // 先客は壊していない
    assert.equal(readFileSync(join(dataDir, "projects", "1-ChatBan開発.db"), "utf-8"), "先客");

    // 次の起動でやり直せる (先客をどけたら通る)
    rmSync(join(dataDir, "projects", "1-ChatBan開発.db"));
    const retry = runMigration(dataDir, legacy, dir);
    assert.ok(retry.ok, `やり直せるべき: ${retry.output}`);
    assert.deepEqual(projectNames(dataDir), ["ChatBan開発"]);
    assert.equal(countLlmCalls(dataDir), 2);
  });
});

test("初期コミット当時のスキーマのDBも取り込める", () => {
  // 識別条件に chat_messages を入れていたとき、本物の初期版DBが「別物」と判定されていた
  // (chat_messages は初期コミットには無く、後から足したテーブル。外部レビュー指摘)。
  // 足りないテーブルは ensureProjectSchema が作るので、識別の条件にする必要がない
  withTempDir((dir) => {
    const legacy = join(dir, "chatban.db");
    const db = new Database(legacy);
    // 2026-08-09 の初期コミットにあったテーブルだけ
    db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
        assignee TEXT, reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, skills TEXT);
      CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, assignee TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE assignment_history (id INTEGER PRIMARY KEY AUTOINCREMENT, task_title TEXT NOT NULL, assignee TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, purpose TEXT NOT NULL, model TEXT NOT NULL, routed_model TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        elapsed_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare("INSERT INTO tasks (title) VALUES (?)").run("初期版から持ち越すタスク");
    for (let i = 0; i < 7; i++) {
      db.prepare("INSERT INTO llm_calls (purpose, model, prompt_tokens, completion_tokens, elapsed_ms) VALUES (?, ?, ?, ?, ?)").run("chat", "m", 10, 5, 100);
    }
    db.close();

    const dataDir = join(dir, "data");
    const r = runMigration(dataDir, legacy, dir);
    assert.ok(r.ok, `初期版も取り込めるべき: ${r.output}`);
    assert.deepEqual(projectNames(dataDir), ["ChatBan開発"], "chat_messages が無いだけで弾いてはいけない");
    assert.equal(countLlmCalls(dataDir), 7, "cached_tokens も chat_messages も無いが記録は移るべき");

    // 足りなかったテーブルは移行後に作られている
    const moved = new Database(join(dataDir, "projects", "1-ChatBan開発.db"), { readonly: true });
    const tables = new Set(
      (moved.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name)
    );
    moved.close();
    assert.ok(tables.has("chat_messages"), "ensureProjectSchema が作るべき");
    assert.ok(tables.has("summary_cards"), "ensureProjectSchema が作るべき");
  });
});

test("cached_tokens が無い初期版DBでも、コスト記録を失わない", () => {
  // 例外を「テーブルが無い」の代わりに使っていたとき、
  // no such column: cached_tokens を空扱いして DROP まで進み、記録が全部消えていた
  withTempDir((dir) => {
    const legacy = join(dir, "chatban.db");
    makeLegacyDb(legacy, { cachedTokens: false, llmCalls: 5 });
    const dataDir = join(dir, "data");

    const r = runMigration(dataDir, legacy, dir);
    assert.ok(r.ok, `取り込めるべき: ${r.output}`);
    assert.equal(countLlmCalls(dataDir), 5, "列が古くても記録は5件そのまま移るべき (0件なら消えている)");
  });
});
