import assert from "node:assert/strict";
import test from "node:test";
import { silentTrap } from "./db.js";

// #216: **判定側だけ古い名前に取り残された。**#215 の改名で、この助言の文面は
// 「cards を直に引いています」に直ったのに、それを出すかどうかを決める正規表現は
// `/\bfrom\s+tasks\b/` のままだった。文面とコードの両方を人間が揃える前提になっていて、
// 実際に片方だけ直った (`live_tasks` ビューはもう存在しないので、この助言は誰にも出なくなっていた)。
//
// **型チェックもテストも守ってくれない種類の壊れ方**なので、ここで固定する。
// 判定は DB も express も要らない純粋関数なので、ユニットで書ける。

test("cards を直に引いたら、live_cards を使うよう一言添える", () => {
  const note = silentTrap("select id, title from cards limit 3").note;
  assert.ok(note, "助言が出ていない (判定側が古い名前を見ている可能性)");
  assert.match(note, /live_cards/);
});

test("生きているものに絞ってあるなら、余計なことを言わない", () => {
  // 条件を書いている人には「条件を書け」と言わない。言うと助言が雑音になる
  assert.equal(silentTrap("select id from cards where trashed_at is null").note, undefined);
  assert.equal(silentTrap("select id from cards where archived = 0").note, undefined);
});

test("ビューを使っているなら何も言わない", () => {
  assert.equal(silentTrap("select id, title from live_cards").note, undefined);
  assert.equal(silentTrap("select done_day from done_cards").note, undefined);
});

test("created_at で完了を数えていたら、done_at を案内する", () => {
  const note = silentTrap("select date(created_at) d, count(*) n from cards group by 1").note;
  assert.ok(note, "助言が出ていない");
  assert.match(note, /done_at/);
});

test("古い名前 (tasks) には反応しない — もう存在しないテーブルなので", () => {
  // 実際に叩けばSQLがエラーになる。ここで助言を出すと「引けるが条件が足りない」に見え、
  // **存在しないテーブルを使い続けてよいと誤解させる**
  assert.equal(silentTrap("select id from tasks").note, undefined);
});
