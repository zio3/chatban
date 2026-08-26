import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #263: **`GET /api/chat/log` は件数を受け取らない。**
 *
 * 以前は `?limit=` をそのまま `listChatMessages` に渡していたので、`?limit=99999` で
 * 全会話が返った。渡している呼び出し元は1つも無かった (画面は `cardId` だけを渡す)。
 *
 * **`docs/security.md` には「直近50件が既定」と書いてある。**既定であって上限ではない、
 * という状態が残っていると、読んだ人の理解と実装がずれる (#262 のレビュー3周は
 * すべて「文書が実装より広く/狭く見える」だった。これは**実装を文書に寄せる**版)。
 *
 * **入口を通して確かめる。**`listChatMessages` を直接呼ぶだけだと、
 * 経路がクエリを拾い直しても通ってしまう (#259 で実際にそれをやった)。 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-loglimit-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.CHATBAN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-loglimitlog-"));
process.env.AUTO_ARCHIVE = "0";
process.env.PORT = "0"; // 空きポートに開く (開発サーバーの 8787 を奪わない)

const { server } = await import("./index.js");
const { saveChatMessage, CHAT_LOG_LIMIT } = await import("./db.js");

let base = "";
const TOTAL = CHAT_LOG_LIMIT + 20; // 上限より確実に多く積む

before(async () => {
  if (!server.listening) await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object", "ポートが取れない");
  base = `http://127.0.0.1:${addr.port}`;
  for (let i = 0; i < TOTAL; i++) saveChatMessage(i % 2 === 0 ? "user" : "assistant", `発言${i}`);
});

after(() => {
  server.close();
});

async function log(query = ""): Promise<{ content: string }[]> {
  const res = await fetch(`${base}/api/chat/log${query}`);
  assert.equal(res.status, 200, `取得に失敗した (${query})`);
  return ((await res.json()) as any).messages;
}

test("件数を指定しなければ、直近の上限ぶんが返る", async () => {
  const messages = await log();
  assert.equal(messages.length, CHAT_LOG_LIMIT);
  // 直近なので、末尾は最後に積んだもの。**古いほうから50件ではない**
  assert.equal(messages.at(-1)?.content, `発言${TOTAL - 1}`);
});

test("limit を指定しても増えない (口ごと閉じた)", async () => {
  for (const q of ["?limit=99999", "?limit=1", "?limit=abc"]) {
    const messages = await log(q);
    assert.equal(messages.length, CHAT_LOG_LIMIT, `${q} が効いている (件数を外から動かせる)`);
  }
});

// **積んだのはメインチャットだけ** (card_id なし)。カード専用と混ざらないことは
// #262 の3周目で文書に明記した線なので、ここでも固定しておく
test("cardId の扱いは変えていない", async () => {
  assert.equal((await log("?cardId=1")).length, 0, "メインチャットの発言がカード側に漏れている");
});
