import assert from "node:assert/strict";
import test from "node:test";
import { queryResult, silentTrap } from "./db.js";

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

// #282: live_cards から done を外した。done を拾いにいく SQL はエラーにならず0件になるので、一言添える
test("live_cards から done を拾おうとしたら、done_cards を案内する", () => {
  for (const sql of [
    "select id from live_cards where status='done'",
    "SELECT id FROM live_cards WHERE status = 'done' ORDER BY sort_key",
    "select id from live_cards where status in ('review', 'done')",
  ]) {
    const note = silentTrap(sql).note;
    assert.ok(note, `助言が出ていない: ${sql}`);
    assert.match(note, /done_cards/);
  }
});

test("live_cards で done を除いているだけなら、何も言わない", () => {
  // 除外は害が無い (もう入っていないだけ)。言うと助言が雑音になる
  assert.equal(silentTrap("select id from live_cards where status <> 'done'").note, undefined);
  assert.equal(silentTrap("select id from live_cards where status != 'done'").note, undefined);
  assert.equal(silentTrap("select id from live_cards where status not in ('done')").note, undefined);
  assert.equal(silentTrap("select id from live_cards where status='review'").note, undefined);
  assert.equal(silentTrap("select id from done_cards where archived=0").note, undefined);
});

// #281: 注意書きは行より前に出す。行のあとだと、読んで判断が済んでから届く
test("注意書きは結果の行より前に出る", () => {
  const r = queryResult([{ id: 1 }, { id: 2 }], "select id from cards", 200);
  const json = JSON.stringify(r);
  assert.ok(json.indexOf("note") >= 0, "注意が付いていない");
  assert.ok(json.indexOf("note") < json.indexOf("rows"), "注意が行のあとにある");
  assert.equal(r.rows.length, 2);
  assert.equal(r.truncated, false);
});

test("注意が要らないときは note のキーごと付けない", () => {
  const r = queryResult([{ id: 1 }], "select id from live_cards", 200);
  assert.ok(!("note" in r));
  assert.equal(queryResult([1, 2, 3], "select id from live_cards", 2).truncated, true);
});
