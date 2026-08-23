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

const { createCard, getCard, trashCard } = await import("./db.js");
const { createCardsAsAgent, restoreCardsAsAgent, updateCardsAsAgent } = await import("./agentWrite.js");

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
    assert.equal(r.invalid?.length, 1, "断った理由を返していない");
    assert.match(r.invalid![0].reason, /文字列/, "なぜ断ったかが読み取れない");
    // **版の競合と混ぜない。**混ざると「版を直せば通る」と読まれて、同じ不正値で再実行される
    assert.equal(r.conflicts, undefined, "型の誤りを版の競合として返している");
    assert.doesNotMatch(r.note ?? "", /版が合わない/, "トップレベルの note が版の競合の話になっている");
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

// **#245: 経緯メモだけ守っても足りなかった。**同じ未検証の引数経路から他のフィールドも壊せる。
// 以下はすべて Codex が一時DB上で**実測して再現**したもの (6周目のレビュー)。
// 型を見るのは共有入口 (`updateCardsAsAgent`) の行頭で、**不正なら行ごと未適用**にする。

test("summary に null を渡しても要約は消えない", () => {
  const id = cardWithContext("経緯");
  updateCardsAsAgent([{ id, summary: "KEEP SUMMARY", context_version: getCard(id)!.contextVersion }]);
  const before = getCard(id)!;

  const r = updateCardsAsAgent([{ id, summary: null as any }]);

  assert.equal(getCard(id)!.summary, before.summary, "要約が消された");
  assert.equal(r.ok, false);
  assert.match(r.invalid![0].reason, /summary/);
});

test("blocked_by に false を渡しても依存は解除されない", () => {
  const other = createCard("依存先").id;
  const id = cardWithContext("経緯");
  updateCardsAsAgent([{ id, blocked_by: [other] }]);
  assert.deepEqual(getCard(id)!.blockedBy, [other], "前提の用意に失敗した");

  const r = updateCardsAsAgent([{ id, blocked_by: false as any }]);

  assert.deepEqual(getCard(id)!.blockedBy, [other], "依存が黙って解除された");
  assert.equal(r.ok, false);
  assert.match(r.invalid![0].reason, /blocked_by/);
});

// **反転が一番たちが悪い。**消えるのではなく、やらないと決めていないものが「却下」になる
test('rejected に "false" (文字列) を渡しても却下にならない', () => {
  const id = cardWithContext("経緯");
  assert.equal(getCard(id)!.rejected, false, "前提: 却下ではない");

  const r = updateCardsAsAgent([{ id, rejected: "false" as any }]);

  assert.equal(getCard(id)!.rejected, false, "!! で true に反転している");
  assert.equal(r.ok, false);
  assert.match(r.invalid![0].reason, /rejected/);
});

// **例外が飛ぶと、1行目が保存済みのまま応答が失われる** (updateCards は順次更新でトランザクションではない)
test("title に null を渡しても例外にならず、同じ呼び出しの他の行も巻き添えにしない", () => {
  const first = cardWithContext("1行目");
  const second = cardWithContext("2行目");

  const r = updateCardsAsAgent([
    { id: first, title: "1行目は通る" },
    { id: second, title: null as any },
  ]);

  assert.equal(getCard(first)!.title, "1行目は通る", "通る行が適用されていない");
  assert.equal(r.status, "partial", "一部だけ適用されたことが伝わっていない");
  assert.equal(r.invalid![0].id, second);
});

// **無視されるのに成功と返るのが問題。**再試行されないので、追記したつもりで記録が残らない
test("context_append / status に null を渡すと、成功と返さず理由を返す", () => {
  const id = cardWithContext("経緯");
  const before = getCard(id)!;

  for (const patch of [{ context_append: null as any }, { status: null as any }]) {
    const r = updateCardsAsAgent([{ id, ...patch }]);
    assert.equal(r.ok, false, `${JSON.stringify(patch)} が成功として返っている`);
    assert.equal(r.updated.filter(Boolean).length, 0, "適用されたことになっている");
    assert.equal(getCard(id)!.context, before.context);
  }
});

// 正常系を塞いでいないこと (型が合っていれば、これまでどおり通る)
test("型が契約どおりなら、これまでどおり全部通る", () => {
  const other = createCard("依存先2").id;
  const id = cardWithContext("経緯");
  const r = updateCardsAsAgent([
    {
      id,
      title: "新しいタイトル",
      summary: "現況",
      status: "inprogress",
      due: "2026-09-01",
      blocked_by: [other],
      rejected: false,
      context_append: "追記した",
    },
  ]);
  assert.equal(r.ok, true, r.note ?? "");
  const after = getCard(id)!;
  assert.equal(after.title, "新しいタイトル");
  assert.equal(after.summary, "現況");
  assert.equal(after.status, "inprogress");
  assert.equal(after.due, "2026-09-01");
  assert.deepEqual(after.blockedBy, [other]);
  assert.match(after.context!, /追記した/);
});

// null で消すのではなく、空文字で消す (契約を1つに保つ)
test("summary は空文字なら消せる", () => {
  const id = cardWithContext("経緯");
  updateCardsAsAgent([{ id, summary: "消す対象" }]);
  const r = updateCardsAsAgent([{ id, summary: "" }]);
  assert.equal(r.ok, true);
  assert.equal(getCard(id)!.summary, "");
});

// **#245 (2周目): 更新の非IDフィールドだけでは足りなかった。**
// id・配列そのもの・作成・復元にも同じ穴が残っていた (Codexが実測で再現)。

test("id が整数でなければ、カードを引く前に断る (例外を飛ばさない)", () => {
  // `getCard()` を先に呼ぶと `Too few parameter values were provided` が未処理で飛ぶ
  const r = updateCardsAsAgent([{ id: {} as any, title: "x" }]);
  assert.equal(r.ok, false);
  assert.match(r.invalid![0].reason, /id/);
});

test("updates が配列でなければ、1件も触らずに断る", () => {
  for (const bad of [undefined, null, { id: 1 }, "1"]) {
    const r = updateCardsAsAgent(bad as any);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} が通っている`);
    assert.equal(r.status, "failed");
    assert.match(r.note ?? "", /配列/);
  }
});

// **「何もしていないのに成功」を作らない。**チャット側の `?? []` を外した分をここで固定する
test("updates の欠落を空配列に補って成功と返さない", () => {
  const r = updateCardsAsAgent(undefined as any);
  assert.equal(r.ok, false, "何もしていないのに成功になっている");
});

// **未知の列は、黙って捨てずに理由を返す。**`status:null` と同じ偽成功が文字列値で残っていた
test('status に "pending" (未知の列) を渡すと、成功と返さず理由を返す', () => {
  const id = cardWithContext("経緯");
  const before = getCard(id)!;
  const r = updateCardsAsAgent([{ id, status: "pending" }]);
  assert.equal(r.ok, false, "無視したのに成功と返している");
  assert.equal(getCard(id)!.status, before.status);
  assert.match(r.invalid![0].reason, /status/);
});

// done は矯正の対象 (#114)。塞ぎすぎて既存の道を壊していないこと
test('status:"done" はこれまでどおり review に倒れる (塞ぎすぎていない)', () => {
  const id = cardWithContext("経緯");
  const r = updateCardsAsAgent([{ id, status: "done" }]);
  assert.equal(r.ok, true, r.note ?? "");
  assert.equal(getCard(id)!.status, "review");
});

// **件数の1行が嘘をつかないこと。**「配列を数えさせない」ための行なので、ここが狂うと再送が漏れる
test("未適用が3種混ざっても、適用件数の1行が実際と合う", () => {
  const okId = cardWithContext("通る行");
  const conflictId = cardWithContext("版が合わない行");

  const r = updateCardsAsAgent([
    { id: okId, summary: "通る" },
    { id: conflictId, context: "書き換える", context_version: 999 },
    { id: 999999, summary: "存在しない" },
    { id: cardWithContext("型が違う行"), summary: null as any },
  ]);

  assert.equal(r.updated.filter(Boolean).length, 1, "適用されたのは1件のはず");
  assert.match(r.note ?? "", /4件のうち1件を適用しました/, `件数が合っていない: ${r.note}`);
});

test("作成は、1件も書く前に全行を検査する (途中で例外にして無応答にしない)", () => {
  const r = createCardsAsAgent([{ title: "CREATED FIRST" }, { title: null as any }]);
  assert.equal(r.created.length, 1, "通る行が作られていない");
  assert.equal(r.invalid![0].at, 1, "何番目が駄目だったかを返していない");
  assert.match(r.note ?? "", /2件のうち1件/);
});

// **これが一番危ない。**型違いが「失敗」ではなく「別カードへの操作」になる
test('復元に文字列 "12" を渡しても、#1 と #2 を戻さない', () => {
  const r = restoreCardsAsAgent("12" as any);
  assert.equal(r.ok, false, "文字列を配列として扱っている");
  assert.equal(r.restored.length, 0, "別のカードを復元した");
  assert.match(r.note ?? "", /配列/);
});

// **「1件も戻さない」を、実際に戻せるカードで確かめる。**
// ゴミ箱が空のまま試すと、ガードが無くても「0件」になって通ってしまう (最初こう書いていた)
test("復元のIDに整数でないものが混ざっていたら、戻せるものも戻さない", () => {
  const id = createCard("ゴミ箱にあるカード").id;
  trashCard(id);

  const r = restoreCardsAsAgent([id, "2"] as any);

  assert.equal(r.ok, false);
  assert.equal(r.restored.length, 0, "混ざっていたのに一部を処理している");
  assert.match(r.note ?? "", /整数/);
  // 戻っていないこと自体をDBで見る (応答だけ見ても、実際に触ったかは分からない)
  assert.equal(restoreCardsAsAgent([id]).restored.length, 1, "まだゴミ箱に在るはず");
});
