import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** #245: **入口が増えたときに気づくための番人。**
 *
 * このリポジトリは「入口ごとにズレる」を繰り返し踏んでいる。
 * #114 では MCP が入口として増えたのに、ガードがチャット側にしか無く**素通りした**。
 * #92 / #108 / #153 / #213 / #237 も同じ形。
 *
 * #245 で `agentWrite.ts` の型検査を剥がし、**「検証済みの値しか来ない」を前提にした。**
 * その前提を守るのは「入口が必ず `parseToolArgs` を通ること」だけなので、
 * **前提が崩れた瞬間に落ちる**ようにしておく。
 *
 * ## 最初に書いた番人は役に立たなかった
 *
 * 1周目は「チャットが宣言している全ツールに契約がある」を見ていた。
 * **新しい入口を1つも検出しない** — 集合が変わらないため (Codexレビュー指摘)。
 * 実際、**そのとき MCP は関門を通っていなかったのに、このテストは通っていた。**
 *
 * 見るべきは「ツール名が揃っているか」ではなく、
 * **「書き込み関数を呼ぶファイルが、関門も呼んでいるか」**だった。
 *
 * ## この番人が保証しないこと (2周目の指摘)
 *
 * 見ているのは**ファイル単位**なので、**同じファイルの中で1経路だけ関門を外しても通る**
 * (Codexが実測: `mcp.ts` の create から関門3行だけ消しても 2/2 pass)。
 * つまりこれは「呼び出し単位で経路を保証する番人」ではなく、
 * **「関門を知らない新しい入口ファイルが増えたら気づく」番人**である。
 *
 * 呼び出し単位まで見たいなら、正規表現を複雑にするのではなく
 * **検証済みのファサードに集約する**のが筋 (入口が2つのうちは検知で足りると判断した)。
 * 経路そのものは、入口から実値を流すテスト (`chatToolWiring.test.ts`) が確かめている。 */

const SRC = dirname(fileURLToPath(import.meta.url));

/** 検証済みの値を前提にしている書き込み関数。**ここを呼ぶなら関門を通っていること** */
const GUARDED = ["createCardsAsAgent", "updateCardsAsAgent", "restoreCardsAsAgent"];

function sourceFiles(): string[] {
  return readdirSync(SRC)
    .filter((n) => /\.ts$/.test(n) && !/\.test\.ts$/.test(n))
    .map((n) => join(SRC, n));
}

test("書き込みを呼ぶファイルは関門を知っている (関門を知らない入口が増えたら落ちる)", () => {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf-8");
    const name = file.slice(SRC.length + 1);
    if (name === "agentWrite.ts") continue; // 定義そのもの

    const calls = GUARDED.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(src));
    if (calls.length === 0) continue;
    if (!/\bparseToolArgs\s*\(/.test(src)) offenders.push(`${name} (${calls.join(", ")})`);
  }

  assert.deepEqual(
    offenders,
    [],
    `関門 (parseToolArgs) を知らないまま書き込んでいるファイルがある。**型検査は agentWrite から剥がしてあるので、` +
      `ここを素通りすると壊れた値がそのままDBへ届く**:\n${offenders.join("\n")}`
  );
});

// **番人が本物を見ていることを、番人自身で確かめる。**
// 対象が0件だと、上のテストは何も見ずに通る (#180 の教訓)
test("番人が実際に入口を見つけている (見る対象が空でない)", () => {
  const withCalls = sourceFiles().filter((f) => {
    const name = f.slice(SRC.length + 1);
    if (name === "agentWrite.ts") return false;
    const src = readFileSync(f, "utf-8");
    return GUARDED.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(src));
  });

  const names = withCalls.map((f) => f.slice(SRC.length + 1)).sort();
  assert.deepEqual(names, ["chat.ts", "mcp.ts"], `入口の顔ぶれが変わっている: ${names.join(", ")}`);
});
