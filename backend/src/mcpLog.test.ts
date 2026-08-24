import assert from "node:assert/strict";
import test from "node:test";

import { argShape, toolOutcome } from "./mcpLog.js";

/** #247: **記録に本文が混ざらないことが、この機能の一番大事な性質。**
 * 経緯メモは3,000字級の実データなので、うっかり出すと
 * #224 (公開デモでプロンプト全文がディスクに残る) と同じ形になる。 */

test("値は1文字も残さない (経緯メモの本文が混ざらない)", () => {
  const line = argShape({
    updates: [{ id: 12, context: "SECRET-社外に出せない経緯", summary: "SECRET-要約" }],
  });

  assert.ok(!line.includes("SECRET"), `本文が記録に出ている: ${line}`);
  assert.ok(!line.includes("12"), `値が記録に出ている: ${line}`);
  assert.ok(line.includes("context") && line.includes("summary"), `キー名は残っていない: ${line}`);
});

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

test("長すぎるキーと行は打ち切る (ログを1行に保つ)", () => {
  const long = "k".repeat(300);
  assert.ok(argShape({ [long]: 1 }).length < 60, "キーが打ち切られていない");

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

test("通ったものは ok", () => {
  assert.equal(toolOutcome(res({ ok: true, created: [{ id: 1 }] })), "ok");
  assert.equal(toolOutcome(res({ cards: [] })), "ok", "ok を持たない応答 (sync_board) が NG になっている");
});

test("JSONでない応答や形の違う応答でも落ちない", () => {
  assert.equal(toolOutcome({ content: [{ type: "text", text: "使い方の説明文" }] }), "ok");
  assert.equal(toolOutcome({ content: [] }), "ok");
  assert.equal(toolOutcome(undefined), "ok");
});

// **理由の全文は載せない。**note は数百字になることがあり、載せるとログが読めなくなる
test("理由は先頭だけ (1行に収まる)", () => {
  const out = toolOutcome(res({ ok: false, note: "あ".repeat(500) }));
  assert.ok(out.length < 80, `理由が長すぎる: ${out.length}字`);
});
