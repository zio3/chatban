import { defineConfig } from "@playwright/test";

// E2E専用ポート/DB (開発中のdevサーバー・DBと衝突しないように分離)
const BACKEND_PORT = 8799;
const FRONTEND_PORT = 5199;

// E2Eデータのリセットは backend の webServer コマンドの前段で行う (e2e/clean-db.mjs)。
//
// **npm script ではなく webServer に置く。**#194: 以前は package.json の test:e2e に
// `node e2e/clean-db.mjs && playwright test` と書いてあったが、`npx playwright test` で
// 直接叩くと素通りする。実測 (2026-08-18): 素通りで3回回すと生きているタスクが
// 56 → 112 → 224、プロジェクトDBが 7 → 13 → 25 に増え、**4件のテストが落ちた**
// (失敗の原因が実装でなくテストの汚れ、という一番タチの悪いやつ)。
// ここなら実行1回につき1回、サーバーがDBを掴む前に必ず走る。
//
// トップレベルに書くとワーカープロセスでも読み直されて複数回走り、サーバーがDBを
// 掴んだ後の実行がWindowsでEBUSYになる。globalSetupも不可 —
// PlaywrightはwebServerの起動をglobalSetupより先に行う。

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1, // 同一DBを共有するので直列
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // 掃除 → 起動。cwd が backend なので clean-db.mjs は ../frontend 側を指す
      command: "node ../frontend/e2e/clean-db.mjs && npm run start",
      cwd: "../backend",
      port: BACKEND_PORT,
      reuseExistingServer: false,
      env: {
        PORT: String(BACKEND_PORT),
        // #86: プロジェクトごとにDBが分かれたので、E2Eは専用のデータディレクトリを使う
        // (存在しなければ空のプロジェクトが1つ自動生成される)
        CHATBAN_DATA_DIR: "e2e-data",
        AUTO_ARCHIVE: "0", // #200: Done列の畳み直しを止める (テストはDoneを1件ずつ見たい)
        // #209: 起動猶予を無効にする。E2Eはサーバーを起動した直後に走るので、
        // 猶予が効いていると提案が一度も始まらず「中断する相手がいない」状態になる (#162のテスト)
        SUGGEST_BOOT_GRACE_MS: "0",
        // #209: 提案キャッシュも切る。キャッシュがボードの中身を見なくなったので、
        // テストが「ボードを変えて外す」手を使えない (#162の中断テストはLLM呼び出しが実際に走る必要がある)
        SUGGEST_TTL_MS: "0",
      },
    },
    {
      command: `npm run dev -- --port ${FRONTEND_PORT} --strictPort`,
      port: FRONTEND_PORT,
      reuseExistingServer: false,
      env: {
        BACKEND_URL: `http://localhost:${BACKEND_PORT}`,
      },
    },
  ],
});
