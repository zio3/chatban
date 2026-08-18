// E2E用DBをサーバー起動前に削除する (playwright testの前段で実行)。
// データを残すとタスクが実行のたびに積み上がり、D&Dの座標がずれて落ちるようになる
// (失敗の原因が実装でなくテストの汚れ、という一番タチの悪いやつ)。
//
// #194: **呼ばれる場所は playwright.config.ts の webServer コマンドの前段**。
// 以前は package.json の test:e2e に書いてあったが、`npx playwright test` で直接叩くと
// 素通りした。実測で 56 → 112 → 224件と増え、4件のテストが落ちた。
// トップレベル config やワーカーからは呼ばないこと (複数回走ってWindowsでEBUSYになる)。
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// **消す先を間違えると実録データが飛ぶ** (backend/data/ はドッグフーディングの実録)。
// パスは相対でしか組み立てないが、消す直前に名前を確かめる (cwd に依存しない防御)
const target = resolve(here, "../../backend/e2e-data");
if (!target.endsWith("e2e-data")) throw new Error(`消す先がおかしい: ${target}`);
// #86: プロジェクトごとにDBが分かれたのでディレクトリごと消す
rmSync(target, { recursive: true, force: true });
// 旧構成 (単一ファイル) の残骸も掃除する
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(resolve(here, `../../backend/e2e-test.db${suffix}`), { force: true });
}
