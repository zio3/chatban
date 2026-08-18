import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #200: **Done列の3段**が意図どおりに動くことを確かめる。
 *
 *   1. バラバラ  status='done', archived=0            直近の検収バッチ
 *   2. コンテナ  archived=1, summary_card_id=<card>   それ以前
 *   3. 消える    archived=1, summary_card_id=NULL     24時間経過
 *
 * DBを使うのは、守りたいものがSQLの条件そのものだから。条件を1つ落としても型は通るし、
 * 他のテストも通ってしまう。 */

// **実データに触らせない。**store.ts はモジュール読み込み時に管理DBを開く (`export const admin`) ので、
// db.js を読み込む前にデータディレクトリを一時領域へ向ける (llm.test.ts と同じ作法)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-foldtest-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0"; // フック経由で自動の畳み込みが走らないように

const { db, ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const {
  createTask,
  expireContainers,
  foldIntoContainer,
  getSummaryCard,
  getTask,
  isArchived,
  listLooseDoneIds,
  listSummaryCards,
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

test("1段目は「done かつ 未アーカイブ かつ ゴミ箱でない」だけ", () => {
  const loose = makeDoneTask("検収したばかり");
  const review = createTask("検収待ち", "review").id;
  const trashed = makeDoneTask("Doneにしてからゴミ箱へ");
  trashTask(trashed);
  const folded = makeDoneTask("既に畳んであるDone");
  foldIntoContainer([folded]);

  const found = listLooseDoneIds();
  assert.ok(found.includes(loose), "検収したばかりのDoneが1段目に居ない");
  assert.ok(!found.includes(review), "done以外を拾っている");
  // ゴミ箱のDoneを畳むと**ゴミ箱とコンテナの両方に入る** (trashTask は status を変えないので、
  // status だけ見ていると素通りする)
  assert.ok(!found.includes(trashed), "ゴミ箱のDoneを拾っている");
  // 畳み済みを拾うと**同じタスクが2枚のコンテナに入る**
  assert.ok(!found.includes(folded), "畳み済みのDoneを拾っている");
});

test("押さえられたものだけがコンテナに入り、見出しはコードで自動生成される", () => {
  const a = makeDoneTask("押さえられるA");
  const b = makeDoneTask("押さえられるB");

  const card = foldIntoContainer([a, b]);
  assert.ok(card, "コンテナができていない");
  assert.deepEqual(card!.taskIds.slice().sort(), [a, b].sort());
  assert.deepEqual(tasksOfCard(card!.id).map((t) => t.id).sort(), [a, b].sort());
  assert.match(card!.title, /^\d+\/\d+ \d+:\d+ の検収$/, `見出しが自動生成されていない: ${card!.title}`);
  // 蒸留はしない。要素文は空のまま
  assert.deepEqual(card!.elements, []);
});

test("**書く時点で条件を確かめる** — 探した後に状態が変わっても間違ったものを畳まない", () => {
  const trashedLate = makeDoneTask("押さえる直前にゴミ箱へ");
  trashTask(trashedLate);

  const reopenedLate = makeDoneTask("押さえる直前に差し戻し");
  updateTasks([{ id: reopenedLate, patch: { status: "todo" } }]);

  const takenAlready = makeDoneTask("先に別のコンテナが押さえた");
  const first = foldIntoContainer([takenAlready])!;

  // 押さえられるものが無いときは**空のコンテナを残さない**
  assert.equal(foldIntoContainer([trashedLate, reopenedLate, takenAlready]), undefined);
  // 先に押さえたコンテナから奪っていないこと (無条件UPDATEだと奪える)
  assert.deepEqual(tasksOfCard(first.id).map((t) => t.id), [takenAlready], "先発コンテナから奪っている");
});

test("**途中で失敗したら何も書かない** (畳んだのに索引に無い、を作らない)", () => {
  // タスク行とコンテナの索引は別のUPDATEなので、囲まないと片方だけ書かれた状態が残る。
  // その状態は1段目の探し方 (archived=0) では見つからず、回収できない
  const ok = makeDoneTask("巻き戻し後も畳まれていないDone");
  const before = listSummaryCards().length;

  assert.throws(
    () => foldIntoContainer([ok, {} as unknown as number]),
    "壊れた入力なのに例外が飛んでいない (前提が崩れている)"
  );

  assert.equal(getTask(ok)?.status, "done");
  assert.ok(listLooseDoneIds().includes(ok), "巻き戻っていない (畳まれたことになっている)");
  assert.equal(listSummaryCards().length, before, "空のコンテナが残っている");
});

test("3段目: 期限を過ぎたコンテナは消えるが、**中のタスクは消えない**", () => {
  const t = makeDoneTask("期限切れコンテナの中身");
  const card = foldIntoContainer([t])!;

  assert.deepEqual(expireContainers(24), [], "作りたてのコンテナを消している");
  assert.ok(getSummaryCard(card.id), "作りたてのコンテナが消えている");

  assert.ok(expireContainers(0).includes(card.id), "期限を過ぎたコンテナが消えていない");
  assert.equal(getSummaryCard(card.id), undefined, "コンテナが残っている");

  // 器が消えるだけ。タスクは archived=1 のまま残り、search_tasks で引ける
  assert.equal(getTask(t)?.status, "done", "タスクまで消えている");
  assert.equal(isArchived(t), true, "板に出戻っている (archived が外れた)");
  assert.ok(!listLooseDoneIds().includes(t), "1段目に戻ってきている (次の検収でまた畳まれてしまう)");
});

test("3段目: 蒸留をやめる前に作られた要約カードは残す", () => {
  // 要素文を持つカードは「常駐させる前提」で作ったもの。ロスタイムの規則を後から当てない
  const t = makeDoneTask("旧要約カードの中身");
  const legacy = foldIntoContainer([t])!;
  // 蒸留経路は消したので、旧世代の姿は生SQLで作る (production にはもう作る道がない)
  db().prepare("UPDATE summary_cards SET elements = ? WHERE id = ?")
    .run(JSON.stringify([{ text: "むかし蒸留した要素文", checked: false }]), legacy.id);

  assert.deepEqual(expireContainers(0), [], "旧要約カードまで消している");
  assert.ok(getSummaryCard(legacy.id), "旧要約カードが消えている");
});

test.after(() => {
  // better-sqlite3 がDBを掴んだままだと消せないことがある。消せなくてもテストは失敗させない
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 一時領域なので放置してよい */
  }
});
