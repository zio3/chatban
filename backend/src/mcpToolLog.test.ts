import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** #247: **本物のMCPクライアントから叩いて、記録が残ることを確かめる。**
 *
 * 純粋関数 (mcpLog.test.ts) だけ通っていても、**配線が外れていれば1行も残らない**。
 * 実際そうだった — 直近5日でMCP経由の呼び出しは1行も記録されていなかった。
 * だから**入口から叩く** (#245 の chatToolWiring と同じ考え方)。 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-mcplog-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0";
// #247: 実ログに混ぜない (テストの呼び出しが「呼ばれている」に数えられてしまう)
process.env.CHATBAN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-logs-"));

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { buildMcpServer } = await import("./mcp.js");
const { MCP_TOOL_NAMES } = await import("./mcpLog.js");
const { createCard } = await import("./db.js");

let client: Client;
/** log() はコンソールとファイルの両方に出す。ここではコンソール側を捕まえる */
const lines: string[] = [];
const realLog = console.log;

before(async () => {
  console.log = (...a: unknown[]) => {
    lines.push(a.join(" "));
  };
  const server = buildMcpServer(() => {});
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(s), client.connect(c)]);
});

after(() => {
  console.log = realLog;
});

/** 直前の呼び出しで出た [mcp] の行 */
function mcpLines(): string[] {
  return lines.filter((l) => l.includes("] [mcp] "));
}

test("読み取りの呼び出しが記録される (ツール名・結果・所要時間)", async () => {
  lines.length = 0;
  await client.callTool({ name: "sync_board", arguments: {} });

  const [line, ...rest] = mcpLines();
  assert.ok(line, "1行も記録されていない (配線が外れている)");
  assert.deepEqual(rest, [], "1回の呼び出しで複数行出ている");
  assert.match(line, /sync_board ok/);
  assert.match(line, /\d+ms$/, "所要時間が出ていない");
});

test("断ったときは理由ごと記録される (失敗が溜まる)", async () => {
  lines.length = 0;
  const id = createCard("版を添えずに書き換えようとする相手").id;
  await client.callTool({ name: "update_cards", arguments: { updates: [{ id, context: "版なし" }] } });

  const line = mcpLines()[0] ?? "";
  assert.match(line, /update_cards NG/, `断りが記録されていない: ${line}`);
  assert.match(line, /版が合わない/, `何が起きたかが残っていない: ${line}`);
});

// **これが崩れたら記録ごと止めるべき性質。**経緯メモは実データで、ログはディスクに残る
test("引数の本文はディスクに残らない (キー名だけ)", async () => {
  lines.length = 0;
  await client.callTool({
    name: "create_cards",
    arguments: { cards: [{ title: "SECRET-タイトル", context: "SECRET-経緯メモの本文" }] },
  });

  const line = mcpLines()[0] ?? "";
  assert.ok(line, "記録されていない");
  assert.ok(!line.includes("SECRET"), `本文が記録に出ている: ${line}`);
  assert.match(line, /cards\[1\]\{[^}]*context/, `使われた項目が分からない: ${line}`);
});

// 「呼ばれている / 呼ばれていない」を数えるのが目的なので、**どのツールでも等しく残る**必要がある
test("どのツールでも記録される (登録の抜けが無い)", async () => {
  lines.length = 0;
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.length >= 8, `ツールが読めていない (${tools.length}件)`);

  const args: Record<string, unknown> = {
    search_cards: { terms: ["版"] },
    get_project_context: {},
    query_log: { sql: "SELECT id FROM live_cards LIMIT 1" },
  };
  for (const [name, a] of Object.entries(args)) {
    lines.length = 0;
    await client.callTool({ name, arguments: a as Record<string, unknown> });
    assert.match(mcpLines()[0] ?? "", new RegExp(`${name} `), `${name} が記録されていない`);
  }
});

// **ここで見つけた穴。**引数がスキーマに合わないと、SDKのZodが先に弾くのでハンドラまで来ない。
// 実測: `query_log` を引数なしで呼ぶと**1行も記録されなかった**。
// 「間違え続けているツール」が「呼ばれていない」に見えると、この記録の結論が逆になるので、
// 入口 (index.ts) 側で「受けたのに届かなかった」を拾う。ここではその通知口が動くことだけ見る
test("スキーマで弾かれた呼び出しは、ハンドラまで来ない (入口側で拾う必要がある)", async () => {
  lines.length = 0;
  await client.callTool({ name: "query_log", arguments: {} }).catch(() => {});

  assert.deepEqual(mcpLines(), [], "SDKが弾いたのにハンドラが動いている");
});

test("ハンドラが動いたときは通知口が呼ばれる (入口側の突き合わせが成り立つ)", async () => {
  let handled = 0;
  const server = buildMcpServer(
    () => {},
    () => {
      handled += 1;
    }
  );
  const [c, s] = InMemoryTransport.createLinkedPair();
  const cl = new Client({ name: "test2", version: "0" });
  await Promise.all([server.connect(s), cl.connect(c)]);

  await cl.callTool({ name: "sync_board", arguments: {} });
  assert.equal(handled, 1, "通知口が呼ばれていない");

  await cl.callTool({ name: "query_log", arguments: {} }).catch(() => {});
  assert.equal(handled, 1, "SDKが弾いたのに届いたことになっている");
});

// **許可リストが実物とズレると、正当なツール名が「(未登録のツール)」になって数えられなくなる。**
// 未知の名前を平文にしないための許可リストなので、実物と突き合わせて固定しておく
test("ツール名の許可リストが、実際に登録されているものと一致する", async () => {
  const actual = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual([...MCP_TOOL_NAMES].sort(), actual, "mcpLog.ts の MCP_TOOL_NAMES を合わせること");
});

// #252: **説明を削る前に測る。**`query_log` の説明はチャットのツール定義の35%を占めるのに
// (3482/9924字、2026-08-25実測)、呼ばれるのは `update_cards` の3分の1。
// 削る候補は例文11本 (1122字) だが、キー名だけでは**どの例文が真似されているか数えられない**
test("query_log は実行したSQLが記録される", async () => {
  lines.length = 0;
  await client.callTool({
    name: "query_log",
    arguments: { sql: "SELECT id, status, title FROM live_cards" },
  });

  const line = mcpLines()[0] ?? "";
  assert.match(line, /query_log ok/, `記録されていない: ${line}`);
  assert.match(line, /sql=SELECT id, status, title FROM live_cards/, `SQLが残っていない: ${line}`);
});

// **値を出す例外はここ1つに閉じている**こと。これが崩れたら記録ごと止めるべき性質
test("他のツールは、値を出さないまま (例外が広がっていない)", async () => {
  lines.length = 0;
  await client.callTool({
    name: "create_cards",
    arguments: { cards: [{ title: "SECRET-題名", context: "SECRET-経緯", summary: "SECRET-要約" }] },
  });
  await client.callTool({ name: "search_cards", arguments: { terms: ["SECRET-検索語"] } });

  for (const line of mcpLines()) assert.ok(!line.includes("SECRET"), `本文が記録に出ている: ${line}`);
});

// #247 で「キー名をそのまま出す」を潰したのと同じ攻撃。**行数で集計する**ので、
// 1回の呼び出しで複数行を作れると数字ごと偽装できる
test("SQLに改行を混ぜても、記録の行を増やせない", async () => {
  lines.length = 0;
  await client
    .callTool({
      name: "query_log",
      arguments: { sql: "SELECT 1\n[2099-01-01 00:00:00] [mcp] query_log ok | sql | 1ms" },
    })
    .catch(() => {});

  const out = mcpLines();
  assert.equal(out.length, 1, `1回の呼び出しで${out.length}行出ている (偽装できる)`);
  // **中身として残るのは構わない。**危ないのは「行が増えること」なので、
  // 改行が潰れて1行に収まっていることを見る (偽の時刻が本文に混ざるのは無害)
  assert.ok(!/[\r\n]/.test(out[0]), `改行が残っている: ${JSON.stringify(out[0])}`);
});

// #252 (Codexレビュー P2): **利用者の言葉がログへ複製されないこと。**
// 「検索語をSQLに写す」のは異常系ではなく**普通の使い方**なので、ここは実際に流して確かめる
test("SQLに書いた検索語は、記録に残らない (形だけ残る)", async () => {
  lines.length = 0;
  await client
    .callTool({
      name: "query_log",
      arguments: { sql: "SELECT id FROM live_cards WHERE title LIKE '%SECRET-未公開の案件名%'" },
    })
    .catch(() => {});

  const line = mcpLines()[0] ?? "";
  assert.ok(line, "記録されていない");
  assert.ok(!line.includes("SECRET"), `検索語が記録に出ている: ${line}`);
  // **形は残る。**これが無いと「どの例文を真似したか」を測れず、変更の意味が消える
  assert.match(line, /sql=SELECT id FROM live_cards WHERE title LIKE/, `SQLの形が残っていない: ${line}`);
});

// SQLiteの例外文は入力をそのまま載せる (`unrecognized token near …`)
test("SQLiteの失敗理由に入力が混じっても、記録には出ない", async () => {
  lines.length = 0;
  await client
    .callTool({ name: "query_log", arguments: { sql: "SELECT * FROM cards WHERE t = SECRET-未公開の案件名" } })
    .catch(() => {});

  const line = mcpLines()[0] ?? "";
  assert.ok(line, "記録されていない");
  assert.ok(!line.includes("SECRET"), `例外文に入力が混じって出ている: ${line}`);
  assert.match(line, /query_log NG/, `失敗として記録されていない: ${line}`);
});

// #256: MCPからも同じ規則で残る (入口ごとに書き分けない)
test("goal は引けなかったときだけ残る (MCPも同じ)", async () => {
  lines.length = 0;
  await client
    .callTool({ name: "query_log", arguments: { sql: "SELECT id FROM live_cards", goal: "SECRET-成功した回" } })
    .catch(() => {});
  assert.ok(!(mcpLines()[0] ?? "").includes("SECRET"), `成功した回の目的が残っている: ${mcpLines()[0]}`);

  lines.length = 0;
  await client
    .callTool({ name: "query_log", arguments: { sql: "SELECT id FROM 存在しない表", goal: "何件あるか見たかった" } })
    .catch(() => {});
  const line = mcpLines()[0] ?? "";
  assert.match(line, /query_log NG/, `失敗として記録されていない: ${line}`);
  assert.match(line, /goal=何件あるか見たかった/, `目的が残っていない: ${line}`);
});
