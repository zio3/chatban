import { defineConfig } from "@playwright/test";

// E2E専用ポート/DB (開発中のdevサーバー・DBと衝突しないように分離)
const BACKEND_PORT = 8799;
const FRONTEND_PORT = 5199;

// E2Eデータのリセットは e2e/clean-db.mjs (test:e2e の前段) で行う

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
      command: "npm run start",
      cwd: "../backend",
      port: BACKEND_PORT,
      reuseExistingServer: false,
      env: {
        PORT: String(BACKEND_PORT),
        // #86: プロジェクトごとにDBが分かれたので、E2Eは専用のデータディレクトリを使う
        // (存在しなければ空のプロジェクトが1つ自動生成される)
        CHATBAN_DATA_DIR: "e2e-data",
        AUTO_ARCHIVE: "0", // #200: Done列の畳み直しを止める (テストはDoneを1件ずつ見たい)
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
