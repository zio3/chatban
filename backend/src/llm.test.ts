import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #182: **どちらのAPI形式で話すかが `apiStyle` で決まること**を、実際に叩かれた
 * エンドポイントで確かめる。
 *
 * `apiStyle` の値を読むだけのテストでは足りない (Codexレビュー指摘: 分岐の条件を反転しても
 * 全テストが通る状態だった)。**経路の分岐は「どこへリクエストが飛んだか」でしか確かめられない**
 * ので、宛先のサーバーを立てて到達を記録する。
 *
 * 以前は `usesMessagesApi(model)` がモデルIDの `anthropic/` 接頭辞で決めていた。
 * その判定は OrcaRouter が `provider/model` 形式を要求することに乗ったもので、
 * 直接APIのモデルID (`gpt-...` / `claude-...`) には接頭辞が無いため成立しない。
 *
 * **サーバーは1つだけ立てて使い回す。**`llm.ts` の OpenAI クライアントは最初の設定で作られて
 * モジュールに保持される (本番では設定が不変なので問題にならない) ため、テストごとに宛先を
 * 立て替えると、閉じたサーバーを掴んだままになる。 */

// **実データに触らせない。**store.ts はモジュール読み込み時に管理DBを開く (`export const admin`) ので、
// llm.js を読み込む前にデータディレクトリを一時領域へ向ける
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-llmtest-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.CHATBAN_LOG_BODIES = "0"; // logs/ を汚さない

const { chatCompletion } = await import("./llm.js");
const { __setLlmConfigForTest } = await import("./config.js");

const SECRET = "sk-secret-reflected-12345";
/** このモデル名で呼ぶと、受け取ったキーをエラー本文に含めて返す (意地悪な互換宛先の再現) */
const REFLECT = "reflect-key";

const hits: string[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push(req.url ?? "");
    const model = (() => {
      try {
        return JSON.parse(body).model;
      } catch {
        return "";
      }
    })();
    if (model === REFLECT) {
      const auth = String(req.headers.authorization ?? req.headers["x-api-key"] ?? "").replace(/^Bearer /, "");
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `invalid key: ${auth}` } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if ((req.url ?? "").endsWith("/messages")) {
      // Anthropic Messages API の形
      res.end(
        JSON.stringify({
          model: "test-model",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1 },
        })
      );
    } else {
      // OpenAI互換の形
      res.end(
        JSON.stringify({
          id: "1",
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })
      );
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const baseURL = `http://127.0.0.1:${(server.address() as any).port}/v1`;

function useStyle(apiStyle: "chat" | "messages", main = "test-model") {
  hits.length = 0;
  __setLlmConfigForTest({
    apiKey: SECRET,
    baseURL,
    apiStyle,
    models: { main },
  });
}

test('apiStyle="chat" なら /v1/chat/completions だけが叩かれる', async () => {
  useStyle("chat");
  const res: any = await chatCompletion("t", "test-model", { messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(hits, ["/v1/chat/completions"]);
  assert.equal(res.choices[0].message.content, "ok");
});

test('apiStyle="messages" なら /v1/messages だけが叩かれる', async () => {
  useStyle("messages");
  const res: any = await chatCompletion("t", "test-model", { messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(hits, ["/v1/messages"]);
  // Anthropicの応答が OpenAI の形に均されて返る (呼び出し側は1つの形しか知らない)
  assert.equal(res.choices[0].message.content, "ok");
  assert.equal(res.choices[0].finish_reason, "stop");
});

test("経路はモデルIDの接頭辞では変わらない (設定だけで決まる)", async () => {
  // 以前は `anthropic/` で始まるモデルIDが Messages 経路へ流れていた。
  // いまは設定が chat なら、モデル名が何であれ chat 経路
  useStyle("chat", "anthropic/claude-haiku-4.5");
  await chatCompletion("t", "anthropic/claude-haiku-4.5", { messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(hits, ["/v1/chat/completions"], "モデルIDの接頭辞で経路が変わっている");
});

test("上流のエラー本文に混ざったAPIキーは、両経路とも伏せられて返る", async () => {
  // 互換宛先が認証失敗時に受け取ったキーを返す状況。この本文はログにもHTTP応答にも流れる
  for (const apiStyle of ["chat", "messages"] as const) {
    useStyle(apiStyle, REFLECT);
    await assert.rejects(
      () => chatCompletion("t", REFLECT, { messages: [{ role: "user", content: "hi" }] }),
      (e: any) => {
        const msg = String(e.message);
        assert.ok(!msg.includes(SECRET), `${apiStyle} 経路でキーが漏れている: ${msg}`);
        assert.match(msg, /\*\*\*/, `${apiStyle} 経路で伏字が入っていない: ${msg}`);
        return true;
      }
    );
  }
});

test.after(() => {
  server.close();
  // better-sqlite3 が開いた管理DBを閉じる口が無いので、消せないことがある (EBUSY)。
  // 一時ディレクトリなのでOSに任せる — 消せなかったことでテストを失敗させない
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 開いたままなら諦める */
  }
});
