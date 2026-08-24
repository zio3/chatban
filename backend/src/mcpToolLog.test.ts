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
