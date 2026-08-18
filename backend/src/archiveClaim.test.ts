import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

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
  clearCardNeedsSummary,
  createCardWithClaimedTasks,
  createSummaryCard,
  createTask,
  detachTaskFromCard,
  getSummaryCard,
  getTask,
  listCardsNeedingSummary,
  listSummaryCards,
  listUnfoldedDoneIds,
  reassignTasksToCard,
  setCardFrozen,
  setChecked,
  tasksOfCard,
  trashTask,
  updateCardContent,
  updateTasks,
} = await import("./db.js");

/** 一時データディレクトリの中のプロジェクトDB。**故障注入のときだけ直に開く** */
function projectFile(): string {
  return fs.readdirSync(path.join(dataDir, "projects")).filter((n) => n.endsWith(".db"))[0];
}

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
  // **畳み済みのDoneも作る。**これが無いと `archived = 0` の条件を落としても
  // このテストが通ってしまう (Codexレビュー指摘。3条件のうち1つだけ試験していなかった)
  const archivedDone = makeDoneTask("既に畳んであるDone");
  claimTasksForCard([archivedDone], createSummaryCard().id);

  const found = listUnfoldedDoneIds();
  assert.ok(found.includes(done), "畳み損なったDoneが見つかっていない");
  assert.ok(!found.includes(review), "done以外を拾っている");
  // **ゴミ箱のDoneを拾うと、ゴミ箱と要約カードの両方に入る** (trashTask は status を変えないので、
  // status だけ見ていると素通りする)
  assert.ok(!found.includes(trashedDone), "ゴミ箱のDoneを拾っている");
  // 畳み済みを拾うと、**同じタスクが2枚のカードに入る**
  assert.ok(!found.includes(archivedDone), "畳み済みのDoneを拾っている");
});

test("**archived=0 なのに古いカードIDが残った行も畳み直せる** (回復不能にしない) (#195)", () => {
  // #196 の競合 (rollUpOldCards と compactArchive) で、`archived = 0` なのに
  // `summary_card_id` が埋まったままの行ができうる。claim の条件に
  // `summary_card_id IS NULL` を入れると、**その行は二度と畳めなくなる**。
  // 二重取りは `archived = 0` だけで防げるので、その条件は置かない
  const id = makeDoneTask("古いカードIDが残ったDone");
  const stale = createSummaryCard();
  claimTasksForCard([id], stale.id);
  detachTaskFromCard(id); // 再オープン相当: archived=0 に戻る
  // 競合で summary_card_id だけが書き戻された状態を作る
  reassignTasksToCard([id], stale.id);

  const card = createSummaryCard();
  assert.deepEqual(claimTasksForCard([id], card.id).claimed, [id], "壊れた行を畳み直せていない");
  assert.deepEqual(tasksOfCard(card.id).map((t) => t.id), [id]);
  // **古いカードの索引からも外れていること。**外さないと同じIDが2枚に載り (実測: stale:[1] fresh:[1])、
  // UIの件数が二重になるうえ、rollUpOldCards / compactArchive が古い索引から拾い直す。
  // **空になった旧カードは消えていること** — 索引だけ外すと、出ていったタスクを説明する
  // 古い要約が taskIds=[] のまま恒久的に残る (Codexレビュー指摘)
  assert.equal(getSummaryCard(stale.id), undefined, "空になった旧カードが残っている");
});

test("旧カードに残件があれば消さず、作り直しの対象として返す (#195)", () => {
  // **本文の始末まで見る。**索引だけ直しても、出ていったタスクを説明する古い要約が残る。
  // 前のテストが旧カードに elements を持たせていなかったので、この問題を検出できていなかった
  const moving = makeDoneTask("別のカードへ移すDone");
  const staying = makeDoneTask("旧カードに残るDone");
  const old = createSummaryCard();
  claimTasksForCard([moving, staying], old.id);
  updateCardContent(old.id, "移動前のまとめ", [
    { text: `#${moving} と #${staying} を完了`, checked: false },
  ]);

  // moving だけを新カードへ移せる状態にする (#196 の壊れ方と同じ形)
  detachTaskFromCard(moving);
  reassignTasksToCard([moving, staying], old.id);

  const fresh = createSummaryCard();
  const { claimed, staleCards } = claimTasksForCard([moving], fresh.id);
  assert.deepEqual(claimed, [moving]);

  const oldCard = getSummaryCard(old.id);
  assert.ok(oldCard, "残件があるのに旧カードが消えている");
  assert.deepEqual(oldCard!.taskIds, [staying], "旧カードの索引が直っていない");
  // **古い本文がそのまま残っているので、作り直しの対象として返す**
  // (作り直しはLLMを呼ぶ非同期処理なので、呼び出し側 archive.ts がやる)
  assert.ok(staleCards.includes(old.id), "残件のある旧カードが作り直しの対象に入っていない");
  assert.ok(
    oldCard!.elements.some((e) => e.text.includes(`#${moving}`)),
    "前提が崩れている (古い本文が残っていない)"
  );
});

test("整頓済み(frozen)の旧カードは空でも消さない (#195)", () => {
  // frozen は人間が整頓して固定した過去ログ。**空になったからと消すと、人が確かめた文が消える**。
  // 作り直しの対象として返し、regenerateCard の既定 (チェック済み要素だけ残す) に委ねる
  const id = makeDoneTask("整頓済みカードから出ていくDone");
  const old = createSummaryCard();
  claimTasksForCard([id], old.id);
  updateCardContent(old.id, "過去ログ", [{ text: "人が確かめた要素", checked: true }]);
  setCardFrozen(old.id);

  detachTaskFromCard(id);
  reassignTasksToCard([id], old.id);

  const fresh = createSummaryCard();
  const { staleCards } = claimTasksForCard([id], fresh.id);
  assert.ok(getSummaryCard(old.id), "frozen の過去ログを消している");
  assert.ok(staleCards.includes(old.id), "frozen の旧カードが作り直しの対象に入っていない");
});

test("カードの作成と claim は同時に起きる — 空カードを残さない (#195)", () => {
  // カード作成が claim の外にあると、作った直後や「0件だったので消す」前に
  // プロセスが止まったときに**空のカードが残る**。この札が塞ごうとしている事故そのものを
  // 自分の実装で作っていた (Codexレビュー指摘)
  const before = listSummaryCards().length;

  // 畳めるものが1つも無い指定 (review のまま)
  const notDone = createTask("まだ検収待ち", "review").id;
  assert.equal(createCardWithClaimedTasks([notDone]), null, "畳めないのに結果が返っている");
  assert.equal(listSummaryCards().length, before, "空のカードが残っている");

  // 畳めるものがあればカードごと返る
  const done = makeDoneTask("畳めるDone");
  const result = createCardWithClaimedTasks([done]);
  assert.ok(result, "畳めるのに null が返っている");
  assert.deepEqual(result!.claimed, [done]);
  assert.deepEqual(tasksOfCard(result!.card.id).map((t) => t.id), [done]);
  assert.equal(listSummaryCards().length, before + 1);
});

test("押さえられたものだけを返す (#195)", () => {
  const a = makeDoneTask("押さえられるA");
  const b = makeDoneTask("押さえられるB");
  const card = createSummaryCard();

  const { claimed } = claimTasksForCard([a, b], card.id);
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

  assert.deepEqual(claimTasksForCard([id], first.id).claimed, [id], "1回目で押さえられていない");
  // 起動時の掃除と通常のフックが同じIDを拾った状況。**後から来たほうは空で返る**
  assert.deepEqual(claimTasksForCard([id], second.id).claimed, [], "2回目も押さえられてしまった");
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

  assert.deepEqual(claimTasksForCard([id], card.id).claimed, [], "ゴミ箱のタスクを押さえてしまった");
  assert.deepEqual(tasksOfCard(card.id), [], "ゴミ箱のタスクがカードに入っている");
  assert.ok(getTask(id)?.trashedAt, "ゴミ箱から出てしまっている");
});

test("**探したあとにDoneから戻されたら押さえない** (#105の幽霊を作らない) (#195)", () => {
  const id = makeDoneTask("押さえる直前に差し戻し");
  const card = createSummaryCard();

  updateTasks([{ id, patch: { status: "todo" } }]); // 人間がDoneから引き戻した

  assert.deepEqual(claimTasksForCard([id], card.id).claimed, [], "done以外を押さえてしまった");
  // 押さえていたら「todoなのに archived=1 でボードから消える」幽霊になる (#105)
  assert.deepEqual(tasksOfCard(card.id), [], "差し戻したタスクがカードに入っている");
});

test("**畳んだ直後に落ちても、要約の作り直し待ちがDBに残る** (#195)", () => {
  // commit 後・要約前にプロセスが止まると、`archived=1` なのに要約が空のカードが残る。
  // 掃除は `archived=0` しか拾わないので**次の起動でも再試行されない** —
  // #191 で直した「要約を生成中…」が別経路で復活する (Codexレビュー指摘)。
  // 待ちを in-memory (staleCards と await) だけに置かず、DBに書いて再起動後に見つける
  const id = makeDoneTask("畳んだ直後に落ちるタスク");
  const result = createCardWithClaimedTasks([id]);
  assert.ok(result);

  // ここでプロセスが落ちた、という状況 (regenerateCard を呼ばない)
  assert.ok(
    listCardsNeedingSummary().includes(result!.card.id),
    "作り直し待ちがDBに残っていない (次の起動で拾えない)"
  );
  assert.deepEqual(getSummaryCard(result!.card.id)?.elements ?? [], [], "前提が崩れている (要約が空でない)");

  // 中身を書けたら印は消える (無限に作り直しへ戻さない)
  updateCardContent(result!.card.id, "作り直した", [{ text: "要素", checked: false }]);
  clearCardNeedsSummary(result!.card.id);
  assert.ok(!listCardsNeedingSummary().includes(result!.card.id), "作り直したのに待ちが残っている");
});

test("旧カードの作り直し待ちもDBに残る (#195)", () => {
  // staleCards は呼び出し側が await で回すだけだったので、落ちると消えていた
  const moving = makeDoneTask("旧カードから移すDone");
  const old = createSummaryCard();
  claimTasksForCard([moving], old.id);
  updateCardContent(old.id, "移動前", [{ text: `#${moving} を完了`, checked: false }]);
  clearCardNeedsSummary(old.id); // いったん作り直し済みの状態にする

  const staying = makeDoneTask("旧カードに残るDone");
  claimTasksForCard([staying], old.id);
  clearCardNeedsSummary(old.id);

  detachTaskFromCard(moving);
  reassignTasksToCard([moving, staying], old.id);

  const fresh = createSummaryCard();
  const { staleCards } = claimTasksForCard([moving], fresh.id);
  assert.ok(staleCards.includes(old.id));
  assert.ok(listCardsNeedingSummary().includes(old.id), "旧カードの作り直し待ちがDBに残っていない");
});

// **再生成の経路は claim だけではない** (Codexレビュー指摘)。
// rollUpOldCards / compactArchive は reassignTasksToCard、onTaskReopened は detachTaskFromCard を
// 通ってから `await regenerateCard()` する。そこへ辿り着く前に落ちると本文が古いまま残るので、
// **印は「中身を無効にする操作」の側で立てる**。3経路まとめてその2操作で覆える

test("カードの顔ぶれを付け替えたら作り直し待ちが立つ (rollUp / compact の経路) (#195)", () => {
  const a = makeDoneTask("付け替えられるDone");
  const card = createSummaryCard();
  claimTasksForCard([a], card.id);
  updateCardContent(card.id, "作り直し済み", [{ text: "要素", checked: false }]);
  clearCardNeedsSummary(card.id);
  assert.ok(!listCardsNeedingSummary().includes(card.id), "前提が崩れている");

  // rollUpOldCards / compactArchive がやること (この後に白紙化して再生成する)
  reassignTasksToCard([a], card.id);

  assert.ok(
    listCardsNeedingSummary().includes(card.id),
    "付け替えたのに作り直し待ちが立っていない (白紙のまま落ちると拾えない)"
  );
});

test("カードからタスクを外したら作り直し待ちが立つ (再オープンの経路) (#195)", () => {
  const id = makeDoneTask("再オープンされるDone");
  const other = makeDoneTask("カードに残るDone");
  const card = createSummaryCard();
  claimTasksForCard([id, other], card.id);
  updateCardContent(card.id, "作り直し済み", [{ text: "要素", checked: false }]);
  clearCardNeedsSummary(card.id);

  detachTaskFromCard(id); // onTaskReopened がやること

  assert.ok(
    listCardsNeedingSummary().includes(card.id),
    "外したのに作り直し待ちが立っていない (タスクはtodoに戻るので done の掃除でも拾えない)"
  );
});

test("**途中で失敗したら何も書かない** (印だけ立つ・索引だけ古い を作らない) (#195)", () => {
  // Codexの求めた「各SQLの間で停止した状態」は、**1つのトランザクションにした時点で
  // 観測できなくなる** (commit するかしないかのどちらか) ので、代わりに
  // **途中で例外を起こして巻き戻ることを見る**。2件目の値を壊して2文目を失敗させる
  const kept = makeDoneTask("巻き戻し後も元のカードに居るDone");
  const home = createSummaryCard();
  claimTasksForCard([kept], home.id);
  updateCardContent(home.id, "元のまとめ", [{ text: "要素", checked: false }]);
  clearCardNeedsSummary(home.id);

  const other = createSummaryCard();
  assert.throws(
    () => reassignTasksToCard([kept, {} as unknown as number], other.id),
    "壊れた入力なのに例外が飛んでいない (前提が崩れている)"
  );

  // 1文目は成功していたが、巻き戻っているので所有先は変わっていない
  assert.deepEqual(
    tasksOfCard(home.id).map((t) => t.id),
    [kept],
    "巻き戻っていない (所有先だけ変わった状態が残った)"
  );
  assert.deepEqual(tasksOfCard(other.id), [], "移動先に入ってしまっている");
  assert.ok(!listCardsNeedingSummary().includes(other.id), "書けていないのに印だけ立っている");
});

test("**外す操作も途中で失敗したら何も書かない** (#195)", () => {
  // reassignTasksToCard 側だけ試験していて、detachTaskFromCard の巻き戻しを見ていなかった
  // (Codexレビュー指摘)。こちらは「タスクを外す → 印を立てる → カードの索引を書き直す」の
  // 3段なので、**途中で落ちると印だけ立って索引が古い**という別の中間状態になりうる。
  //
  // 例外は**カードの task_ids を壊れたJSONにして**起こす (getSummaryCard の解析で落ちる)。
  // 実装の内部を触らずに、タスク更新のあとで失敗させられる唯一の場所
  const id = makeDoneTask("外す途中で失敗するDone");
  const card = createSummaryCard();
  claimTasksForCard([id], card.id);
  clearCardNeedsSummary(card.id);

  const raw = new Database(path.join(dataDir, "projects", projectFile()));
  raw.prepare("UPDATE summary_cards SET task_ids = ? WHERE id = ?").run("{壊れたJSON", card.id);

  assert.throws(() => detachTaskFromCard(id), "壊れたJSONなのに例外が飛んでいない (前提が崩れている)");

  // タスクは畳まれたまま (外れていない)
  const after = raw.prepare("SELECT archived, summary_card_id FROM tasks WHERE id = ?").get(id) as any;
  assert.equal(after.archived, 1, "巻き戻っていない (タスクだけ外れた)");
  assert.equal(after.summary_card_id, card.id, "巻き戻っていない (所属だけ外れた)");
  // 印も立っていない (書けていないのに待ちだけ増やさない)
  const flag = raw.prepare("SELECT needs_summary FROM summary_cards WHERE id = ?").get(card.id) as any;
  assert.equal(flag.needs_summary, 0, "書けていないのに印だけ立っている");
  raw.close();
});

test.after(() => {
  // better-sqlite3 がDBを掴んだままだと消せないことがある。消せなくてもテストは失敗させない
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 一時領域なので放置してよい */
  }
});
