// #265: **テストが実データの管理DBを開かないようにする入口。**
//
// `store.ts` は**モジュール評価時に** `data/chatban-admin.db` を開き、`ensureAdminSchema()` を走らせる。
// この移行には古い設定の `DELETE` と旧テーブルの `DROP TABLE` が含まれるので、
// **`npm test` を流すだけで実データへ移行が当たりうる**。
//
// これを各テストファイルの先頭で `process.env.CHATBAN_DATA_DIR = ...` と書く約束にしていたが、
// **書き忘れが12件たまり、文書 (`mcpLogIsPure.test.ts`) と先例 (#264) があってもまた踏んだ**。
// 人の注意では止まらないので、**書かなくても守られる側**に倒す。
//
// これは `package.json` の test スクリプトから `--import` で先に読み込まれる。
// 既に置いてあるテストファイルの指定は**上書きしない** (それぞれ固有の下ごしらえを持っているため)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

process.env.CHATBAN_DATA_DIR ??= temp("chatban-test-data-");
process.env.CHATBAN_LOG_DIR ??= temp("chatban-test-log-");
// 実データを触らないだけでなく、**テスト中に勝手にアーカイブが走らない**ようにもする
process.env.AUTO_ARCHIVE ??= "0";
