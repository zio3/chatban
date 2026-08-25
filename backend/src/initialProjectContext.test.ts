import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #250: **契約に書いた読み方が、まっさらな環境でも通ること。**
 *
 * 内蔵チャットには `get_project_context` が無い (MCP専用) ので、前提情報の版は
 * `query_log` の生SQLで読ませている。ところが既定プロジェクトの初期化だけ
 * `createProject()` を通らず、**`project_context` の行が作られていなかった**。
 *
 * `getProjectContextRow()` は行が無ければ既定値 (空文字・version 1) を合成するので、
 * 画面もMCPも普通に動く。**生SQLにはその補完が無い**ので、`WHERE id=1` が0行を返す。
 * つまり**「契約どおりにやると、初回だけできない」**という形で隠れていた (Codexレビュー P2)。 */

process.env.CHATBAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-init-"));
process.env.CHATBAN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-initlog-"));
process.env.AUTO_ARCHIVE = "0";

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { queryProjectData, getProjectContextRow } = await import("./db.js");

/** 契約 (chat.ts の update_project_context.version) に書いてあるSQLそのもの */
const GUIDED_SQL = "SELECT text, version FROM project_context WHERE id=1";

test("まっさらな環境でも、契約に書いたSQLで版が読める", () => {
  const r = queryProjectData(GUIDED_SQL) as { rows: Array<{ version: number }> };

  assert.equal(r.rows.length, 1, "0行しか返らない (前提情報の行が作られていない)");
  assert.equal(r.rows[0].version, 1, "初期の版が 1 でない");
});

// **合成された既定値と、実際の行が食い違わないこと。**
// 片方だけ見て「動いている」と思うと、もう片方の経路で初めて露見する
test("生SQLで読んだ版と、読み取りAPIが返す版が一致する", () => {
  const viaSql = (queryProjectData(GUIDED_SQL) as { rows: Array<{ version: number; text: string }> }).rows[0];
  const viaApi = getProjectContextRow();

  assert.equal(viaSql.version, viaApi.version);
  assert.equal(viaSql.text, viaApi.text);
});

// 契約の文面とテストが同じSQLを指していること (文面だけ変わって、ここが古くなるのを防ぐ)
test("契約に書いてあるSQLと、ここで試しているSQLが同じ", async () => {
  const { buildTools } = await import("./chat.js");
  const tool = buildTools([]).find((t: any) => t.function.name === "update_project_context") as any;
  const desc: string = tool.function.parameters.properties.version.description;

  const normalized = desc.replace(/\s+/g, " ");
  assert.ok(
    normalized.includes(GUIDED_SQL) || normalized.includes(GUIDED_SQL.replace(/ /g, "")),
    `契約の文面が、ここで試しているSQLと違う:\n  契約: ${desc}\n  試験: ${GUIDED_SQL}`
  );
});

// **新規だけ直しても足りない。**旧版が作った既定プロジェクトは行が無いまま残り、
// 起動時は「プロジェクトが在る」ので初期化を素通りする (Codexレビュー P2)。
// 保証をスキーマ側に置いたので、**開き直した時点で揃う**
test("旧版が作った「行が無い」プロジェクトも、開き直せば直る", async () => {
  const { db, closeProjectDb, activeProjectId } = await import("./store.js");

  // 旧版の状態を作る: 行を消す
  db().prepare("DELETE FROM project_context").run();
  assert.equal(
    (queryProjectData(GUIDED_SQL) as { rows: unknown[] }).rows.length,
    0,
    "前提の用意に失敗した (行が消えていない)"
  );

  closeProjectDb(activeProjectId()); // 次の起動に相当 (開き直すとスキーマが当たり直す)

  const r = queryProjectData(GUIDED_SQL) as { rows: Array<{ version: number }> };
  assert.equal(r.rows.length, 1, "開き直しても行が作られていない");
  assert.equal(r.rows[0].version, 1);
});
