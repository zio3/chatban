import assert from "node:assert/strict";
import test from "node:test";
import { CACHE_DISCOUNT, CACHE_WRITE_MULTIPLIER, costOf } from "./llm.js";

/** #172: 入力を「新規 / キャッシュ読み / キャッシュ書き」に割って単価を掛ける。
 *
 * 書き込みを読みと同じ扱いにすると、初回に払う25,000トークン分が25%安く出る (外部レビュー指摘)。
 * Anthropic の5分キャッシュは書き込みが標準入力の1.25倍、読みが約10%。 */

const IN = 1.0; // $/1M
const OUT = 5.0;

test("キャッシュを使わない回は素の単価", () => {
  assert.equal(costOf(IN, OUT, 1000, 100, 0), (1000 * IN + 100 * OUT) / 1e6);
});

test("キャッシュ読みは割引される", () => {
  // 1000のうち800がキャッシュ読み
  const expected = (200 * IN + 800 * IN * CACHE_DISCOUNT + 100 * OUT) / 1e6;
  assert.equal(costOf(IN, OUT, 1000, 100, 800), expected);
});

test("キャッシュ書き込みは割増される (読みと同じ扱いにしない)", () => {
  // 1000のうち800がキャッシュ書き込み
  const expected = (200 * IN + 800 * IN * CACHE_WRITE_MULTIPLIER + 100 * OUT) / 1e6;
  assert.equal(costOf(IN, OUT, 1000, 100, 0, 800), expected);
  // 読み扱いより高くなること (安く出ていたのが元のバグ)
  assert.ok(costOf(IN, OUT, 1000, 100, 0, 800) > costOf(IN, OUT, 1000, 100, 800));
});

test("読みと書きが混ざっても新規分を二重に数えない", () => {
  const cost = costOf(IN, OUT, 1000, 100, 600, 300);
  const expected = (100 * IN + 600 * IN * CACHE_DISCOUNT + 300 * IN * CACHE_WRITE_MULTIPLIER + 100 * OUT) / 1e6;
  assert.equal(cost, expected);
});

test("キャッシュ分が総入力を超えても負の新規分にならない", () => {
  // 上流の値が食い違っても落とさない (概算なので0で止める)
  assert.ok(costOf(IN, OUT, 100, 10, 200, 100) >= 0);
});
