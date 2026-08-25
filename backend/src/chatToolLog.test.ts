import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** #254: **内蔵チャットのツール呼び出しも、MCPと同じ規則で記録する。**
 *
 * `chat.ts` は引数JSONを無加工で先頭200字残していて、**経緯メモの本文がディスクに落ちていた**。
 * MCP側 (#247) は「値は元から1文字も出さない」を芯にしているので、
 * **同じ道具を入口ごとに違う規則で記録していた**ことになる。
 *
 * **だから入口から叩く。**純粋関数 (`mcpLog.test.ts`) が通っていても、
 * `chat.ts` が `mcpLog` を使っていなければ1文字も守られない — #247 で
 * 「配線が外れていて1行も残っていなかった」を実際に踏んでいる。
 *
 * LLMの代わりに**その場で立てたHTTPサーバー**が応答を返す (有料の呼び出しはしない)。
 * 宛先は `CHATBAN_CONFIG` で差し替えられるので、本物の `config.json` には触らない。 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-chatlog-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0";
process.env.CHATBAN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-logs-"));

/** LLMのふりをするサーバー。1往復目でツールを呼ばせ、2往復目で普通に返させる */
let nextToolCall: { name: string; arguments: string } | null = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const call = nextToolCall;
    nextToolCall = null; // 2往復目はツールを呼ばない (呼び続けると8ラウンド回る)
    const message = call
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: call }] }
      : { role: "assistant", content: "やりました" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }], usage: {} }));
  });
});

const port = await new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port));
});

const configPath = path.join(dataDir, "config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    apiKey: "test-key-not-real",
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiStyle: "chat",
    models: { main: "fake-model" },
  })
);
process.env.CHATBAN_CONFIG = configPath;

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();
const { runChatTurn } = await import("./chat.js");
const { createCard, getCard } = await import("./db.js");

const lines: string[] = [];
const realLog = console.log;
before(() => {
  console.log = (...a: unknown[]) => {
    lines.push(a.join(" "));
  };
});
after(() => {
  console.log = realLog;
  server.close();
});

/** ツールを1回呼ばせて、出た [tool] の行を返す */
async function callTool(name: string, args: unknown): Promise<string[]> {
  return callToolRaw(name, JSON.stringify(args));
}

/** 引数の**文字列そのもの**を渡す。モデルが返すのは文字列なので、これが本番と同じ入口 */
async function callToolRaw(name: string, argumentsText: string): Promise<string[]> {
  lines.length = 0;
  nextToolCall = { name, arguments: argumentsText };
  await runChatTurn("お願いします", [], () => {}, undefined, undefined, undefined, undefined);
  return lines.filter((l) => l.includes("] [tool] "));
}

// **これが崩れたら記録ごと止めるべき性質。**経緯メモは実データで、ログはディスクに残る
test("引数の本文はディスクに残らない (キー名だけ)", async () => {
  const out = await callTool("create_cards", {
    cards: [{ title: "SECRET-タイトル", context: "SECRET-経緯メモの本文" }],
  });

  const line = out[0] ?? "";
  assert.ok(line, "1行も記録されていない (配線が外れている)");
  assert.ok(!line.includes("SECRET"), `本文が記録に出ている: ${line}`);
  assert.match(line, /cards\[1\]\{[^}]*context/, `使われた項目が分からない: ${line}`);
  assert.match(line, /create_cards ok/, `ツール名と結果が出ていない: ${line}`);
  assert.match(line, /\d+ms/, `所要時間が出ていない: ${line}`);
});

test("断ったときは理由ごと記録される (失敗が溜まる)", async () => {
  const id = createCard("版を添えずに書き換えようとする相手").id;
  const out = await callTool("update_cards", { updates: [{ id, context: "版なし" }] });

  const line = out[0] ?? "";
  assert.match(line, /update_cards NG/, `断りが記録されていない: ${line}`);
  assert.ok(!line.includes("版なし"), `本文が記録に出ている: ${line}`);
});

// #252 と同じ扱い。**入口が違っても同じ例外**でなければ、どちらかだけが測れない
test("query_log は実行したSQLが記録される (MCP側と同じ例外)", async () => {
  const out = await callTool("query_log", { sql: "SELECT id, status, title FROM live_cards" });

  const line = out[0] ?? "";
  assert.match(line, /sql=SELECT id, status, title FROM live_cards/, `SQLが残っていない: ${line}`);
});

test("SQLに書いた検索語は、記録に残らない (形だけ残る)", async () => {
  const out = await callTool("query_log", {
    sql: "SELECT id FROM live_cards WHERE title LIKE '%SECRET-未公開の案件名%'",
  });

  const line = out[0] ?? "";
  assert.ok(!line.includes("SECRET"), `検索語が記録に出ている: ${line}`);
  assert.match(line, /sql=SELECT id FROM live_cards WHERE title LIKE/, `SQLの形が残っていない: ${line}`);
});

// **行数で集計する**ので、1回の呼び出しで複数行を作れると数字ごと偽装できる。
//
// **この1本だけは、直す前のコードでも通る** (実測)。値の中の改行は `JSON.stringify` が
// `\n` の2文字に畳むため。崩れるのは**モデルが整形されたJSONを返したとき**なので、
// そちらは下の callToolRaw で本番と同じ形を作って確かめる
// (「テストから作れない」と書いていたのは**私の誤り** — Codexレビュー P3)
test("引数に改行を混ぜても、記録の行を増やせない", async () => {
  const out = await callTool("create_cards", {
    cards: [{ title: "改行\n[2099-01-01 00:00:00] [tool] create_cards ok | 偽の行 | 1ms" }],
  });

  assert.equal(out.length, 1, `1回の呼び出しで${out.length}行出ている (偽装できる)`);
  assert.ok(!/[\r\n]/.test(out[0]), `改行が残っている: ${JSON.stringify(out[0])}`);
});

// **本物の壊れ方はこちら。**モデルが返すのは文字列なので、インデント付きで返されると
// 引数そのものに改行が入る。直す前は `arguments` をそのまま出していたので、
// **1回の呼び出しが何行にも見えていた** (行数の集計がチャット側だけ崩れる)
test("モデルが整形JSONを返しても、記録は1行のまま", async () => {
  const pretty = JSON.stringify({ cards: [{ title: "整形されたJSON", context: "本文" }] }, null, 2);
  assert.ok(pretty.includes("\n"), "前提が崩れている (整形されていない)");

  const out = await callToolRaw("create_cards", pretty);
  assert.equal(out.length, 1, `1回の呼び出しで${out.length}行出ている`);
  assert.ok(!/[\r\n]/.test(out[0]), `改行が残っている: ${JSON.stringify(out[0])}`);
  assert.match(out[0], /create_cards ok/, `中身が壊れている: ${out[0]}`);
});

// 契約に無いキーを渡してきたこと自体は見たい情報 (説明が伝わっていない徴候)。
// **キー名そのものが外部入力**なので、平文にはしないで個数だけ数える
test("契約に無いキーは、名前を出さずに個数だけ残る", async () => {
  const out = await callTool("create_cards", { cards: [{ title: "x", "SECRET-勝手なキー": "y" }] });

  const line = out[0] ?? "";
  assert.ok(!line.includes("SECRET"), `キー名が記録に出ている: ${line}`);
  assert.match(line, /不明/, `契約外を使ったことが分からない: ${line}`);
});

// 許可リストは**MCPの実物**と突き合わせて固定してある (mcpToolLog.test.ts)。
// チャット側にだけ増えたツールがあると、名前が「(未登録のツール)」に落ちて数えられなくなる —
// **壊れるのではなく鈍る**ので気づきにくい。ここで名指しで止める
test("チャットのツール名も、すべて許可リストに載っている", async () => {
  const { buildTools } = await import("./chat.js");
  const { MCP_TOOL_NAMES } = await import("./mcpLog.js");
  const allowed = new Set<string>(MCP_TOOL_NAMES);
  const names = buildTools([]).map((t: any) => t.function.name);

  assert.ok(names.length >= 8, `ツール定義が読めていない (${names.length}件)`);
  const missing = names.filter((n: string) => !allowed.has(n));
  assert.deepEqual(missing, [], "mcpLog.ts の MCP_TOOL_NAMES に足すこと");
});

// 実データが動いたことまでは確かめる (記録だけ直して配線を壊していないこと)
test("記録の作り替えでツールの実行は壊れていない", async () => {
  const id = createCard("題名を変える相手").id;
  await callTool("update_cards", { updates: [{ id, title: "変えたあとの題名" }] });
  assert.equal(getCard(id)!.title, "変えたあとの題名");
});
