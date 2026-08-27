import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

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

/** **番人そのものが効いているか。**`store.ts` の入口は「テスト中なのに行き先が指定されていない」
 * ときだけ落ちる。ここが黙って消えると、上の1枚目が外れたときに**気づかないまま実データを開く**。 */
test("行き先の指定が無いままのテスト実行は、store.ts の入口で止まる (#265)", () => {
  const source = fs.readFileSync(new URL("./store.ts", import.meta.url), "utf-8");
  assert.match(
    source,
    /process\.env\.NODE_TEST_CONTEXT && !process\.env\.CHATBAN_DATA_DIR/,
    "store.ts の入口から番人が消えている。testEnv.ts が外れても静かに実データを開くようになる (#265)"
  );
});

/** **いま実際に一時領域を指しているか。**上の2つはソースと設定を見るだけなので、
 * 読み込みの順序が変わって効かなくなった (先に store.ts が評価される等) 場合に気づけない。 */
test("テスト実行中の行き先は、実データの data/ ではない (#265)", () => {
  const dir = process.env.CHATBAN_DATA_DIR;
  assert.ok(dir, "CHATBAN_DATA_DIR が置かれていない");
  assert.notEqual(dir, "data", "実データのディレクトリを指している");
  assert.ok(!/[\/]backend[\/]data$/.test(dir!), `実データのディレクトリを指している (${dir})`);
});
