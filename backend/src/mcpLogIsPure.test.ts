import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #252 (Codexレビュー P1): **ログ整形を import しただけでDBが開いてはいけない。**
 *
 * `mcpLog.ts` が表・列の一覧を得るために `db.ts` を import したところ、
 * `db.ts` → `store.ts` の連鎖で**モジュール評価時に日常用の管理DBが開いた**。
 * `store.ts` はそこで `ensureAdminSchema()` を走らせる — 古い設定の `DELETE` と
 * 旧テーブルの `DROP TABLE` を含む**移行**である。
 *
 * つまり `cd backend && npm test` を流すだけで、**テストが実データへ移行を適用しうる**
 * 状態になっていた。手元では適用済みで目立たなかったが、古いDBを持つ環境では消える。
 *
 * ## なぜ「開かないこと」を測れるのか
 *
 * `store.ts` はモジュール評価でデータディレクトリを作る。**存在しない場所を指しておいて、
 * import 後もまだ存在しないこと**を見れば、開いていないと言い切れる。 */

const ghost = path.join(os.tmpdir(), `chatban-ghost-${process.pid}`);
process.env.CHATBAN_DATA_DIR = ghost;
process.env.CHATBAN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-purelog-"));

test("mcpLog を読み込んでも、データディレクトリを開かない", async () => {
  assert.ok(!fs.existsSync(ghost), "前提が崩れている (先に作られている)");

  const mod = await import("./mcpLog.js");
  // **番人が本物を見ていること。**import が失敗していたら全部素通りする (#180の教訓)
  assert.equal(typeof mod.redactSql, "function", "mcpLog を読み込めていない");
  assert.ok(mod.MCP_TOOL_NAMES.length >= 8, "中身が取れていない");

  assert.ok(
    !fs.existsSync(ghost),
    `mcpLog を import しただけでデータディレクトリが作られた (${ghost})。` +
      "**store.ts を引き込んでいる** — そこはモジュール評価で管理DBを開き、移行 (DELETE/DROP) を走らせる。" +
      "契約の定数は publicSchema.ts から取ること"
  );
});

test("publicSchema も単体で読めて、DBを開かない", async () => {
  const { PUBLIC_TABLES, PUBLIC_COLUMNS } = await import("./publicSchema.js");
  assert.ok(PUBLIC_TABLES.includes("live_cards"), "表の一覧が取れていない");
  assert.ok(PUBLIC_COLUMNS.includes("done_day"), "列の一覧が取れていない");
  assert.ok(!fs.existsSync(ghost), "publicSchema が何かを開いている (何もimportしない約束)");
});
