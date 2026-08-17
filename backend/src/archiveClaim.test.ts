import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #195: **畳む対象の見つけ方と押さえ方**を、実物のDBで確かめる。
 *
 * ここだけDBを使うのは、守りたいものがSQLの条件そのものだからです。純粋関数に切り出せる
 * 判断ではなく、「**読んでから書くまでに状態が変わっても、間違ったものを畳まない**」という
 * 書き込みの性質を見たい。条件を1つ落としても型は通るし、他のテストも通ってしまう。
 *
 * 起動時の掃除そのもの (プロセス2回分) はここでは試験できないので、
 * PRに手順と実測を書いてあります。ここで固定するのは、その掃除が使う2つの口:
 *   - `listUnfoldedDoneIds` … 何を「畳み損ない」とみなすか (3条件)
 *   - `claimTasksForCard`  … 押さえられたものだけを返すか (競合と二重取りの歯止め) */

// **実データに触らせない。**store.ts はモジュール読み込み時に管理DBを開く (`export const admin`) ので、
// db.js を読み込む前にデータディレクトリを一時領域へ向ける (llm.test.ts と同じ作法)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-claimtest-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0"; // フック経由で本物の要約(LLM)が走らないように

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject(); // 空のデータディレクトリなのでプロジェクトを1つ作る (本番の初回起動と同じ道)

const {
  claimTasksForCard,
  createSummaryCard,
  createTask,
  getTask,
  listUnfoldedDoneIds,
  setChecked,
  tasksOfCard,
  trashTask,
  updateTasks,
} = await import("./db.js");

/** 本番と同じ道でDoneまで運ぶ (review → 検収チェック → 確定)。
 * status を直に書き換えると mayEnterDone を迂回してしまい、試験したい状態と違うものができる */
function makeDoneTask(title: string): number {
  const t = createTask(title, "review");
  setChecked(t.id, true);
  updateTasks([{ id: t.id, patch: { status: "done" } }]);
  assert.equal(getTask(t.id)?.status, "done", `${title} をDoneにできていない`);
  return t.id;
}

test("畳み損ないは「done かつ 未アーカイブ かつ ゴミ箱でない」だけ (#195)", () => {
  const done = makeDoneTask("畳み損なったDone");
  const review = createTask("検収待ち", "review").id;
  const trashedDone = makeDoneTask("Doneにしてからゴミ箱へ");
  trashTask(trashedDone);

  const found = listUnfoldedDoneIds();
  assert.ok(found.includes(done), "畳み損なったDoneが見つかっていない");
  assert.ok(!found.includes(review), "done以外を拾っている");
  // **ゴミ箱のDoneを拾うと、ゴミ箱と要約カードの両方に入る** (trashTask は status を変えないので、
  // status だけ見ていると素通りする)
  assert.ok(!found.includes(trashedDone), "ゴミ箱のDoneを拾っている");
});

test("押さえられたものだけを返す (#195)", () => {
  const a = makeDoneTask("押さえられるA");
  const b = makeDoneTask("押さえられるB");
  const card = createSummaryCard();

  const claimed = claimTasksForCard([a, b], card.id);
  assert.deepEqual(claimed.sort(), [a, b].sort());
  assert.deepEqual(
    tasksOfCard(card.id).map((t) => t.id).sort(),
    [a, b].sort(),
    "カードの中身が押さえたものと一致しない"
  );
});

test("**同じタスクを二度は押さえられない** — 二重取りの歯止め (#195)", () => {
  const id = makeDoneTask("二重取りされたくないタスク");
  const first = createSummaryCard();
  const second = createSummaryCard();

  assert.deepEqual(claimTasksForCard([id], first.id), [id], "1回目で押さえられていない");
  // 起動時の掃除と通常のフックが同じIDを拾った状況。**後から来たほうは空で返る**
  assert.deepEqual(claimTasksForCard([id], second.id), [], "2回目も押さえられてしまった");
  // 先に押さえたカードから奪われていないこと (以前は無条件UPDATEだったので奪えた)
  assert.deepEqual(tasksOfCard(first.id).map((t) => t.id), [id]);
  assert.deepEqual(tasksOfCard(second.id).map((t) => t.id), [], "奪ったカード側に入っている");
});

test("**探したあとにゴミ箱へ入れられたら押さえない** — 読んでから書くまでの競合 (#195)", () => {
  const id = makeDoneTask("押さえる直前にゴミ箱へ");
  const card = createSummaryCard();

  // 「探す」と「押さえる」の間に人間がゴミ箱へ入れた、という状況を再現する。
  // 要約処理は rollUpOldCards() を await するので、実際にこの隙間がある
  trashTask(id);

  assert.deepEqual(claimTasksForCard([id], card.id), [], "ゴミ箱のタスクを押さえてしまった");
  assert.deepEqual(tasksOfCard(card.id), [], "ゴミ箱のタスクがカードに入っている");
  assert.ok(getTask(id)?.trashedAt, "ゴミ箱から出てしまっている");
});

test("**探したあとにDoneから戻されたら押さえない** (#105の幽霊を作らない) (#195)", () => {
  const id = makeDoneTask("押さえる直前に差し戻し");
  const card = createSummaryCard();

  updateTasks([{ id, patch: { status: "todo" } }]); // 人間がDoneから引き戻した

  assert.deepEqual(claimTasksForCard([id], card.id), [], "done以外を押さえてしまった");
  // 押さえていたら「todoなのに archived=1 でボードから消える」幽霊になる (#105)
  assert.deepEqual(tasksOfCard(card.id), [], "差し戻したタスクがカードに入っている");
});

test.after(() => {
  // better-sqlite3 がDBを掴んだままだと消せないことがある。消せなくてもテストは失敗させない
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 一時領域なので放置してよい */
  }
});
