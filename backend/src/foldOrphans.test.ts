import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #195: **畳み損なったDoneが、次の検収で一緒に畳まれること**を確かめる。
 *
 * 「確定 → (非同期で) 要約」の間にプロセスが止まると、`status='done'` なのに `archived=0` の
 * タスクが残る。**専用の回収処理は作らず、次にDoneを畳むときに相乗りさせる**という設計なので、
 * ここで見るのは2つだけ:
 *   - 浮いているものを見つけられるか (`listUnfoldedDoneIds` の3条件)
 *   - 畳むときに**書く時点で**条件を確かめているか (`claimTasksForCard`)
 *
 * DBを使うのは、守りたいものがSQLの条件そのものだから。条件を1つ落としても型は通るし、
 * 他のテストも通ってしまう。 */

// **実データに触らせない。**store.ts はモジュール読み込み時に管理DBを開く (`export const admin`) ので、
// db.js を読み込む前にデータディレクトリを一時領域へ向ける (llm.test.ts と同じ作法)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-foldtest-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0"; // フック経由で本物の要約(LLM)が走らないように

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const {
  claimTasksForCard,
  createSummaryCard,
  createTask,
  getSummaryCard,
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

test("浮いているDoneは「done かつ 未アーカイブ かつ ゴミ箱でない」だけ (#195)", () => {
  const orphan = makeDoneTask("畳み損なったDone");
  const review = createTask("検収待ち", "review").id;
  const trashed = makeDoneTask("Doneにしてからゴミ箱へ");
  trashTask(trashed);
  const folded = makeDoneTask("既に畳んであるDone");
  claimTasksForCard([folded], createSummaryCard().id);

  const found = listUnfoldedDoneIds();
  assert.ok(found.includes(orphan), "畳み損なったDoneが見つかっていない");
  assert.ok(!found.includes(review), "done以外を拾っている");
  // ゴミ箱のDoneを拾うと**ゴミ箱と要約カードの両方に入る** (trashTask は status を変えないので、
  // status だけ見ていると素通りする)
  assert.ok(!found.includes(trashed), "ゴミ箱のDoneを拾っている");
  // 畳み済みを拾うと**同じタスクが2枚のカードに入る**
  assert.ok(!found.includes(folded), "畳み済みのDoneを拾っている");
});

test("押さえられたものだけがカードに入る (#195)", () => {
  const a = makeDoneTask("押さえられるA");
  const b = makeDoneTask("押さえられるB");
  const card = createSummaryCard();

  assert.deepEqual(claimTasksForCard([a, b], card.id).sort(), [a, b].sort());
  assert.deepEqual(tasksOfCard(card.id).map((t) => t.id).sort(), [a, b].sort());
});

test("**書く時点で条件を確かめる** — 探した後に状態が変わっても間違ったものを畳まない (#195)", () => {
  // `rollUpOldCards()` の await を挟むので、探してから書くまでに時間がある。
  // 「読んだ時点で done だった」を根拠に書くと、次の3つを取り違える
  const card = createSummaryCard();

  const trashedLate = makeDoneTask("押さえる直前にゴミ箱へ");
  trashTask(trashedLate);

  const reopenedLate = makeDoneTask("押さえる直前に差し戻し");
  updateTasks([{ id: reopenedLate, patch: { status: "todo" } }]);

  const takenAlready = makeDoneTask("先に別のカードが押さえた");
  const first = createSummaryCard();
  claimTasksForCard([takenAlready], first.id);

  assert.deepEqual(claimTasksForCard([trashedLate, reopenedLate, takenAlready], card.id), []);
  assert.deepEqual(tasksOfCard(card.id), [], "取り違えたものがカードに入っている");
  // 先に押さえたカードから奪っていないこと (無条件UPDATEだと奪える)
  assert.deepEqual(tasksOfCard(first.id).map((t) => t.id), [takenAlready], "先発カードから奪っている");
});

test("**途中で失敗したら何も書かない** (畳んだのに索引に無い、を作らない) (#195)", () => {
  // タスク行とカードの索引は別のUPDATEなので、囲まないと片方だけ書かれた状態が残る。
  // その状態は「畳み損なったDone」の探し方 (archived=0) では見つからず、回収できない。
  // 2件目の値を壊して2文目以降を失敗させ、巻き戻ることを見る
  const ok = makeDoneTask("巻き戻し後も畳まれていないDone");
  const card = createSummaryCard();

  assert.throws(
    () => claimTasksForCard([ok, {} as unknown as number], card.id),
    "壊れた入力なのに例外が飛んでいない (前提が崩れている)"
  );

  assert.equal(getTask(ok)?.status, "done");
  assert.ok(listUnfoldedDoneIds().includes(ok), "巻き戻っていない (畳まれたことになっている)");
  assert.deepEqual(getSummaryCard(card.id)?.taskIds ?? [], [], "索引にだけ入っている");
});

test.after(() => {
  // better-sqlite3 がDBを掴んだままだと消せないことがある。消せなくてもテストは失敗させない
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 一時領域なので放置してよい */
  }
});
