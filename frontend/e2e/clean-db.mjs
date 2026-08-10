// E2E用DBをサーバー起動前に削除する (playwright testの前段で実行)。
// データを残すとタスクが実行のたびに積み上がり、D&Dの座標がずれて落ちるようになる
// (失敗の原因が実装でなくテストの汚れ、という一番タチの悪いやつ)。
//
// ここでやる理由: playwright.config.ts のトップレベルに書くとワーカープロセスでも
// 読み直されて複数回走り、サーバーがDBを掴んだ後の実行がWindowsでEBUSYになる。
// globalSetupも不可 — PlaywrightはwebServerの起動をglobalSetupより先に行う。
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// #86: プロジェクトごとにDBが分かれたのでディレクトリごと消す
rmSync(resolve(here, "../../backend/e2e-data"), { recursive: true, force: true });
// 旧構成 (単一ファイル) の残骸も掃除する
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(resolve(here, `../../backend/e2e-test.db${suffix}`), { force: true });
}
