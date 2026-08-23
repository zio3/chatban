import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #244: **経緯メモは、文字列でないものを渡されても消えない。**
 *
 * `update_cards` の `context` は「読む → マージ → 全文で書き戻す」契約 (#112) で、
 * 版が合わなければ弾く。**が、`null` は素通りしていた。**
 * `undefined` は「触らない」だが、`null` は `!== undefined` なので**「全文置換あり」と読まれる** —
 * 版さえ合っていれば経緯メモが丸ごと消える。
 *
 * Codexレビュー(5周目)が実際に再現した:
 * `context:"KEEP"` / 版2 のカードに `{context: null, context_version: 2}` を渡すと
 * `ok: true` が返り、保存後は `context: null` / 版3。
 *
 * **ツール定義で string と宣言してあっても、届く値は保証されない** —
 * チャットのツール引数はLLMが組み立てるJSONで、実行時検証していない。
 * 同じ形を `update_project_context` でも2回踏んだ (版の省略・本文の省略)。
 *
 * ガードは共有入口 (`agentWrite.ts`) に置く。チャットとMCPで同じ関門を通すため (#114)。 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-ctxguard-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0";

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { createCard, getCard } = await import("./db.js");
const { updateCardsAsAgent } = await import("./agentWrite.js");

/** 経緯メモを持つカードを1枚用意する */
function cardWithContext(text: string): number {
  const id = createCard("経緯メモを持つカード").id;
  const r = updateCardsAsAgent([{ id, context: text, context_version: getCard(id)!.contextVersion }]);
  assert.equal(r.ok, true, "前提の用意に失敗した");
  return id;
}

// **本題。**Codexが再現した手順をそのまま固定する
for (const bad of [null, 0, false, [], {}]) {
  test(`context に ${JSON.stringify(bad)} を渡しても経緯メモは消えない`, () => {
    const id = cardWithContext("KEEP");
    const before = getCard(id)!;

    const r = updateCardsAsAgent([{ id, context: bad as any, context_version: before.contextVersion }]);

    const after = getCard(id)!;
    assert.equal(after.context, "KEEP", "経緯メモが消された");
    assert.equal(after.contextVersion, before.contextVersion, "版が進んでいる = 書き込みが起きた");
    assert.equal(r.updated.filter(Boolean).length, 0, "適用されたことになっている");
    assert.equal(r.conflicts?.length, 1, "断った理由を返していない");
    assert.match(r.conflicts![0].note, /文字列/, "なぜ断ったかが読み取れない");
  });
}

// **空文字は正当な全消去。**「うっかり消える」を止めたいのであって「消せない」ようにしたいのではない
test("空文字を明示したときは、正しい版なら経緯メモを消せる", () => {
  const id = cardWithContext("消してよい");
  const r = updateCardsAsAgent([{ id, context: "", context_version: getCard(id)!.contextVersion }]);
  assert.equal(r.ok, true);
  assert.equal(getCard(id)!.context, "");
});

// 普通に書ける道を塞いでいないこと
test("文字列なら、これまでどおり全文置換できる", () => {
  const id = cardWithContext("最初");
  const r = updateCardsAsAgent([{ id, context: "書き換えた", context_version: getCard(id)!.contextVersion }]);
  assert.equal(r.ok, true);
  assert.equal(getCard(id)!.context, "書き換えた");
});

// 行ごと未適用にする (#120: 成功と失敗は排他)。他の項目だけ通ると「書けた」と読まれる
test("断った行は、他の項目も適用しない", () => {
  const id = cardWithContext("KEEP");
  const before = getCard(id)!;
  updateCardsAsAgent([{ id, title: "新しいタイトル", context: null as any, context_version: before.contextVersion }]);
  assert.equal(getCard(id)!.title, before.title, "context を断ったのに title が適用されている");
});
