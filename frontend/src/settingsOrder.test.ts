import assert from "node:assert/strict";
import test from "node:test";
import { isOlder } from "./settingsOrder.js";

const at = (bootGeneration: number, revision: number) => ({ bootGeneration, revision });

test("同じ起動なら版で比べる", () => {
  assert.equal(isOlder(at(3, 1), at(3, 2)), true, "版が小さいものは古い");
  assert.equal(isOlder(at(3, 3), at(3, 2)), false, "版が大きいものは新しい");
});

test("同じ (世代, 版) は古くない — 同じ内容なのでどちらを採っても変わらない", () => {
  assert.equal(isOlder(at(3, 2), at(3, 2)), false);
});

test("世代が違えば版は見ない (再起動で版は0に戻るため)", () => {
  // ここが「版だけ」で判定したときに壊れる箇所。
  // 再起動直後の rev 0 は、再起動前の rev 99 より新しい
  assert.equal(isOlder(at(4, 0), at(3, 99)), false, "新しい世代なら版が小さくても新しい");
  // 逆向き。旧プロセスで始まった遅延応答が、版が大きいからと採用されてはいけない。
  // ここが「起動ごとのランダムID」で判定したときに壊れる箇所 (同一性しか分からず順序が無い)
  assert.equal(isOlder(at(3, 99), at(4, 0)), true, "古い世代なら版が大きくても古い");
});

test("世代は1つ違いでも隣接しない飛びでも同じに扱う (壊れた値でUNIX秒へ飛ぶことがある)", () => {
  assert.equal(isOlder(at(5, 0), at(1755000000, 0)), true);
  assert.equal(isOlder(at(1755000000, 0), at(5, 7)), false);
});
