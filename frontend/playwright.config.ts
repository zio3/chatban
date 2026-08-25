import { defineConfig } from "@playwright/test";

// E2E専用ポート/DB (開発中のdevサーバー・DBと衝突しないように分離)
const BACKEND_PORT = 8799;
const FRONTEND_PORT = 5199;

// **E2Eは有料のLLM呼び出しを起こす (#219)。**「鍵が無いから安全」ではない —
// 下の env はキーを消しておらず、backend/config.json がそのまま読まれる。
// **テストを足すときは「LLMを踏むか」を見ること。**踏むなら、その1回に見合う価値をコメントに書く。
//
// 桁の目安として一度だけ数えた。**仕様ではなくその日のスナップショットで、見積もりには使えない**
// (テストの増減・順序・失敗時の早期終了で変わる): 2026-08-20 の全走1回で 8回
// (画面を開くたびの suggest ×5 / chat ×3)。**ゼロではなく1桁**、が読み取ってほしいところ。
// 数えるなら backend/e2e-data/logs/chatban-YYYY-MM-DD.log の `[llm] -> ` 行を数える。
//
// **#253 で出し先を分けた。**以前はここに「自動で数える仕掛けは作らない — devサーバー(8787)と
// 同じファイルに書くので混ざる」と書いていた。その前提はもう無い。下の CHATBAN_LOG_DIR で
// E2E専用のディレクトリへ出し、clean-db.mjs が実行のたびに消すので、**残っているのは
// 直近1回ぶんだけ**。時刻で切り出す必要も無くなった。
// (ログ行に出し元を入れる案は採らなかった。**分けられるなら、混ぜてから見分けるより分けるほうが安い**)

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
        // #253: ログも分ける。**同じファイルに書くと、#247 で記録している「どのツールが
        // 呼ばれているか」がテストのぶんで埋まる** (実測 2026-08-24: MCP呼び出し862件のうち
        // 728件=84%がE2E)。e2e-data の下なので gitignore 済みで、clean-db.mjs が
        // 実行のたびに消す = 1回ぶんだけが残る
        CHATBAN_LOG_DIR: "e2e-data/logs",
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
