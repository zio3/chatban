import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_DESCRIPTION, QUERY_LOG_DESCRIPTION } from "./chat.js";

/** #256: **goal の説明は1箇所だけ。**
 *
 * ツール説明の本文にも「goal を添えておくと」と書きかけたが、それは
 * 「**同じ事実を2回言わない**」(#255) を自分で破っていた。
 * 引数の説明は呼ぶときに必ず目に入るので、本文で言い直す必要が無い。
 *
 * **文脈を減らす話で文脈を増やしている**ことは自覚しておく。
 * 見合うのは、#255 で削れなかった残り (`done_cards` 0件・`SELECT *` 違反0件が
 * 「知られていない」のか「効いている」のか) を判別できるようになるから。 */

test("goal の使い方は引数の説明にだけ書く (本文で言い直さない)", () => {
  assert.ok(!QUERY_LOG_DESCRIPTION.includes("goal"), "ツール説明の本文が goal に触れている");
});

// **自明なクエリでは書かせない。**毎回書かせると、増える文脈のわりに
// 同じことしか返ってこない (知りたいのは詰まった回だけ)
test("いつ書くかを言う (自明なら要らない・複雑なときだけ)", () => {
  assert.match(GOAL_DESCRIPTION, /自明/, "自明なときは要らない、が書かれていない");
  assert.match(GOAL_DESCRIPTION, /任意/, "任意であることが書かれていない");
});

test("説明そのものを短く保つ", () => {
  assert.ok(
    GOAL_DESCRIPTION.length < 100,
    `${GOAL_DESCRIPTION.length}字。文脈を減らす話で増やしている欄なので、ここが太ったら本末転倒`
  );
});
