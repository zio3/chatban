import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #247: **実HTTPで叩いて、入口の記録を確かめる。**
 *
 * `InMemoryTransport` 越しのテストでは足りない (Codexレビュー P2)。
 * **JSON-RPCのバッチはSDKの内側で展開される**ので、アプリ側が
 * `body.method` しか見ていないと**バッチ中の拒否だけが記録から消える**。
 * それは「間違え続けているツールが呼ばれていないように見える」という、
 * この記録が解こうとしている当の問題そのものなので、**入口を通して固定する**。 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-http-"));
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-httplog-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.CHATBAN_LOG_DIR = logDir;
process.env.AUTO_ARCHIVE = "0";
process.env.PORT = "0"; // 空きポートに開く (開発サーバーの 8787 を奪わない)

const { server } = await import("./index.js");

let base = "";

before(async () => {
  if (!server.listening) await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object", "ポートが取れない");
  base = `http://127.0.0.1:${addr.port}/mcp/1`;
});

after(() => {
  server.close();
});

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/** ログはファイルに出る。**この経路はコンソールを捕まえるより、実物を読むほうが確実** */
function logLines(): string[] {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const file = path.join(logDir, `chatban-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.includes("] [mcp] "));
}

let seen = 0;
/** 直前の呼び出しで増えたぶんだけ */
function fresh(): string[] {
  const all = logLines();
  const out = all.slice(seen);
  seen = all.length;
  return out;
}

async function rpc(body: unknown) {
  const res = await fetch(base, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  await res.text();
  return res;
}

const call = (id: number, name: string, args: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

test("単発: 正常も拒否も1行ずつ残る", async () => {
  fresh();
  await rpc(call(1, "sync_board", {}));
  assert.match(fresh().join("\n"), /sync_board ok/, "正常な呼び出しが記録されていない");

  await rpc(call(2, "query_log", {})); // sql が無いのでSDKのZodが弾く
  assert.match(fresh().join("\n"), /query_log NG スキーマで拒否/, "拒否が記録されていない");
});

// **ここがレビューで見つかった穴。**配列だと body.method が常に undefined になり、
// 拒否された呼び出しだけが1行も残らなかった
test("バッチ: 全件が拒否でも、全部記録される", async () => {
  fresh();
  await rpc([call(10, "query_log", {}), call(11, "search_cards", {})]);

  const lines = fresh();
  assert.match(lines.join("\n"), /query_log NG スキーマで拒否/, "バッチ中の拒否が消えている");
  assert.match(lines.join("\n"), /search_cards NG スキーマで拒否/, "2件目の拒否が消えている");
});

test("バッチ: 正常と拒否が混ざっても、拒否だけ消えない", async () => {
  fresh();
  await rpc([call(20, "sync_board", {}), call(21, "query_log", {})]);

  const joined = fresh().join("\n");
  assert.match(joined, /sync_board ok/, "正常なほうが記録されていない");
  assert.match(joined, /query_log NG スキーマで拒否/, "**1件目が届いた時点で残りを見逃している**");
});

// 同じツール名が複数入っていても取り違えないこと (突き合わせは名前ではなく id)
test("バッチ: 同じツールを正常・不正で2回呼んでも、片方だけ拒否として残る", async () => {
  fresh();
  await rpc([call(30, "query_log", { sql: "SELECT id FROM live_cards LIMIT 1" }), call(31, "query_log", {})]);

  const lines = fresh().filter((l) => l.includes("query_log"));
  assert.equal(lines.filter((l) => l.includes("スキーマで拒否")).length, 1, "拒否の件数が合わない");
  assert.equal(lines.filter((l) => / ok \|/.test(l)).length, 1, "正常の件数が合わない");
});

// ---- 漏らさないこと (レビュー P2 の再現ケース) ----

test("未知のキー名に本文を入れても、ログには残らず個数だけになる", async () => {
  fresh();
  await rpc(call(40, "create_cards", { cards: [{ title: "x", "SECRET-顧客情報": "y" }] }));

  const joined = fresh().join("\n");
  assert.ok(!joined.includes("SECRET"), `キー名から本文が漏れている: ${joined}`);
  assert.match(joined, /\+1不明/, `契約に無いキーを使ったことが分からない: ${joined}`);
});

test("キー名に改行を入れても、ログの行数は増やせない (集計を偽装できない)", async () => {
  fresh();
  const forged = "a\n[2099-01-01 00:00:00.000] [mcp] sync_board ok |  | 1ms";
  await rpc(call(41, "create_cards", { cards: [{ title: "x", [forged]: "y" }] }));

  const lines = fresh();
  assert.equal(lines.length, 1, `1回の呼び出しで${lines.length}行出ている (行を作られている)`);
  assert.ok(!lines[0].includes("2099"), "偽の行が混ざっている");
});

test("未登録のツール名は平文で残さない", async () => {
  fresh();
  await rpc(call(42, "評価用の-SECRET-な名前", {}));

  const joined = fresh().join("\n");
  assert.ok(!joined.includes("SECRET"), `ツール名がそのまま残っている: ${joined}`);
});

// **契約にある正当なキーが「不明」に落ちていないこと。**
// 落ちても壊れはしないが、「どの項目が使われているか」を数えるという目的が鈍る
test("正当な引数は「不明」に数えられない", async () => {
  fresh();
  await rpc(
    call(50, "create_cards", {
      cards: [{ title: "全部入り", status: "todo", context: "経緯", summary: "要約", due: "2026-09-01" }],
      sync_token: "dummy",
    })
  );

  const joined = fresh().join("\n");
  assert.ok(!joined.includes("不明"), `契約にあるキーが不明に落ちている: ${joined}`);
  assert.match(joined, /cards\[1\]\{[^}]*due[^}]*\} sync_token/, `キーの顔ぶれが出ていない: ${joined}`);
});
