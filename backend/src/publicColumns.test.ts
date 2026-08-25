import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #252: **`PUBLIC_COLUMNS` が実スキーマと合っていること。**
 *
 * この一覧は「SQLをログに残すときに平文で出してよい語」の許可リストとして使う
 * (`mcpLog.ts` の `redactSql`)。ズレても壊れはせず、**知らない語が `?` になって
 * 読みにくくなるだけ**だが、列を足したときに黙って読めなくなるのは避けたい。
 *
 * **手で書いた一覧と現物を突き合わせる**形にしておけば、列を足したときにここで気づく。 */

process.env.CHATBAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-cols-"));
process.env.CHATBAN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-colslog-"));
process.env.AUTO_ARCHIVE = "0";

const { ensureInitialProject, projectReadonly } = await import("./store.js");
ensureInitialProject();
const { PUBLIC_TABLES, PUBLIC_COLUMNS } = await import("./db.js");

test("PUBLIC_COLUMNS が、引ける表・ビューの列と一致する", () => {
  const conn = projectReadonly();
  const actual = new Set<string>();
  for (const t of PUBLIC_TABLES)
    for (const c of conn.prepare("SELECT name FROM pragma_table_info(?)").all(t) as { name: string }[])
      actual.add(c.name);

  // **番人が本物を見ていること。**空なら全部素通りする (#180の教訓)
  assert.ok(actual.size >= 15, `列が読めていない (${actual.size}件)`);

  const listed = new Set(PUBLIC_COLUMNS);
  const missing = [...actual].filter((c) => !listed.has(c)).sort();
  const extra = [...listed].filter((c) => !actual.has(c)).sort();

  assert.deepEqual(
    missing,
    [],
    `db.ts の PUBLIC_COLUMNS に足りない列がある。**ログに残すSQLで ? に潰れて読めなくなる**: ${missing.join(", ")}`
  );
  // **多いぶんは咎めない。**許可リストに余分な語があっても、それはスキーマの語であって
  // 利用者のデータではないので害が無い。実際 `project_id` は古いDBにだけ残っており、
  // 新しく作ったプロジェクトには無い — **現物のほうが環境ごとに違う**ので、
  // ここを厳しくすると「環境によって落ちるテスト」になる。
  // 見たいのは「足りない」側だけ (足りないと ? に潰れて読めなくなる)
  void extra;
});
