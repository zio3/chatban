import { defineConfig } from "@playwright/test";

// E2E専用ポート/DB (開発中のdevサーバー・DBと衝突しないように分離)
const BACKEND_PORT = 8799;
const FRONTEND_PORT = 5199;

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
        DB_PATH: "e2e-test.db",
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
