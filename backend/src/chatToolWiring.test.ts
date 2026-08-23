import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #245: **入口から叩いて、検証済みの値しか奥へ流れないことを確かめる。**
 *
 * チャットのツール定義 (`buildTools`) は**LLMへの説明**であって検査ではない。
 * `JSON.parse` した値をそのまま渡していたので、モデルの出力が揺れるだけで実データが消えた。
 * **MCPは踏んでいない** — SDK が Zod で検査してからハンドラを呼ぶため。
 * つまり穴は「入口が1つ無検査だった」という1点だった。
 *
 * 項目ごと・ツールごとに塞ぐと **(入口 × ツール × 項目)** の面を1マスずつ埋める作業になるので、
 * `toolArgs.ts` に契約を1つ置き、`execTool` の手前で必ず通す形にした。
 *
 * **だからテストも入口から叩く。**共有入口 (`agentWrite`) を直接呼ぶテストでは、
 * 入口の配線が外れたことに気づけない (実際、配線を消しても全テストが通る時期があった)。 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-wiring-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0";

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { createCard, getCard, getProjectContextRow, listCards, setProjectContext, trashCard } = await import("./db.js");
const { execTool, buildTools } = await import("./chat.js");
const { toolArgSchemas } = await import("./toolArgs.js");

const run = (name: string, args: unknown) => execTool(name, args, new Set<string>()) as Promise<any>;

/** 経緯メモを持つカードを1枚 */
async function cardWith(context: string): Promise<number> {
  const id = createCard("経緯メモを持つカード").id;
  const r = await run("update_cards", { updates: [{ id, context, context_version: getCard(id)!.contextVersion }] });
  assert.equal(r.ok, true, `前提の用意に失敗した: ${r.note}`);
  return id;
}

// ---- 消えないこと。**どれも実測で再現した壊れ方** (Codexレビュー) ----

test("context に null を渡しても経緯メモは消えない", async () => {
  const id = await cardWith("KEEP");
  const before = getCard(id)!;
  const r = await run("update_cards", { updates: [{ id, context: null, context_version: before.contextVersion }] });

  assert.equal(r.ok, false, "型違いが通っている");
  assert.equal(getCard(id)!.context, "KEEP", "経緯メモが消された");
  assert.equal(getCard(id)!.contextVersion, before.contextVersion, "版が進んでいる = 書き込みが起きた");
  assert.match(r.note, /context/, "どこが違うかを返していない");
});

test("summary に null を渡しても要約は消えない", async () => {
  const id = await cardWith("経緯");
  await run("update_cards", { updates: [{ id, summary: "KEEP SUMMARY" }] });

  const r = await run("update_cards", { updates: [{ id, summary: null }] });

  assert.equal(r.ok, false);
  assert.equal(getCard(id)!.summary, "KEEP SUMMARY", "要約が消された");
});

test("blocked_by に false を渡しても依存は解除されない", async () => {
  const other = createCard("依存先").id;
  const id = await cardWith("経緯");
  await run("update_cards", { updates: [{ id, blocked_by: [other] }] });

  const r = await run("update_cards", { updates: [{ id, blocked_by: false }] });

  assert.equal(r.ok, false);
  assert.deepEqual(getCard(id)!.blockedBy, [other], "依存が黙って解除された");
});

// **反転が一番たちが悪い。**消えるのではなく、決めていないことが「却下」になる
test("rejected に文字列の false を渡しても却下にならない", async () => {
  const id = await cardWith("経緯");
  const r = await run("update_cards", { updates: [{ id, rejected: "false" }] });

  assert.equal(r.ok, false);
  assert.equal(getCard(id)!.rejected, false, "!! で true に反転している");
});

test("title に null を渡しても例外にならず、同じ呼び出しの他の行も巻き添えにしない", async () => {
  const first = await cardWith("1行目");
  const before = getCard(first)!.title;

  const r = await run("update_cards", { updates: [{ id: first, title: "変える" }, { id: 999, title: null }] });

  assert.equal(r.ok, false);
  assert.equal(getCard(first)!.title, before, "断ったのに一部が適用された");
});

test("id が整数でなければ、カードを引く前に断る (例外を飛ばさない)", async () => {
  const r = await run("update_cards", { updates: [{ id: {}, title: "x" }] });
  assert.equal(r.ok, false);
  assert.match(r.note, /id/);
});

test("updates の要素が null でも例外にせず、理由を返す", async () => {
  const r = await run("update_cards", { updates: [null] });
  assert.equal(r.ok, false);
  assert.match(r.note, /updates/);
});

test("updates が配列でなければ1件も触らない", async () => {
  for (const bad of [undefined, null, { id: 1 }, "1"]) {
    const r = await run("update_cards", { updates: bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} が通っている`);
  }
});

test("未知の列を指定したら、黙って捨てずに断る", async () => {
  const id = await cardWith("経緯");
  const before = getCard(id)!.status;
  const r = await run("update_cards", { updates: [{ id, status: "pending" }] });

  assert.equal(r.ok, false, "無視したのに成功と返している");
  assert.equal(getCard(id)!.status, before);
});

// ---- 別のカードを触らないこと。**型違いが「失敗」でなく「実操作」になる経路** ----

test("delete_cards に文字列を渡しても、1文字ずつのIDとして消さない", async () => {
  const id = createCard("消えては困るカード").id;
  const r = await run("delete_cards", { ids: "12" });

  assert.equal(r.ok, false, "文字列を配列として扱っている");
  assert.ok(!getCard(id)!.trashedAt, "巻き添えで消えている");
});

test("restore_cards に整数でないものが混ざっていたら、戻せるものも戻さない", async () => {
  const id = createCard("ゴミ箱にあるカード").id;
  trashCard(id);

  const r = await run("restore_cards", { ids: [id, "2"] });

  assert.equal(r.ok, false);
  assert.ok(getCard(id)!.trashedAt, "混ざっていたのに戻している");
});

test("reorder_cards: 並べ替えられない列を指定したら何も動かさない", async () => {
  const a = createCard("並び順A").id;
  const b = createCard("並び順B").id;
  const before = listCards().map((t) => t.id);

  const r = await run("reorder_cards", { ids: [b, a], status: "pending" });

  assert.equal(r.ok, false, "未知の列なのに成功と返している");
  assert.deepEqual(
    listCards().map((t) => t.id),
    before,
    "並びが動いている"
  );
});

// ---- 例外でチャットのターンごと落ちないこと ----

test("search_cards の terms が文字列配列でなくても、例外にせず理由を返す", async () => {
  for (const bad of ["カード名", [1], null]) {
    const r = await run("search_cards", { terms: bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} が通っている`);
  }
});

// ---- 前提情報 (全員の前提なので、消えると運用ルールごと消える) ----

test("update_project_context: 版を省略したら書けない", async () => {
  const cur = getProjectContextRow();
  const r = await run("update_project_context", { text: "版を添えずに全部書き換える" });

  assert.equal(r.ok, false);
  assert.equal(getProjectContextRow().text, cur.text, "前提情報が黙って上書きされた");
});

test("update_project_context: 本文を省略したら書けない (全消去に化けない)", async () => {
  setProjectContext("KEEP CONTEXT", getProjectContextRow().version);
  const cur = getProjectContextRow();

  const r = await run("update_project_context", { version: cur.version });

  assert.equal(r.ok, false);
  assert.equal(getProjectContextRow().text, "KEEP CONTEXT", "前提情報が空にされた");
});

test("update_project_context: 空文字を明示したときは、正しい版なら消せる", async () => {
  const r = await run("update_project_context", { text: "", version: getProjectContextRow().version });
  assert.equal(r.ok, true, r.note);
  assert.equal(getProjectContextRow().text, "");
});

// ---- 正常系を塞いでいないこと ----

test("契約どおりに渡せば、これまでどおり全部通る", async () => {
  const other = createCard("依存先2").id;
  const id = await cardWith("経緯");

  const r = await run("update_cards", {
    updates: [
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
    ],
  });

  assert.equal(r.ok, true, r.note);
  const after = getCard(id)!;
  assert.equal(after.title, "新しいタイトル");
  assert.equal(after.status, "inprogress");
  assert.deepEqual(after.blockedBy, [other]);
  assert.match(after.context!, /追記した/);
});

// **消したいときは空文字。**null で消す道は塞いだので、契約を1つに保つ
test("summary は空文字なら消せる", async () => {
  const id = await cardWith("経緯");
  await run("update_cards", { updates: [{ id, summary: "消す対象" }] });
  const r = await run("update_cards", { updates: [{ id, summary: "" }] });

  assert.equal(r.ok, true, r.note);
  assert.equal(getCard(id)!.summary, "");
});

test("create_cards: 契約に無いキーを混ぜたら、黙って捨てずに断る", async () => {
  const before = listCards().length;
  const r = await run("create_cards", { cards: [{ title: "決定事項つき", context_append: "LOST DECISION" }] });

  assert.equal(r.ok, false, "捨てたのに成功と返している");
  assert.equal(listCards().length, before, "断ったのに作られている");
});

test("create_cards: 契約どおりなら作れる", async () => {
  const r = await run("create_cards", { cards: [{ title: "普通に作る", context: "経緯" }] });
  assert.equal(r.ok, true, r.note);
  assert.equal(r.created.length, 1);
});

// ---- **入口が増えたら気づく。**#114 で「MCPが増えて素通り」を踏んでいる ----

test("チャットが宣言している全ツールに、引数の契約がある", () => {
  const declared = new Set(buildTools([]).map((t: any) => t.function.name));
  const guarded = new Set(Object.keys(toolArgSchemas([])));

  const missing = [...declared].filter((n) => !guarded.has(n));
  assert.deepEqual(missing, [], `契約の無いツールがある (toolArgs.ts に足すこと): ${missing.join(", ")}`);

  const stale = [...guarded].filter((n) => !declared.has(n));
  assert.deepEqual(stale, [], `使われていない契約が残っている: ${stale.join(", ")}`);
});
