import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #257: **一番多い用途に道具を用意する。**
 *
 * 実測 (2026-08-25、`chat_messages.trace` から復元したSQL 98本): **23本が
 * 「カード1件の `context` と `context_version` を読むだけ」**だった。集計ではない。
 * `search_cards` は断片しか返さず `sync_board` は `summary` だけなので、
 * **全文を読むにはSQLを書くしかなかった** — 道具の不在を説明で肩代わりしていた。
 *
 * **入口から叩く** (#245/#247 と同じ)。純粋関数が通っていても配線が外れれば意味が無い。 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-getcards-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0";
process.env.CHATBAN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-logs-"));

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();
const { execTool, buildTools } = await import("./chat.js");
const db = await import("./db.js");

const run = (args: unknown) => execTool("get_cards", args, new Set<string>()) as Promise<any>;

test("経緯メモの全文と版が返る (書き換える前に読む相手)", async () => {
  const id = db.createCard("読まれるカード").id;
  const body = "経緯メモの本文。".repeat(40);
  db.updateCards([{ id, patch: { context: body } }]);

  const r = await run({ ids: [id] });
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].context, body, "全文が返っていない (切られている)");
  assert.equal(typeof r.cards[0].contextVersion, "number", "版が返っていない");
  assert.deepEqual(r.missing, []);
});

// **見えないことと存在しないことは違う。**名指しで聞かれたものは在るなら在ると答える
test("ゴミ箱・アーカイブ済みも読める (板に出ないだけ)", async () => {
  const trashed = db.createCard("捨てたカード").id;
  db.trashCard(trashed);
  const done = db.createCard("畳んだカード", "review").id;
  db.setChecked(done, true);
  db.approveChecked([done]);
  db.archiveCards([done]);

  const r = await run({ ids: [trashed, done] });
  assert.equal(r.cards.length, 2, `板に出ないものが読めない: ${JSON.stringify(r.missing)}`);
  assert.equal(db.isArchived(done), true, "前提が崩れている (畳めていない)");
});

// **無いものは無いと言う。**黙って短い配列を返すと「読んだつもり」が残る
test("無い番号は missing で名指しで返る", async () => {
  const id = db.createCard("在るカード").id;
  const r = await run({ ids: [id, 99999] });
  assert.deepEqual(r.cards.map((c: any) => c.id), [id]);
  assert.deepEqual(r.missing, [99999]);
});

// 経緯メモは1件1,000字を超える。まとめて読むと応答がそのまま費用になる
test("多すぎるときは切って、切ったことを言う", async () => {
  const ids = Array.from({ length: 12 }, () => db.createCard("たくさん").id);
  const r = await run({ ids });
  assert.equal(r.cards.length, 10, "上限が効いていない");
  assert.match(r.note ?? "", /10件/, "切ったことを言っていない");
});

// #245: 入口の検証を通ること (型が違うものが奥へ流れない)
test("契約に合わない引数は断る", async () => {
  const r = await run({ ids: "12" });
  assert.equal(r.ok, false, "文字列が素通りしている");
});

test("チャットのツール定義に載っている (配線の抜けが無い)", () => {
  const names = buildTools([]).map((t: any) => t.function.name);
  assert.ok(names.includes("get_cards"), `定義に無い: ${names.join(",")}`);
});

// #257 (Codexレビュー P2): **近い説明が勝つ。**
// ツールの description を `get_cards` に直しても、`context_version` の項目説明が
// 「直前に query_log で読んだ」のままだと、**操作のいちばん近くにある案内**が旧経路を指す。
// 実測23本がSQLで版を読んでいた経路は、まさにここが入口だった
test("版を読む先は get_cards に揃っている (両入口 + 常時読む案内)", async () => {
  const { CONTEXT_VERSION_DESCRIPTION } = await import("./chat.js");
  assert.match(CONTEXT_VERSION_DESCRIPTION, /get_cards/);
  assert.ok(!CONTEXT_VERSION_DESCRIPTION.includes("query_log"), "版の説明が query_log を指している");

  // チャットの定義から実際に引く (定数だけ直して配線を忘れる形を止める)
  const update: any = buildTools([]).find((t: any) => t.function.name === "update_cards");
  const cv = update.function.parameters.properties.updates.items.properties.context_version;
  assert.equal(cv.description, CONTEXT_VERSION_DESCRIPTION, "チャット側が定数を使っていない");
});

// **カードの全文を読む用途だけ**を見る。条件で絞る・集計する案内は query_log のままでよい
// (用途が違うので一括置換しない — Codexレビューの助言)
test("カードの詳細を読む案内が query_log を指していない", async () => {
  const { buildSystemPrompt } = await import("./chat.js");
  const prompt = buildSystemPrompt();
  // **文単位で見る。**同じ行に「全文は get_cards」と「時期や条件で絞るなら query_log」が
  // 並ぶのは正しい状態 — 行ごと弾くと、用途の違いまで潰してしまう
  const sentences = prompt.split(/[。\n]/).filter((x) => /経緯メモの全文|詳細\(経緯メモ\)/.test(x));

  assert.ok(sentences.length > 0, "全文を読む案内が見つからない (文言が変わった?)");
  for (const x of sentences) {
    assert.ok(!x.includes("query_log"), `全文を読む案内が query_log を指している: ${x}`);
    assert.ok(x.includes("get_cards"), `全文を読む案内が get_cards を指していない: ${x}`);
  }
});
