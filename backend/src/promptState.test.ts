import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cardIndexJson, clampSummary } from "./promptState.js";
import { SUMMARY_DESCRIPTION } from "./chat.js";
import type { TaskStatus } from "./types.js";

// #221: **索引に何が載るか**の番人。
//
// ツール契約 (SUMMARY_DESCRIPTION) は summary についてこう約束している:
//   「カードに出るだけでなく、ボードのチャットが常時これを読んで受け答えする」
//
// ところが索引に summary が無く、チャットは query_log を叩かない限り現況を知らなかった。
// **契約は嘘をついていたが、何も落ちない** — 画面は正常、テストも通る、LLMは黙って
// 知らないまま答える。だから機械に見張らせる。
//
// MCP側 (boardState.ts の TaskFacts) には最初から入っていたので、
// **外部エージェントには見えていてボードのチャットだけ見えていない**という非対称だった。

const card = {
  id: 7,
  title: "デモ環境を直す",
  status: "review" as TaskStatus,
  summary: "実装完了 (commit abc123)",
  due: null,
  blockedBy: null,
  rejected: false,
  context: null,
};

test("契約どおり summary が索引に載る (チャットが現況を読めること)", () => {
  const o = JSON.parse(cardIndexJson(card));
  assert.equal(o.summary, "実装完了 (commit abc123)");
  // 契約側も対で確かめる。片方だけ直る形で実際に壊れたので (#218 と同じ理由)
  assert.match(SUMMARY_DESCRIPTION, /チャットが常時これを読んで/);
});

test("id / title / status は常に載る", () => {
  const o = JSON.parse(cardIndexJson({ ...card, summary: null }));
  assert.deepEqual(o, { id: 7, title: "デモ環境を直す", status: "review" });
});

test("空の値は載せない (索引を太らせない)", () => {
  for (const empty of [null, ""]) {
    const o = JSON.parse(cardIndexJson({ ...card, summary: empty }));
    assert.ok(!("summary" in o), `summary=${JSON.stringify(empty)} が載っている`);
  }
});

test("期限・依存・却下・経緯メモの有無は従来どおり", () => {
  const o = JSON.parse(
    cardIndexJson({ ...card, due: "2026-08-25", blockedBy: [3, 4], rejected: true, context: "長い経緯" })
  );
  assert.equal(o.due, "2026-08-25");
  assert.deepEqual(o.dep, [3, 4]);
  assert.equal(o.rejected, true);
  // **本文は載せない。**「あることだけ」伝えて中身は query_log で取りに行かせる
  assert.equal(o.hasContext, true);
  assert.ok(!("context" in o));
});

// Codexレビュー指摘 (P2): 書き込み側に長さ制限が無いので、任意長の summary が
// **基準スナップショットにも変更イベントにも全文で載る**。実測が短いことは上限の保証にならない。
// 守っているのは「プロンプトが無制限に太らないこと」なので、境界はプロンプト側に置く
test("長すぎる summary は索引で切る (プロンプトが無制限に太らない)", () => {
  const long = "あ".repeat(500);
  const o = JSON.parse(cardIndexJson({ ...card, summary: long }));
  assert.equal(o.summary.length, 121, "120字 + 「…」になっていない");
  assert.ok(o.summary.endsWith("…"), "切ったことが読み手に分からない");
});

test("120字ちょうどまでは切らない (通常運用では発火しない)", () => {
  const just = "あ".repeat(120);
  assert.equal(clampSummary(just), just);
  assert.equal(clampSummary("実装完了 (commit abc123)"), "実装完了 (commit abc123)");
});

// #222: 索引は列の**名前**だけを持ち、意味づけはしない。
// 前提情報 (CONTEXT_TEMPLATE) は「review が検収待ちか相手待ちかはプロジェクトによる」と
// 明言していて、その前提情報の**下に**索引が出る。索引がハードコードの語で意味を書くと、
// プロジェクトが決めたはずの定義を後から上書きしてしまう。
// 実行時の値ではなくソースを見るのは、ここが「書かないこと」の検査だから
test("索引は列の意味をハードコードしない (前提情報の定義を上書きしない)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.resolve(here, "promptState.ts"), "utf-8");
  const header = /## ボードの索引[^`]*/.exec(src);
  assert.ok(header, "索引の見出しを読めない (組み立ての書き方が変わった可能性がある)");
  for (const gloss of ["未着手", "作業中", "レビュー中", "検収待ち", "相手待ち", "完了"]) {
    assert.ok(!header[0].includes(gloss), `索引の見出しが列の意味「${gloss}」を語っている`);
  }
});
