import { test } from "node:test";
import assert from "node:assert/strict";
import { isUpstreamRefusal } from "./llm.js";

// #212: 「上流が断った」の判定だけを固定する。
// **番号を名指ししない**のが要点 — 残高切れが 402 で返るとは限らない
// (OrcaRouter は枠切れを 403、失効を 401 で返していた)。実際に何が返るかは宣伝と違うことがある。

test("4xx はすべて「上流が断った」", () => {
  // 実際に見たことのあるもの
  assert.equal(isUpstreamRefusal(401), true, "キー失効");
  assert.equal(isUpstreamRefusal(403), true, "枠切れ (OrcaRouterはこれで返した)");
  assert.equal(isUpstreamRefusal(429), true, "混雑");
  assert.equal(isUpstreamRefusal(400), true, "パラメータ違い");
  // まだ見たことがないが、番号に依存していないので同じように扱える
  assert.equal(isUpstreamRefusal(402), true, "残高切れ (未実測)");
  assert.equal(isUpstreamRefusal(451), true, "知らない4xx");
});

test("4xx 以外は断りとして扱わない", () => {
  assert.equal(isUpstreamRefusal(200), false);
  assert.equal(isUpstreamRefusal(500), false, "上流の一時障害は「終わった」ではない");
  assert.equal(isUpstreamRefusal(503), false);
});

test("statusを持たない失敗 (ネットワーク断・タイムアウト) は断りではない", () => {
  // fetch の失敗や中断には status が無い。ここで拾うと、回線が切れただけで
  // 「デモが終わった」と見えてしまう
  assert.equal(isUpstreamRefusal(undefined), false);
  assert.equal(isUpstreamRefusal(null), false);
  assert.equal(isUpstreamRefusal("403"), false, "文字列は数値として扱わない");
});
