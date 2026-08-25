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
