import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 子プロセスは tsx で起こす (`.ts` をそのまま読ませるため) */
const tsxBin = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

/** #265: **テストが実データの管理DBを開かない、という状態を保つための番人。**
 *
 * `store.ts` は**モジュール評価時に** `data/chatban-admin.db` を開き、`ensureAdminSchema()` を走らせる。
 * その移行には古い設定の `DELETE` と旧テーブルの `DROP TABLE` が含まれるので、
 * **`npm test` を流すだけで実データへ移行が当たりうる**。
 *
 * これは新しい問題ではない。`mcpLogIsPure.test.ts` が同じ危険を文書化していて、
 * それでも #264 でもう一度踏んだ (`dumpAccumulation.test.ts`)。**文書も先例もあったのに踏んだ**ので、
 * 「各テストファイルの先頭に書く」という約束では止まらない。実際に書き忘れが12件たまっていた。
 *
 * だから守りは2枚にしてある:
 *
 *   - `src/testEnv.ts` … test スクリプトが `--import` で先に読み、一時領域を指す。**書かなくても守られる**
 *   - `store.ts` の入口 … `NODE_TEST_CONTEXT` があるのに `CHATBAN_DATA_DIR` が無ければ例外。
 *     **上の入口が外れたことに気づくため**
 *
 * ここが見るのは1枚目。**2枚目は「1枚目が外れたとき」にしか動かない**ので、
 * 1枚目が静かに消えると、実データを開くのは止まるが**全テストが落ちる**形になる。
 * どちらの壊れ方も痛いので、外れたこと自体をここで名指しする。 */
test("npm test は testEnv.ts を先に読み込む (#265)", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  assert.match(
    pkg.scripts.test,
    /--import \.\/src\/testEnv\.ts/,
    "test スクリプトから testEnv.ts の読み込みが外れている。" +
      "CHATBAN_DATA_DIR を置き忘れたテストが実データの管理DBを開き、移行を当ててしまう (#265)"
  );
});

/** **番人そのものが効いているか — ソースではなく挙動で見る** (Codexレビュー P2-2)。
 *
 * 最初はソースに条件式が在ることだけを見ていたが、**条件を残したまま `throw` を消しても
 * `warning` に変えても通ってしまう**。それでは安全境界が消えたことに気づけない。
 *
 * 実際に「テストの子プロセスの印はあるが行き先の指定は無い」状態を作って `store.js` を読み込ませ、
 * **落ちること**と**専用のエラー文が出ること**を見る。`data/` を開こうとする前に例外になるので、
 * この検査自体は実データに触らない。 */
test("行き先の指定が無いままのテスト実行は、store.ts の入口で止まる (#265)", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_TEST_CONTEXT: "child-v8" };
  delete env.CHATBAN_DATA_DIR;

  const r = spawnSync(
    process.execPath,
    [tsxBin, "--eval", 'import("./src/store.js")'],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), env, encoding: "utf-8" }
  );

  assert.notEqual(r.status, 0, `番人が止めていない (終了コード ${r.status})。実データの管理DBを開きうる`);
  assert.match(
    (r.stderr ?? "") + (r.stdout ?? ""),
    /テストが実データの管理DBを開こうとした/,
    "落ちてはいるが、番人のエラーではない。別の理由で落ちている可能性がある"
  );
});

/** **外から渡された値を必ず上書きするか** (Codexレビュー 2周目 P2)。
 *
 * ここが**この件の最重要条件**。`CHATBAN_DATA_DIR` は README にも載る正式な本番設定なので、
 * シェルやCIに本番の絶対パスが入ったまま `npm test` を流すと実データを開く。
 * `store.ts` の番人も「変数がある」ので黙って通す。
 *
 * **前の形はこれを見張れていなかった。**このプロセスに届く時点で `testEnv.ts` が既に
 * 一時領域へ書き換えた後なので、**元から値が在ったのかどうかが分からない**。
 * `??=` に戻しても、環境変数の無い普通の `npm test` は全件通ってしまう —
 * 手で `CHATBAN_DATA_DIR=... npm test` と付けたときしか落ちない検査だった。
 *
 * だから**子プロセスに目印の値を渡して**、`testEnv.ts` を通した後に何になっているかを見る。
 * 目印がそのまま残っていたら上書きしていない。
 *
 * ついでに、前の形は「バックスラッシュかスラッシュ」のつもりの文字クラスが
 * **スラッシュだけ**になっていた (ヒアドキュメントでバックスラッシュが1つ食われた) ので、
 * Windows の絶対パスを弾けていなかった。**書いたつもりの検査が別物になっていた**わけで、
 * 目印方式なら区切り文字に依存しない。 */
const SENTINEL = "SENTINEL-DO-NOT-USE";

test("外から渡された行き先は、必ず一時領域へ上書きされる (#265)", () => {
  const r = spawnSync(
    process.execPath,
    [
      tsxBin,
      "--import",
      "./src/testEnv.ts",
      "--eval",
      'console.log(JSON.stringify([process.env.CHATBAN_DATA_DIR, process.env.CHATBAN_LOG_DIR]))',
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, CHATBAN_DATA_DIR: SENTINEL, CHATBAN_LOG_DIR: SENTINEL },
      encoding: "utf-8",
    }
  );

  assert.equal(r.status, 0, `testEnv.ts の読み込みに失敗した: ${r.stderr}`);
  const [dataDir, logDir] = JSON.parse(r.stdout.trim()) as [string, string];

  for (const [name, dir] of [["CHATBAN_DATA_DIR", dataDir], ["CHATBAN_LOG_DIR", logDir]]) {
    assert.notEqual(
      dir,
      SENTINEL,
      `${name} が外から渡された値のまま。本番のパスが入っていれば、実データの管理DBを開く (#265)`
    );
    assert.ok(
      dir.startsWith(os.tmpdir()),
      `${name} が一時領域の外を指している (${dir})`
    );
  }
});

