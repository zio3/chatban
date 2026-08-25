import assert from "node:assert/strict";
import test from "node:test";

import { argDetail, argShape, MCP_TOOL_NAMES, safe, safeToolName, toolCalls, toolOutcome } from "./mcpLog.js";

/** #247: **ログに出てよいのは「こちらが決めた語」だけ。**
 *
 * 最初は「値を出さなければ安全」と考えてキー名をそのまま出していたが、これは誤りだった
 * (Codexレビュー P2)。`create_cards` の要素スキーマは `.passthrough()` なので、
 * **キー名そのものが外部入力**になる。 */

// ---- 値を出さない (元からの性質) ----

test("値は1文字も残さない (経緯メモの本文が混ざらない)", () => {
  const line = argShape({
    updates: [{ id: 12, context: "SECRET-社外に出せない経緯", summary: "SECRET-要約" }],
  });

  assert.ok(!line.includes("SECRET"), `本文が記録に出ている: ${line}`);
  assert.ok(!line.includes("12"), `値が記録に出ている: ${line}`);
  assert.ok(line.includes("context") && line.includes("summary"), `キー名は残っていない: ${line}`);
});

// ---- キー名も外部入力として扱う (レビューで見つかった穴) ----

test("契約に無いキーは平文にせず、個数だけ数える", () => {
  const line = argShape({ cards: [{ title: "x", "SECRET-顧客情報": "y" }] });

  assert.ok(!line.includes("SECRET"), `キー名から本文が漏れている: ${line}`);
  assert.match(line, /\+1不明/, `契約に無いキーを使ったことが消えている: ${line}`);
  assert.ok(line.includes("title"), "契約にあるキーまで消えている");
});

test("トップレベルの未知キーも同じ扱い", () => {
  const line = argShape({ ids: [1], "SECRET-混入": 1 });
  assert.ok(!line.includes("SECRET"), line);
  assert.match(line, /\+1不明/);
});

// **改行を残すと1回の呼び出しで複数行を作れる。**行数を数える集計が丸ごと偽装できる
test("制御文字は落とす (ログの行を作らせない)", () => {
  const forged = "a\n[2099-01-01 00:00:00] [mcp] sync_board ok";
  assert.ok(!safe(forged).includes("\n"), "改行が残っている");
  assert.ok(!safe("a\r\nb\tc").match(/[\r\n\t]/), "制御文字が残っている");
  assert.equal(safe("  詰める   空白  "), "詰める 空白");
  assert.equal(safe(undefined), "");
  assert.equal(safe(123), "");
});

test("自由文は長さを切る (1行に収まる)", () => {
  assert.ok(safe("あ".repeat(500)).length < 70, "切られていない");
});

test("登録済みでないツール名は平文にしない", () => {
  assert.equal(safeToolName("create_cards"), "create_cards");
  assert.equal(safeToolName("SECRET-な名前"), "(未登録のツール)");
  assert.equal(safeToolName(undefined), "(未登録のツール)");
  assert.ok(MCP_TOOL_NAMES.length >= 8, "許可リストが空同然になっている");
});

// ---- 形の読み取り ----

test("配列は件数と、要素に現れたキーを出す", () => {
  assert.equal(argShape({ ids: [1, 2, 3] }), "ids[3]");
  assert.equal(argShape({ cards: [{ title: "a" }], sync_token: "x" }), "cards[1]{title} sync_token");
});

// **1件目だけ見ると足された項目を見落とす。**「どの項目が使われているか」を数えるのが目的なので、
// 2件目で初めて出てきたキーが落ちると、その項目は永久に「使われていない」に見える
test("2件目で足されたキーも拾う (要素キーの和を取る)", () => {
  const line = argShape({ updates: [{ id: 1 }, { id: 2, due: "2026-09-01" }] });
  assert.match(line, /updates\[2\]/);
  assert.ok(line.includes("due"), `2件目のキーが落ちている: ${line}`);
});

test("空・非オブジェクトでも落ちない", () => {
  assert.equal(argShape({}), "");
  assert.equal(argShape(undefined), "");
  assert.equal(argShape("文字列"), "");
  assert.equal(argShape([1, 2]), "");
});

test("行が長くなりすぎない", () => {
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, 1]));
  assert.ok(argShape(many).length <= 201, "行が打ち切られていない");
});

// ---- 結果の読み取り ----

const res = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }] });

test("ok:false は理由の先頭ごと残す (失敗が溜まる場所になる)", () => {
  const out = toolOutcome(res({ ok: false, note: "経緯メモの更新には context_version が必要です" }));
  assert.match(out, /^NG /);
  assert.match(out, /context_version/);
});

test("理由が無いときも NG と分かる", () => {
  assert.equal(toolOutcome(res({ ok: false })), "NG (理由なし)");
});

test("断りの理由にも制御文字と長さの制限が効く", () => {
  assert.ok(!toolOutcome(res({ ok: false, note: "a\nb" })).includes("\n"), "改行が残っている");
  assert.ok(toolOutcome(res({ ok: false, note: "あ".repeat(500) })).length < 80);
});

test("通ったものは ok", () => {
  assert.equal(toolOutcome(res({ ok: true, created: [{ id: 1 }] })), "ok");
  assert.equal(toolOutcome(res({ cards: [] })), "ok", "ok を持たない応答 (sync_board) が NG になっている");
});

test("JSONでない応答や形の違う応答でも落ちない", () => {
  assert.equal(toolOutcome({ content: [{ type: "text", text: "使い方の説明文" }] }), "ok");
  assert.equal(toolOutcome({ content: [] }), "ok");
  assert.equal(toolOutcome(undefined), "ok");
});

// ---- JSON-RPC の取り出し (バッチ) ----

const c = (id: number, name: string, args: unknown = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

test("単発の tools/call を拾う", () => {
  assert.deepEqual(toolCalls(c(1, "sync_board")), [{ id: 1, name: "sync_board", args: {} }]);
});

// **body.method だけを見ていると配列では常に undefined になる** — これが穴だった
test("配列 (バッチ) でも全部拾う", () => {
  const got = toolCalls([c(1, "sync_board"), c(2, "query_log")]);
  assert.deepEqual(
    got.map((g) => g.name),
    ["sync_board", "query_log"]
  );
});

test("tools/call 以外は拾わない", () => {
  assert.deepEqual(toolCalls([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]), []);
  assert.deepEqual(toolCalls(undefined), []);
  assert.deepEqual(toolCalls({ method: "tools/call" }), [{ id: undefined, name: "(未登録のツール)", args: undefined }]);
});

test("未登録のツール名はここでも平文にしない", () => {
  assert.equal(toolCalls(c(1, "SECRET-な名前"))[0].name, "(未登録のツール)");
});

/** #252: **許可した項目だけ、値を平文で出す。**
 *
 * `query_log` の説明はチャットのツール定義の35%を占める (3482/9924字) のに、
 * 呼ばれるのは `update_cards` の3分の1。削る候補は例文11本 (1122字) だが、
 * `argShape` は `sql` というキー名しか出さないので、**どの例文が真似されているか数えられない**。 */
test("query_log は SQL そのものを残す (どの例文が真似されているか数えるため)", () => {
  assert.equal(
    argDetail("query_log", { sql: "SELECT id, title FROM live_cards" }),
    "sql=SELECT id, title FROM live_cards"
  );
});

test("許可していないツール・項目の値は出さない", () => {
  // **経緯メモが丸ごとディスクに残る形にしない** (#224 と同じ形になる)
  assert.equal(argDetail("update_cards", { updates: [{ id: 1, context: "秘密の経緯" }] }), "");
  assert.equal(argDetail("create_cards", { cards: [{ title: "秘密の題名" }] }), "");
  // 未登録のツール名を名乗って許可リストをすり抜けられない
  assert.equal(argDetail("query_log ", { sql: "SELECT 1" }), "");
  assert.equal(argDetail("(未登録のツール)", { sql: "SELECT 1" }), "");
});

test("SQL に改行を混ぜても、ログの行を増やせない", () => {
  // **これが本体。**#247 で「キー名をそのまま出す」を潰したのと同じ攻撃。
  // 行数で集計するので、1回の呼び出しで複数行を作れると数字ごと偽装できる
  const forged = "SELECT 1\n[2099-01-01 00:00:00] [mcp] query_log ok | sql | 1ms";
  const out = argDetail("query_log", { sql: forged });
  assert.ok(!out.includes("\n"), `改行が残っている: ${JSON.stringify(out)}`);
  assert.ok(!out.includes("\r"), "復帰が残っている");
});

test("長いSQLは切り詰める (1回の呼び出しでログを埋められない)", () => {
  const out = argDetail("query_log", { sql: "SELECT " + "x".repeat(5000) });
  assert.ok(out.length < 400, `切り詰めていない (${out.length}字)`);
  assert.ok(out.endsWith("…"), "切り詰めた印が無い");
});

test("sql が文字列でなければ何も出さない (スキーマで弾かれた呼び出しでも壊れない)", () => {
  assert.equal(argDetail("query_log", {}), "");
  assert.equal(argDetail("query_log", { sql: 123 }), "");
  assert.equal(argDetail("query_log", null), "");
  assert.equal(argDetail("query_log", undefined), "");
});

// #252: **断り方の欄が1つではない。**`query_log` だけは `{ ok:false, error }` を返すので、
// `note` しか見ていないと、**一番中身を知りたいツールの失敗理由だけが消える**
test("query_log の断り (error 欄) も記録される", () => {
  const wrap = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
  assert.equal(toolOutcome(wrap({ ok: false, error: "no such table: secrets" })), "NG no such table: secrets");
  // note があるほうを優先する (こちらが書いた案内文のほうが読みやすい)
  assert.equal(toolOutcome(wrap({ ok: false, note: "版が合わない", error: "raw" })), "NG 版が合わない");
  assert.equal(toolOutcome(wrap({ ok: false })), "NG (理由なし)");
});
