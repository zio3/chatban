import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** **import する前に、実データから引き離す** (Codexレビュー P1)。
 *
 * `llm.ts` → `store.ts` の連鎖で、**モジュール評価時に日常用の管理DBが開く**
 * (`store.ts` の `open(ADMIN_PATH)` と `ensureAdminSchema`)。その移行は
 * 古い設定の `DELETE` と旧テーブルの `DROP TABLE` を含むので、**`npm test` を流すだけで
 * 実データへ移行が適用されうる**。`mcpLogIsPure.test.ts` が文書化している当の危険で、
 * このファイルは最初 `CHATBAN_LOG_BODIES` しか置かずに import していた。 */
process.env.CHATBAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-dump-"));
process.env.CHATBAN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-dumplog-"));
process.env.CHATBAN_LOG_BODIES = "0"; // ダンプそのものを書かせない

const dataDir = process.env.CHATBAN_DATA_DIR;
const { startsNewDump } = await import("./llm.js");

// **引き離せたことを、その場で確かめる。**「一時領域を指した」だけでは
// import の順序が狂ったときに黙って実データへ戻る (肯定形を書いたままにしない)
test("import 先の管理DBは一時領域にできている (実データを開いていない)", () => {
  assert.ok(
    fs.existsSync(path.join(dataDir!, "chatban-admin.db")),
    `管理DBが一時領域に無い。実データ側を開いた可能性がある (${dataDir})`
  );
});

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
// `2,4,4,6,6,8` は単調でないが、**どれも先頭の2より大きい**ので1本に積まれ続ける
// (`<=` で作り直すので、「下回らない」では 2 そのものを取りこぼす)
test("実測した messageCount の並びが、そのまま1ファイルに積まれる", () => {
  const observed = [2, 4, 4, 6, 6, 8];
  let file = prev("gpt-x", observed[0]);
  for (const count of observed.slice(1)) {
    assert.equal(startsNewDump(file, "gpt-x", count), false, `${count} で作り直しになった`);
    file = { ...file, rounds: [...file.rounds, { messageCount: count }] };
  }
  assert.equal(file.rounds.length, observed.length, "実測は rounds=6 だった");
});


// #264: **足す側に入る条件を、そのまま書き下す。**
// 同じ `model` の truthy な `prev` で、`rounds` が欠落/空、または先頭の `messageCount` が
// 無く、現在の件数が正なら、先頭を 0 として扱って足す (旧式のインラインの式と同じ挙動)。
//
// **「半端なら作り直す」でも「読めれば作り直さない」でもない** — 3周のレビューで
// どちらの言い方もずれていた。条件を言い換えずに、そのまま固定する
test("rounds が空・messageCount が無くても、足す側に入る", () => {
  assert.equal(startsNewDump({ model: "gpt-x", rounds: [] }, "gpt-x", 1), false);
  assert.equal(startsNewDump({ model: "gpt-x" }, "gpt-x", 1), false);
  assert.equal(startsNewDump({ model: "gpt-x", rounds: [{}] }, "gpt-x", 1), false);
  // ただし 0 件のときに 0 を渡せば作り直す (`<=` なので)
  assert.equal(startsNewDump({ model: "gpt-x", rounds: [] }, "gpt-x", 0), true);
});

// **読めても作り直す形がある** (3周目レビュー P2)。`prev` が falsy になる値と、
// `model` が欠けているファイル。「読めてさえいれば作り直さない」と書いていたが違った
test("JSONとして読めても、falsy や model 欠落なら作り直す", () => {
  for (const prevValue of [null, false, "", 0]) {
    assert.equal(startsNewDump(prevValue, "gpt-x", 99), true, `${JSON.stringify(prevValue)} で足す側に入った`);
  }
  assert.equal(startsNewDump({ rounds: [{ messageCount: 2 }] }, "gpt-x", 99), true, "model 欠落を見ていない");
});

// **helper が足す側を返しても、書き込みまで行くとは限らない。**
// `dumpRequest` は `[...prev.rounds]` で広げるので、`rounds` が**反復できない値**だと
// 例外になり、catch がその回のダンプごと落とす (足しも作り直しもしない第3の結果)。
//
// **文字列は例外にならない** — 最初この検査を「配列でなければ落ちる」と書いたが、
// 文字列は1文字ずつの配列になるだけで、壊れたまま書かれる。落ちるのは反復できない値のとき
test("rounds が反復できない値だと、足す側を返したあと書き込みで落ちる", () => {
  const broken = { model: "gpt-x", rounds: 42 };
  assert.equal(startsNewDump(broken, "gpt-x", 5), false, "helper は足す側を返す");
  assert.throws(() => [...(broken.rounds as any)], TypeError, "dumpRequest の spread が落ちる形");

  // 文字列は落ちない (1文字ずつの配列になる)。**壊れたまま書かれる**ほうの形
  assert.deepEqual([...("ab" as any)], ["a", "b"]);
});

// **繋がっていることを見張る側** (#259 で同じ穴を作ったので対で置く)。
// helper だけを試すテストは、dumpRequest が helper を使わなくなっても通ってしまう
test("dumpRequest が startsNewDump を通っている", () => {
  const src = fs.readFileSync(new URL("./llm.ts", import.meta.url), "utf-8");
  assert.ok(
    /const isNewTurn = startsNewDump\(prev, model, params\.messages\.length\)/.test(src),
    "llm.ts が startsNewDump を通っていない (判断が2か所に分かれている)"
  );
  assert.ok(
    !/isNewTurn = !prev \|\|/.test(src),
    "llm.ts に判断の式が戻っている (helper と二重になる)"
  );
  // **呼んでいるだけでは足りない。**結果が分岐に使われていることまで見る —
  // 呼び出しを残したまま分岐をインラインの式に戻せてしまう (2周目レビュー P3)
  assert.ok(/const out = isNewTurn\s*\?/.test(src), "startsNewDump の結果が分岐に使われていない");
});
