import assert from "node:assert/strict";
import test from "node:test";

/** #274: 経緯メモの「経過」は cards.context の末尾に文字列で積んでいたが、card_entries の行にした。
 *
 * ここで守るのは4つ:
 *   1. 追記は行になり、固定文 (context) と版 (context_version) を動かさない
 *   2. 固定文の上書きは経過の行を消さない (上書きの契約から経過が外れた)
 *   3. get_cards の history (none / tail:N / since:ID / all) が、入口から通って読む量を変える
 *   4. 検索は経過の行も見る (context から外したぶん、探せる範囲が黙って狭まらない)
 *
 * 入口 (execTool) から叩く。共有関数を直接呼ぶと配線が外れても気づけない (chatToolWiring と同じ理由) */

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { createCard, getCard, listCards, listEntries, purgeCard, searchCards, trashCard } = await import("./db.js");
const { execTool } = await import("./chat.js");

const run = (name: string, args: unknown) => execTool(name, args, new Set<string>()) as Promise<any>;

async function cardWithHead(head: string): Promise<number> {
  const id = createCard("経過を持つカード").id;
  const r = await run("update_cards", { updates: [{ id, context: head, context_version: 1 }] });
  assert.equal(r.ok, true, r.note);
  return id;
}

test("追記は経過の行になり、固定文と版は動かない", async () => {
  const id = await cardWithHead("## 背景\n\n決めたこと");
  const before = getCard(id)!;

  const r = await run("update_cards", { updates: [{ id, context_append: "1件目" }, { id, context_append: "2件目" }] });
  assert.equal(r.ok, true, r.note);

  const after = getCard(id)!;
  assert.equal(after.context, before.context, "固定文が変わっている");
  assert.equal(after.contextVersion, before.contextVersion, "追記で版が動いている (上書きしようとしている人を無駄に弾く)");
  assert.deepEqual(after.entries!.map((e) => e.text), ["1件目", "2件目"]);
  assert.equal(after.entryCount, 2);
  assert.ok(after.entries![0].id < after.entries![1].id, "id の順が追記の順になっていない");
  assert.match(after.entries![0].at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "日時をサーバーが打っていない");
  assert.equal(after.entries![0].source, "chat", "出所の種別が入っていない");
  assert.ok(after.updatedAt >= before.updatedAt, "カードの更新日時が動いていない");

  // 板の配信 (listCards) には行数と文字数が載る。本文は載らない
  const brief = listCards().find((c) => c.id === id)!;
  assert.equal(brief.entryCount, 2);
  assert.equal(brief.entryChars, "1件目".length + "2件目".length);
  assert.equal(brief.entries, undefined, "板の配信に経過の本文が載っている");
});

test("固定文の上書きは経過の行を消さない。追記と併用したら両方効く", async () => {
  const id = await cardWithHead("最初の固定文");
  await run("update_cards", { updates: [{ id, context_append: "残るべき行" }] });

  const v = getCard(id)!.contextVersion;
  const r = await run("update_cards", {
    updates: [{ id, context: "書き直した固定文", context_version: v, context_append: "併用の追記" }],
  });
  assert.equal(r.ok, true, r.note);

  const after = getCard(id)!;
  assert.equal(after.context, "書き直した固定文");
  assert.equal(after.contextVersion, v + 1, "上書きで版が進んでいない");
  assert.deepEqual(after.entries!.map((e) => e.text), ["残るべき行", "併用の追記"]);
});

test("get_cards の history で読む量を選べる (none / tail / since / all)", async () => {
  const id = await cardWithHead("固定文");
  for (const t of ["a", "b", "c", "d", "e"]) await run("update_cards", { updates: [{ id, context_append: t }] });
  const all = (await run("get_cards", { ids: [id] })).cards[0];
  assert.deepEqual(all.entries.map((e: any) => e.text), ["a", "b", "c", "d", "e"], "省略時が全部になっていない");
  assert.equal(all.entryCount, 5);

  const none = (await run("get_cards", { ids: [id], history: "none" })).cards[0];
  assert.deepEqual(none.entries, [], "none で経過が載っている");
  assert.equal(none.context, "固定文", "none で固定文まで落ちている");
  assert.equal(none.entryCount, 5, "絞っても全行数は分かる形にする");

  const tail = (await run("get_cards", { ids: [id], history: "tail:2" })).cards[0];
  assert.deepEqual(tail.entries.map((e: any) => e.text), ["d", "e"], "tail が末尾になっていない (順も古い→新しい)");

  const since = (await run("get_cards", { ids: [id], history: `since:${all.entries[2].id}` })).cards[0];
  assert.deepEqual(since.entries.map((e: any) => e.text), ["d", "e"], "since がその id より後になっていない");

  // 形が違う history は入口で弾く (黙って全部返さない)
  const bad = await run("get_cards", { ids: [id], history: "last:3" });
  assert.equal(bad.ok, false, "契約に無い history が通っている");
});

test("ゴミ箱から本当に消すと、経過の行も一緒に消える", async () => {
  const id = await cardWithHead("消えるカード");
  await run("update_cards", { updates: [{ id, context_append: "消えるべき行" }] });
  assert.equal(listEntries(id).length, 1);

  trashCard(id);
  assert.equal(listEntries(id).length, 1, "ゴミ箱に入れただけで行が消えている (復元できなくなる)");
  assert.equal(purgeCard(id), true);
  // Codexレビュー P1: cards だけ消すと本文が card_entries に残り、SQL 窓口から読めた
  assert.equal(listEntries(id).length, 0, "本当に消したのに経過の行が残っている");
});

test("検索は経過の行も見る", async () => {
  const id = await cardWithHead("固定文には無い");
  await run("update_cards", { updates: [{ id, context_append: "経過にだけある合言葉ゼブラ" }] });
  const hits = searchCards(["ゼブラ"]).hits;
  assert.ok(hits.some((h: any) => h.id === id), "経過の行が検索の対象から外れている");
});
