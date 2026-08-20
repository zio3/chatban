import assert from "node:assert/strict";
import test from "node:test";
import { cardIndexJson } from "./promptState.js";
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
