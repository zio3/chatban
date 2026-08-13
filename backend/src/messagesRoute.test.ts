import assert from "node:assert/strict";
import test from "node:test";
import { toAnthropicMessages, toAnthropicTools, toOpenAiShape, usesMessagesApi } from "./messagesRoute.js";

/** #172: OpenAI形式 ⇄ Anthropic Messages API 形式の変換。
 *
 * ここが壊れると「ツールを呼んだのに結果が渡らない」「会話が続かない」形で失敗する。
 * 変換は純粋関数なので、DBもサーバーも要らずに確かめられる */

test("経路の判定はモデルIDだけで決まる (設定も環境変数も足さない)", () => {
  assert.equal(usesMessagesApi("anthropic/claude-haiku-4.5"), true);
  assert.equal(usesMessagesApi("openai/gpt-5.4-mini-2026-03-17"), false);
  assert.equal(usesMessagesApi("orcarouter/auto"), false);
  // 大文字small違いで経路が変わると、設定タブに打った文字列で挙動が割れる
  assert.equal(usesMessagesApi("Anthropic/claude-haiku-4.5"), true);
});

test("system は本文から分離される (Anthropicは別フィールド)", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "あなたはアシスタント" },
    { role: "user", content: "こんにちは" },
  ] as any);
  assert.equal(system, "あなたはアシスタント");
  assert.deepEqual(messages, [{ role: "user", content: "こんにちは" }]);
});

test("ツールの往復が双方向に変換される", () => {
  // chat.ts が積むのと同じ形: assistant(tool_calls) → role:"tool" の結果
  const { messages } = toAnthropicMessages([
    { role: "user", content: "#12を確認して" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_task", arguments: '{"id":12}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"title":"テスト"}' },
  ] as any);

  assert.equal(messages[1].role, "assistant");
  assert.deepEqual(messages[1].content, [{ type: "tool_use", id: "call_1", name: "get_task", input: { id: 12 } }]);
  // Anthropicには tool ロールが無い。結果は user のブロックとして返す
  assert.equal(messages[2].role, "user");
  assert.deepEqual(messages[2].content, [{ type: "tool_result", tool_use_id: "call_1", content: '{"title":"テスト"}' }]);
});

test("同じ assistant が出した複数のツール結果は1つの user にまとめる", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "2件見て" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "f", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "a", content: "1件目" },
    { role: "tool", tool_call_id: "b", content: "2件目" },
  ] as any);
  assert.equal(messages.length, 3, "結果をばらばらのuserにすると会話が壊れる");
  assert.equal(messages[2].content.length, 2);
});

test("壊れた引数でも落とさない (ツール実行側が弾く)", () => {
  const { messages } = toAnthropicMessages([
    { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{壊れ" } }] },
  ] as any);
  assert.deepEqual(messages[0].content[0].input, {});
});

test("tools は input_schema 形式へ", () => {
  const out = toAnthropicTools([
    { type: "function", function: { name: "f", description: "説明", parameters: { type: "object", properties: {} } } },
  ] as any);
  assert.deepEqual(out, [{ name: "f", description: "説明", input_schema: { type: "object", properties: {} } }]);
});

test("レスポンスは OpenAI の形に戻る (chat.ts を無改造で通すため)", () => {
  const res = toOpenAiShape(
    {
      model: "claude-haiku-4-5",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "調べます" },
        { type: "tool_use", id: "call_9", name: "get_task", input: { id: 3 } },
      ],
      usage: { input_tokens: 332, output_tokens: 64, cache_read_input_tokens: 25083, cache_creation_input_tokens: 0 },
    },
    "anthropic/claude-haiku-4.5"
  );
  const msg = res.choices[0].message;
  assert.equal(msg.content, "調べます");
  assert.equal(msg.tool_calls![0].function.name, "get_task");
  assert.equal(msg.tool_calls![0].function.arguments, '{"id":3}', "引数はJSON文字列で渡す");
  assert.equal(res.choices[0].finish_reason, "tool_calls");
  // prompt_tokens は「キャッシュ分も含む総入力」。新規分だけだと入力が極端に少なく見える
  assert.equal(res.usage.prompt_tokens, 332 + 25083);
  assert.equal(res.usage.prompt_tokens_details!.cached_tokens, 25083, "コスト記録が生きる");
});

test("キャッシュ作成の回も総入力に含める", () => {
  const res = toOpenAiShape(
    { content: [], usage: { input_tokens: 332, output_tokens: 10, cache_creation_input_tokens: 25083 } },
    "anthropic/claude-haiku-4.5"
  );
  assert.equal(res.usage.prompt_tokens, 332 + 25083);
  assert.equal(res.usage.prompt_tokens_details!.cached_tokens, 0, "作成はまだ読みではない");
});
