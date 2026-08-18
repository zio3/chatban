import {
  deleteSummaryCards,
  detachTaskFromCard,
  expireContainers,
  foldIntoContainer,
  listLooseDoneIds,
  tasksOfCard,
  type SummaryCard,
} from "./db.js";
import { log } from "./log.js";

// #200: Done列は3段。
//
//   1. バラバラ  status='done', archived=0            直近の検収バッチ。個別カードで並ぶ
//   2. コンテナ  archived=1, summary_card_id=<card>   それ以前。折りたたんで1枚
//   3. 消える    archived=1, summary_card_id=NULL     24時間経過。板から降りる
//
// **評価するのはDoneボタンを押した瞬間だけ。**タイマーもバックグラウンド処理も起動時sweepも
// 持たない。押さなければ何も動かない — 列が汚れて困るのは見ている人だけで、押すときは必ず見ている。
// 片付けが必要になる瞬間と、片付けが起きる瞬間が一致しているので、印も回収処理も要らない。
//
// 3段目で消えるのは器のほうで、タスクは archived=1 のまま残る。引くのは一覧ではなく
// search_tasks と番地 (「#10がやりたい」で指させる) — 指させるものを眺めさせない。
//
// 以前はここでLLMに経緯を読ませて要素文へ分解し、日単位でまとめ直していた (#46/#56/#105)。
// やめた理由は #200 の経緯メモにある。要点だけ言うと、**要約は読まれておらず**、
// 同じ内容が git のコミットとPR本文に差分つきで残っていた。そして非同期だったせいで
// #191/#195/#196 が派生していた。同期の1文なら中間状態が存在しない。

/** コンテナの寿命。カレンダー日ではなく作成時刻からの相対 (理由は expireContainers) */
const CONTAINER_HOURS = 24;

/** 検収でDoneが増えたときに列を畳み直す。**同期**で、押した瞬間に完結する。
 *
 * 引数の justApproved は「いま確定したぶん」= 1段目に残すもの。それ以外のバラバラを畳む。
 * 前回までに畳み損なったものがあっても、それは1段目の定義そのものなので自然に入る
 * (#195 の「畳み損なったDoneの回収」が、専用の処理を持たずに済む形)。 */
export function foldDoneColumn(justApproved: number[]): SummaryCard | undefined {
  const expired = expireContainers(CONTAINER_HOURS);
  if (expired.length > 0) log("archive", `${CONTAINER_HOURS}時間を過ぎた card#${expired.join(", #")} を板から降ろしました`);

  const loose = listLooseDoneIds().filter((id) => !justApproved.includes(id));
  if (loose.length === 0) return undefined;

  const card = foldIntoContainer(loose);
  if (!card) {
    log("archive", `foldDoneColumn: 畳める対象が無かった (${loose.join(",")})`);
    return undefined;
  }
  log("archive", `#${card.taskIds.join(", #")} を card#${card.id} へ畳みました`);
  return card;
}

/** doneから戻されたタスクをコンテナから外す。最後の1件が抜けて空になったコンテナは消す */
export function onTaskReopened(taskId: number): void {
  const cardId = detachTaskFromCard(taskId);
  if (!cardId) return;
  if (tasksOfCard(cardId).length === 0) {
    deleteSummaryCards([cardId]);
    log("archive", `card#${cardId} became empty -> deleted`);
  }
}
