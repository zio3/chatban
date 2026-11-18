import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #282: **live_cards と done_cards は重ならない。**
 *
 * 以前の live_cards は status を見ておらず (`archived = 0 AND trashed_at IS NULL` だけ)、検収直後の
 * Done が両方のビューに出ていた。それを説明文の1段落で断っていたのを、定義のほうで無くした。
 * 守りたいのはビューの WHERE 句そのものなので、実物のDBに引かせて確かめる (foldDone.test.ts と同じ理由) */

// 実データに触らせない (foldDone.test.ts と同じ作法)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-liveview-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0";

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { archiveCards, createCard, getCard, queryProjectData, setChecked, trashCard, updateCards } =
  await import("./db.js");

function makeDoneCard(title: string): number {
  const t = createCard(title, "review");
  setChecked(t.id, true);
  updateCards([{ id: t.id, patch: { status: "done" } }]);
  assert.equal(getCard(t.id)?.status, "done", `${title} をDoneにできていない`);
  return t.id;
}

function ids(view: string): number[] {
  const r = queryProjectData(`SELECT id FROM ${view}`) as { rows: { id: number }[] };
  return r.rows.map((x) => x.id);
}

test("live_cards に入るのは done 以外。検収直後でまだ畳まれていない Done も入らない", () => {
  const todo = createCard("まだやっていない", "todo").id;
  const review = createCard("検収待ち", "review").id;
  const loose = makeDoneCard("検収したばかり (板の Done 列に見えている)");
  const folded = makeDoneCard("畳んである Done");
  archiveCards([folded]);
  const trashed = createCard("ゴミ箱へ入れたもの", "todo").id;
  trashCard(trashed);

  const live = ids("live_cards");
  assert.ok(live.includes(todo), "todo が出ていない");
  assert.ok(live.includes(review), "review が出ていない");
  assert.ok(!live.includes(loose), "畳まれていない Done が live_cards に出ている");
  assert.ok(!live.includes(folded), "畳んだ Done が出ている");
  assert.ok(!live.includes(trashed), "ゴミ箱のカードが出ている");

  // 板の Done 列に見えているカードは done_cards 側で引ける (説明文の案内どおり)
  const onBoard = queryProjectData("SELECT id FROM done_cards WHERE archived = 0") as { rows: { id: number }[] };
  assert.ok(onBoard.rows.some((x) => x.id === loose), "検収直後の Done が done_cards の archived=0 に居ない");
  assert.ok(!onBoard.rows.some((x) => x.id === folded), "畳んだ Done が archived=0 に出ている");
});

// Codexレビュー指摘: 説明文は「板の Done 列に見えているものは done_cards の archived=0」と案内する。
// done_cards がゴミ箱を除いていないと、捨てた Done がそこに混ざる (板の一覧は trashed_at IS NULL)
test("Done にしてからゴミ箱へ入れたカードは、done_cards にも live_cards にも出ない", () => {
  const trashedDone = makeDoneCard("Done にしてからゴミ箱へ");
  trashCard(trashedDone);
  assert.ok(!ids("done_cards").includes(trashedDone), "ゴミ箱の Done が done_cards に出ている");
  assert.ok(!ids("live_cards").includes(trashedDone), "ゴミ箱の Done が live_cards に出ている");
});

test("同じカードが live_cards と done_cards の両方に出ることはない", () => {
  makeDoneCard("重なりを見るための Done");
  const done = new Set(ids("done_cards"));
  assert.ok(done.size > 0, "done_cards が空 (確かめる相手がいない)");
  assert.deepEqual(ids("live_cards").filter((id) => done.has(id)), []);
});

test("Done から差し戻したカードは live_cards に戻り、done_cards から消える", () => {
  const id = makeDoneCard("差し戻すもの");
  assert.ok(!ids("live_cards").includes(id));
  updateCards([{ id, patch: { status: "review" } }]);
  assert.ok(ids("live_cards").includes(id), "差し戻したのに live_cards に戻っていない");
  assert.ok(!ids("done_cards").includes(id), "差し戻したのに done_cards に残っている");
});
