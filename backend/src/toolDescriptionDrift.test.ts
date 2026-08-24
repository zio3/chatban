import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** #250: **同じ項目の説明文が、入口ごとに違わないこと。**
 *
 * `toolContractDrift.test.ts` は**キーの顔ぶれと必須の指定**を見ている。
 * こちらは**説明文そのもの**を見る。
 *
 * ## 実際にズレていた
 *
 * 書いた時点で 26 項目中 3 件が食い違っていた。いちばん効いていたのがこれ:
 *
 * - チャット … 「登録に至った経緯・会話で出た論点・決まったこと。**相談や議論の流れから
 *   登録するときは必ず書く** (タイトルだけでは背景が失われる)」
 * - MCP … 「登録に至った経緯・論点・決定事項 (経緯メモの初期値)」
 *
 * **MCP から作るときだけ、書く理由が伝わっていなかった。**
 * ドッグフーディングの登録はほぼ MCP 経由なので、**効いてほしい側に届いていなかった**。
 *
 * ## なぜ説明文が「仕様」なのか
 *
 * CLAUDE.md いわく「**ツール契約のdescriptionはエージェントにとってのUIラベル**」。
 * かつて `reason` 欄が「説明が無い文字列欄」に見えて進捗で汚された事故があり、
 * **入口ごとに契約がズレると入口ごとに違う汚れ方をする**。 */

process.env.CHATBAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-desc-"));
process.env.CHATBAN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-desclog-"));
process.env.AUTO_ARCHIVE = "0";

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { buildMcpServer } = await import("./mcp.js");
const { buildTools } = await import("./chat.js");

const server = buildMcpServer(() => {});
const [c, s] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "desc-drift", version: "0" });
await Promise.all([server.connect(s), client.connect(c)]);

const mcpTools = new Map((await client.listTools()).tools.map((t: any) => [t.name, t.inputSchema]));
const chatTools = new Map(buildTools([]).map((t: any) => [t.function.name, t.function.parameters]));

/** JSON Schema から「項目名 → 説明文」を取り出す (配列要素の中も1段だけ見る) */
function fields(schema: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries<any>(schema?.properties ?? {})) {
    out.set(k, v.description ?? "");
    if (v.type === "array" && v.items?.properties)
      for (const [k2, v2] of Object.entries<any>(v.items.properties)) out.set(`${k}[].${k2}`, v2.description ?? "");
  }
  return out;
}

/** **入口ごとに違って当然の項目。**使える道具が違うので、同じ文言にすると片方が嘘になる。
 *
 * `update_project_context.version` … **内蔵チャットには `get_project_context` が無い** (MCP専用)。
 * 揃えようとして「`get_project_context` で読め」と書いたら、**存在しない道具を案内していた**
 * (Codexレビュー P2)。ここは文言ではなく**意味**(直前に読んだ版を添える)だけを共有する。
 *
 * **増やすときは理由を書くこと。**空にできる日が来たら、この仕組みごと消してよい */
const ENTRANCE_SPECIFIC: Record<string, { why: string; chat: RegExp; mcp: RegExp; chatNot?: RegExp }> = {
  "update_project_context.version": {
    why: "読む道具が違う (チャット=query_log / MCP=get_project_context)",
    chat: /query_log/,
    // **これが本体。**最初は「揃える」ことを優先して、チャットにも
    // `get_project_context` で読めと書いてしまった (存在しないのに)
    chatNot: /get_project_context/,
    mcp: /get_project_context/,
  },
};

for (const [name, chatSchema] of chatTools) {
  const mcpSchema = mcpTools.get(name);

  test(`${name}: 同じ項目の説明文が、チャットとMCPで一致する`, () => {
    // **片側欠けを成功にしない。**「顔ぶれは別の番人が見る」と書いていたが、
    // その番人 (toolContractDrift) が見ているのはチャットと検査用Zodだけで、
    // **MCPスキーマを読んでいない** — 誰も見ていない隙間だった (Codexレビュー P3)
    assert.ok(mcpSchema, `${name} が MCP 側に無い (共有しているツールが片方から消えている)`);

    const chat = fields(chatSchema);
    const mcp = fields(mcpSchema);
    const diff: string[] = [];

    for (const [key, chatText] of chat) {
      const mcpText = mcp.get(key);
      assert.ok(mcpText !== undefined, `${name}.${key} が MCP 側に無い (共有している項目が片方から消えている)`);
      const exception = ENTRANCE_SPECIFIC[`${name}.${key}`];
      if (exception) {
        // **「違ってよい」で終わらせない。**長さだけ見ていたら、
        // 元の誤案内 (存在しない道具を名指しする) に戻しても通ってしまった (Codexレビュー P3)。
        // **その入口に実在する道具を案内していること**まで固定する
        assert.match(chatText, exception.chat, `${name}.${key}: チャット側の案内が違う (${exception.why})`);
        assert.match(mcpText, exception.mcp, `${name}.${key}: MCP側の案内が違う (${exception.why})`);
        if (exception.chatNot)
          assert.doesNotMatch(
            chatText,
            exception.chatNot,
            `${name}.${key}: **チャットに無い道具を案内している** (${exception.why})`
          );
        continue;
      }
      if (chatText !== mcpText) diff.push(`  ${key}\n    chat: ${chatText}\n    mcp : ${mcpText}`);
    }

    assert.deepEqual(
      diff,
      [],
      `同じ項目を入口ごとに違う言葉で説明している。**説明文はエージェントにとってのUIラベル**なので、` +
        `片方だけ手厚いと、もう片方の入口から来たときだけ意図が伝わらない:\n${diff.join("\n")}`
    );
  });
}

// **番人が本物を見ていること。**片方が空だと全部素通りする (#180 の教訓)
test("番人が実際に説明文を読めている", () => {
  assert.ok(chatTools.size >= 8, `チャットのツールが読めていない (${chatTools.size}件)`);
  assert.ok(mcpTools.size >= 8, `MCPのツールが読めていない (${mcpTools.size}件)`);

  const create = fields(chatTools.get("create_cards"));
  assert.ok(create.has("cards[].context"), "配列要素の中まで見えていない");
  assert.ok((create.get("cards[].context") ?? "").length > 20, "説明文が取れていない");
});

// #250: 宣言そのもの。**「Markdown で書いてよい」だけを言うと、節を増やす方へ効いてしまう**
test("経緯メモの契約が、Markdown と「節を増やさない」を対で言っている", () => {
  const update = fields(chatTools.get("update_cards"));
  const create = fields(chatTools.get("create_cards")).get("cards[].context") ?? "";
  const write = update.get("updates[].context") ?? "";
  // **一番使わせている口。**「1件足すならこちらを使う」と誘導しているのに、
  // 最初はここだけ Markdown の案内が無かった (Codexレビュー P2)
  const append = update.get("updates[].context_append") ?? "";

  for (const [label, text] of [["作成", create], ["上書き", write], ["追記", append]] as const) {
    assert.match(text, /Markdown/, `${label}の契約が Markdown と言っていない`);
    assert.match(text, /バックティック/, `${label}の契約が、文字として見せる書き方を案内していない`);
  }

  // **節の話は全文を書く口だけ。**追記で繰り返しても、説明が長くなるだけで効かない
  for (const [label, text] of [["作成", create], ["上書き", write]] as const) {
    assert.match(text, /節は増やさず/, `${label}の契約が「節を増やさない」と対で言っていない`);
  }
});

// #250: **この不具合はクラスなので、項目単位でなく面で見る。**
// `update_project_context.version` を直した直後、**同じ入口の `query_log` の説明にも**
// `get_project_context` が残っていた (Codexレビュー P2、2周連続で同じ形)。
// 「例外を1件ずつ潰す」をやめて、**チャットに公開する説明全体**を見る
test("チャットに見せる説明に、チャットに無い道具の名前が出てこない", () => {
  const chatNames = new Set(chatTools.keys());
  const mcpOnly = [...mcpTools.keys()].filter((n) => !chatNames.has(n));
  assert.ok(mcpOnly.length > 0, "MCP専用の道具が1つも無い (番人が何も見ていない)");

  const offenders: string[] = [];
  for (const [name, schema] of chatTools) {
    const texts = [...fields(schema).entries()];
    // ツール自身の説明も見る (引数の説明だけでは面が埋まらない)
    const self = (buildTools([]) as any[]).find((t) => t.function.name === name)?.function?.description ?? "";
    texts.push(["(ツールの説明)", self]);

    for (const [key, text] of texts)
      for (const tool of mcpOnly)
        if (text.includes(tool)) offenders.push(`${name}.${key} が ${tool} を案内している`);
  }

  assert.deepEqual(
    offenders,
    [],
    `**内蔵チャットに存在しない道具を案内している。**説明文はエージェントにとってのUIラベルなので、` +
      `無い道具を名指しすると、呼ぼうとして失敗するか、別の読み方を推測する往復になる:\n${offenders.join("\n")}`
  );
});
