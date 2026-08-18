import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #200: **Done列の3段**が意図どおりに動くことを確かめる。
 *
 *   1. バラバラ  status='done', archived=0   直近の検収バッチ
 *   2. 箱        archived=1 + メモリ上の1個  それ以前 (直近24時間ぶん)
 *   3. 消える    archived=1 だけ             24時間経過。板に出ない
 *
 * DBを使うのは、守りたいものがSQLの条件そのものだから。条件を1つ落としても型は通るし、
 * 他のテストも通ってしまう。 */

// **実データに触らせない。**store.ts はモジュール読み込み時に管理DBを開く (`export const admin`) ので、
// db.js を読み込む前にデータディレクトリを一時領域へ向ける (llm.test.ts と同じ作法)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-foldtest-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0"; // フック経由で自動の畳み込みが走らないように

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { archiveTasks, createTask, getTask, isArchived, listLooseDoneIds, setChecked, trashTask, updateTasks } =
  await import("./db.js");
const { foldDoneColumn, foldedContainer, onTaskReopened } = await import("./archive.js");

const P = 1; // 一時DBの既定プロジェクト

/** 本番と同じ道でDoneまで運ぶ (review → 検収チェック → 確定)。
 * status を直に書き換えると mayEnterDone を迂回してしまい、試験したい状態と違うものができる */
function makeDoneTask(title: string): number {
  const t = createTask(title, "review");
  setChecked(t.id, true);
  updateTasks([{ id: t.id, patch: { status: "done" } }]);
  assert.equal(getTask(t.id)?.status, "done", `${title} をDoneにできていない`);
  return t.id;
}

test("1段目は「done かつ 未アーカイブ かつ ゴミ箱でない」だけ", () => {
  const loose = makeDoneTask("検収したばかり");
  const review = createTask("検収待ち", "review").id;
  const trashed = makeDoneTask("Doneにしてからゴミ箱へ");
  trashTask(trashed);
  const folded = makeDoneTask("既に畳んであるDone");
  archiveTasks([folded]);

  const found = listLooseDoneIds();
  assert.ok(found.includes(loose), "検収したばかりのDoneが1段目に居ない");
  assert.ok(!found.includes(review), "done以外を拾っている");
  // ゴミ箱のDoneを畳むと**ゴミ箱と箱の両方に入る** (trashTask は status を変えないので、
  // status だけ見ていると素通りする)
  assert.ok(!found.includes(trashed), "ゴミ箱のDoneを拾っている");
  // 畳み済みを拾うと**同じタスクが2回入る**
  assert.ok(!found.includes(folded), "畳み済みのDoneを拾っている");
});

test("**書く時点で条件を確かめる** — 探した後に状態が変わっても間違ったものを畳まない", () => {
  const trashedLate = makeDoneTask("押さえる直前にゴミ箱へ");
  trashTask(trashedLate);

  const reopenedLate = makeDoneTask("押さえる直前に差し戻し");
  updateTasks([{ id: reopenedLate, patch: { status: "todo" } }]);

  const takenAlready = makeDoneTask("先に畳んである");
  archiveTasks([takenAlready]);

  assert.deepEqual(archiveTasks([trashedLate, reopenedLate, takenAlready]), []);
});

/** 前のテストが残したバラバラと箱を片付ける (このファイルは1つのDBを共有している) */
function flush(): void {
  foldDoneColumn(P, []);
  for (const t of foldedContainer(P) ?? []) t.foldedAt = 0;
  assert.equal(foldedContainer(P), undefined, "箱を空にできていない");
  assert.deepEqual(listLooseDoneIds(), [], "1段目を空にできていない");
}

test("いま確定したぶんは1段目に残り、それ以前が箱へ入る", () => {
  flush();
  const first = makeDoneTask("1回目");
  foldDoneColumn(P, [first]); // 1回目の検収: 畳む対象は無い
  assert.equal(foldedContainer(P), undefined, "1回目で箱ができている");
  assert.ok(listLooseDoneIds().includes(first), "確定したばかりのものが1段目に居ない");

  const second = makeDoneTask("2回目");
  foldDoneColumn(P, [second]); // 2回目: 1回目が畳まれる
  assert.deepEqual(
    foldedContainer(P)?.map((t) => t.title),
    ["1回目"],
    "1回目が箱に入っていない"
  );
  assert.ok(isArchived(first), "畳んだのに archived になっていない");
  assert.deepEqual(listLooseDoneIds(), [second], "2回目が1段目に残っていない");
});

test("箱は1個だけで、畳むたびに中身が足される", () => {
  const third = makeDoneTask("3回目");
  foldDoneColumn(P, [third]);
  assert.deepEqual(foldedContainer(P)?.map((t) => t.title), ["1回目", "2回目"]);
});

test("24時間より古いものは箱から落ちる (板に出ない)", () => {
  const kept = foldedContainer(P)!;
  // 畳んだ時刻を25時間前にする (時計を進める代わり)
  for (const t of kept) t.foldedAt = Date.now() - 25 * 3600_000;
  assert.equal(foldedContainer(P), undefined, "古い箱が残っている");

  // 器が消えるだけ。タスクは archived=1 のまま残り、search_tasks で引ける
  const first = kept[0].id;
  assert.equal(getTask(first)?.status, "done", "タスクまで消えている");
  assert.equal(isArchived(first), true, "板に出戻っている");
  assert.ok(!listLooseDoneIds().includes(first), "1段目に戻ってきている");
});

test("doneから戻すと箱から外れて板へ返る", () => {
  flush();
  const a = makeDoneTask("戻される");
  const b = makeDoneTask("残る");
  foldDoneColumn(P, []); // 両方まとめて畳む
  assert.deepEqual(foldedContainer(P)?.map((t) => t.id).sort(), [a, b].sort());

  onTaskReopened(P, a);
  assert.deepEqual(foldedContainer(P)?.map((t) => t.id), [b], "戻したものが箱に残っている");
  assert.equal(isArchived(a), false, "板へ返っていない");
});

test.after(() => {
  // better-sqlite3 がDBを掴んだままだと消せないことがある。消せなくてもテストは失敗させない
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 一時領域なので放置してよい */
  }
});
