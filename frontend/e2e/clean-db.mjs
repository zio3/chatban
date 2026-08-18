// E2E用DBをサーバー起動前に削除する。
// データを残すとタスクが実行のたびに積み上がり、D&Dの座標がずれて落ちるようになる
// (失敗の原因が実装でなくテストの汚れ、という一番タチの悪いやつ)。
//
// #194: **呼ばれる場所は playwright.config.ts の webServer コマンドの前段**。
// 以前は package.json の test:e2e に書いてあったが、`npx playwright test` で直接叩くと
// 素通りした。実測で 56 → 112 → 224件と増え、4件のテストが落ちた。
// トップレベル config やワーカーからは呼ばないこと (複数回走ってWindowsでEBUSYになる)。
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../../backend/e2e-data");

/** 「このディレクトリは消してよい」という印。掃除のたびに置き直す。
 *
 * **パス文字列の見た目で判定しない。**e2e-data と実録の data は中身の構成が同一で
 * (`chatban-admin.db` / `projects/` / `trash/`)、ファイルの有無では見分けられない。
 * 名前で確かめる形 (`endsWith("e2e-data")`) も書いてみたが、**同じリテラルから作った文字列が
 * 同じリテラルで終わるかを見るだけ**で絶対に発火せず、`../` の数を間違えて別の場所を指す
 * という一番危ない取り違えを素通りさせる。守っていないものを守っていると書くほうが危ない
 * (自動レビュー指摘)。
 *
 * 印なら実際に発火する。`backend/data/` にはこの印が無いので、向け先を間違えれば止まる。 */
const MARKER = ".e2e-data";
const markerPath = resolve(target, MARKER);

if (existsSync(target) && !existsSync(markerPath)) {
  throw new Error(
    `${target} に ${MARKER} が無いので消しません。E2E用でないディレクトリを指している可能性があります ` +
      `(backend/data/ はドッグフーディングの実録)。E2E用だと確認できたら手で消してから流し直してください`
  );
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
writeFileSync(markerPath, "E2Eの使い捨てデータ置き場。実行のたびに frontend/e2e/clean-db.mjs が中身ごと消す\n");

// 旧構成 (単一ファイル) の残骸も掃除する
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(resolve(here, `../../backend/e2e-test.db${suffix}`), { force: true });
}
