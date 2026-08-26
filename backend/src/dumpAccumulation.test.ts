import assert from "node:assert/strict";
import test from "node:test";

process.env.CHATBAN_LOG_BODIES = "0"; // logs/ を汚さない (llm.ts の読み込みで書き出しが走らないように)
const { startsNewDump } = await import("./llm.js");

/** #264: **プロンプトダンプはターンをまたいで積む。**
 *
 * `llm.ts` のコメントは「同じターンの2round目以降は足す」と書いていたが、実装が見ているのは
 * **現在の総メッセージ数と、保存済みの先頭 round のそれ**で、ターンでは切れていない。
 *
 * **この誤りは1回では終わらなかった。**`docs/security.md` で説明しようとして
 * 2周続けて読み違えた (「最新ターンで上書きされる」→ 実際は蓄積 /
 * 「直前の round と比べている」→ 実際は先頭 round、しかも `<=`)。
 * コメントを直しただけでは同じことが起きるので、**振る舞いのほうを固定する**。 */

const prev = (model: string, firstCount: number, ...rest: number[]) => ({
  model,
  rounds: [firstCount, ...rest].map((messageCount) => ({ messageCount })),
});

test("ファイルがまだ無ければ作り直す", () => {
  assert.equal(startsNewDump(null, "gpt-x", 2), true);
  assert.equal(startsNewDump(undefined, "gpt-x", 2), true);
});

test("モデルが変わったら作り直す (別のモデルを1ファイルに混ぜない)", () => {
  assert.equal(startsNewDump(prev("gpt-x", 2), "gpt-y", 999), true);
});

test("同じターンの2round目は足す", () => {
  assert.equal(startsNewDump(prev("gpt-x", 2), "gpt-x", 4), false);
});

// **ここが本題。**次のターンは履歴のぶんメッセージが増えるので、足す側に入る
test("次のターンでも足す (ターンでは切れていない)", () => {
  const afterTurn1 = prev("gpt-x", 2, 4); // 1ターン目が2roundで終わった状態
  assert.equal(startsNewDump(afterTurn1, "gpt-x", 6), false, "ターンをまたぐと作り直す実装になっている");
});

// 比べる相手は**先頭** round。直前の round と比べる実装に変えると、ここが落ちる
test("比べる相手は先頭の round であって、直前の round ではない", () => {
  const p = prev("gpt-x", 2, 8); // 先頭=2、直前=8
  assert.equal(startsNewDump(p, "gpt-x", 5), false, "直前(8)と比べていると作り直しになってしまう");
});

// `<` ではなく `<=`。同じ数でも作り直す
test("先頭と同じ数なら作り直す (等値を含む)", () => {
  assert.equal(startsNewDump(prev("gpt-x", 2, 4, 6), "gpt-x", 2), true);
  assert.equal(startsNewDump(prev("gpt-x", 2, 4, 6), "gpt-x", 1), true, "履歴のリセット");
});

// 実測した並び (2026-08-26 の last-request-p32-chat.json) を通してみる。
// `2,4,4,6,6,8` は単調でないが、**先頭の2を下回らない**ので1本に積まれ続ける
test("実測した messageCount の並びが、そのまま1ファイルに積まれる", () => {
  const observed = [2, 4, 4, 6, 6, 8];
  let file = prev("gpt-x", observed[0]);
  for (const count of observed.slice(1)) {
    assert.equal(startsNewDump(file, "gpt-x", count), false, `${count} で作り直しになった`);
    file = { ...file, rounds: [...file.rounds, { messageCount: count }] };
  }
  assert.equal(file.rounds.length, observed.length, "実測は rounds=6 だった");
});
