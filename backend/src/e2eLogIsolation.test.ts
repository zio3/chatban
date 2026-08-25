import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

/** #253: **E2Eのログを、日常使いのログと同じファイルに書かないこと。**
 *
 * #247 で「どのMCPツールが呼ばれているか」をログに残すようにしたが、E2Eも同じ
 * `backend/logs/` に書いていたため、**記録がテストのぶんで埋まった**。
 * 実測 (2026-08-24): MCPツール呼び出し862件のうち **728件 (84%) がE2E**。
 * このときは時間帯で切り分けられたが、それは偶然うまくいっただけで、
 * 日常使いとテストが重なれば分けられなくなる。
 *
 * ## なぜ設定ファイルを文字列で見るのか
 *
 * この設定は **Playwright が別プロセスの環境変数として渡す**ので、
 * ここ (node:test) から実行して確かめる手段が無い。**書いてあることを確かめる**のが精一杯。
 * 代わりに、**外れたら確実に落ちる**ように「どこへ出すか」まで固定している。 */

const CONFIG = path.join(import.meta.dirname, "..", "..", "frontend", "playwright.config.ts");

test("E2Eのログは、日常使いの logs/ とは別のディレクトリへ出す", () => {
  const src = fs.readFileSync(CONFIG, "utf8");

  // **番人が本物を読めていること。**パスを間違えて空文字を読んでいたら全部素通りする (#180の教訓)
  assert.match(src, /CHATBAN_DATA_DIR/, `${CONFIG} を読めていない (E2Eの設定に見えない)`);

  const m = /CHATBAN_LOG_DIR:\s*"([^"]+)"/.exec(src);
  assert.ok(
    m,
    "playwright.config.ts が CHATBAN_LOG_DIR を渡していない。**E2Eが日常使いと同じ " +
      "backend/logs/ に書くと、#247 で数えたい「どのツールが呼ばれているか」がテストで埋まる**"
  );

  // e2e-data の下であること。ここは2つの性質がセットで効いている:
  //   - `.gitignore` の `backend/e2e-data/` で除外される (公開リポジトリなので実データを載せない)
  //   - `clean-db.mjs` が実行のたびに消す = 残るのは直近1回ぶんだけ
  // どちらか片方でも外れると、狙った「綺麗な1回ぶんのログ」にならない
  assert.match(
    m[1],
    /^e2e-data[\/\\]/,
    `E2Eのログ出力先が e2e-data の下でない (${m[1]})。` +
      "e2e-data の下なら gitignore 済みで、clean-db.mjs が実行ごとに消してくれる"
  );
});

test("E2Eのデータ置き場そのものが gitignore されている", () => {
  const ignore = fs.readFileSync(path.join(import.meta.dirname, "..", "..", ".gitignore"), "utf8");
  // **`logs/` の行は当てにしない。**あれは「logs という名前のディレクトリ」にしか効かず、
  // E2E側は e2e-data/logs なので、効いているのは `backend/e2e-data/` のほう
  assert.match(
    ignore,
    /^backend\/e2e-data\/$/m,
    "backend/e2e-data/ が .gitignore に無い。**リポジトリは公開**なので、E2Eのログが載る"
  );
});

/** #253: **ユニットテストも実ログに書かない。**
 *
 * #247 では個々のテストに `CHATBAN_LOG_DIR` を書いて回ったが、**書き忘れたテストが
 * 実ログに書き続けていた** — 2026-08-25 に `npm test` を1回流したら、実ログが
 * 24行伸びた (`[llm] -> t model=test-model` / `model=reflect-key` の行)。
 * 項目単位で潰すのをやめて、入口 (`resolveLogDir`) で決める形にした。 */
test("テスト実行中は、日常使いの logs/ に書かない", async () => {
  const { resolveLogDir } = await import("./log.js");

  // **この番人が意味を持つ前提。**node の test runner が子プロセスに立てる印で、
  // これが無くなったら判定材料ごと消えているので、静かに素通りさせず落とす
  assert.ok(process.env.NODE_TEST_CONTEXT, "NODE_TEST_CONTEXT が無い (nodeのテストランナーの仕様が変わった?)");

  assert.equal(resolveLogDir({ NODE_TEST_CONTEXT: "child-v8" } as NodeJS.ProcessEnv), "logs/test");
  assert.equal(resolveLogDir({} as NodeJS.ProcessEnv), "logs");

  // 明示指定はいちばん強い (tmpdir へ逃がしているテストがそのまま効く)
  assert.equal(
    resolveLogDir({ NODE_TEST_CONTEXT: "child-v8", CHATBAN_LOG_DIR: "/tmp/x" } as NodeJS.ProcessEnv),
    "/tmp/x"
  );
});
