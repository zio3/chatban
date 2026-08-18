import { archiveTasks, listLooseDoneIds, unarchiveTask } from "./db.js";
import { log } from "./log.js";

// #200: Done列は3段。
//
//   1. バラバラ  status='done', archived=0   直近の検収バッチ。個別カードで並ぶ
//   2. 箱        archived=1 + 下のメモリ     それ以前。折りたたんで1枚
//   3. 消える    archived=1 だけ             24時間経過。板に出ない
//
// **評価するのはDoneボタンを押した瞬間だけ。**タイマーもバックグラウンド処理も起動時sweepも
// 持たない。押さなければ何も動かない — 列が汚れて困るのは見ている人だけで、押すときは必ず見ている。
//
// **箱はDBに持たない。**中身は「直近24時間に畳んだタスク」でしかなく、器としての寿命が
// セッションより短い。再起動すれば消えるが、消えて困るものは何も入っていない
// (タスク本体は archived=1 でDBに残り、search_tasks と番地で引ける)。
//
// 以前はここでLLMに経緯を読ませて要素文へ分解し、summary_cards に常駐させていた
// (#46/#56/#105)。やめた理由は #200 の経緯メモにある。要点は、**要約が読まれていなかった**こと
// (同じ内容がgitに差分つきで残っている) と、非同期だったせいで #191/#195/#196 が派生したこと。

/** 箱の寿命。畳んだ時刻からの相対 — カレンダー日で切ると、0時をまたいだ直後にDoneを押したときに
 * 数分前の検収バッチが「昨日の分」として消える */
const CONTAINER_HOURS = 24;

export type FoldedTask = { id: number; title: string; foldedAt: number };

// プロジェクトごとに1個。**増えない**ので、上限も掃除の引き金も要らない
const containers = new Map<number, FoldedTask[]>();

/** 24時間より古いものを落とした中身。空なら undefined (箱ごと出さない) */
export function foldedContainer(projectId: number): FoldedTask[] | undefined {
  const limit = Date.now() - CONTAINER_HOURS * 3600_000;
  const kept = (containers.get(projectId) ?? []).filter((t) => t.foldedAt > limit);
  if (kept.length === 0) {
    containers.delete(projectId);
    return undefined;
  }
  containers.set(projectId, kept);
  return kept;
}

/** 検収でDoneが増えたときに列を畳み直す。**同期**で、押した瞬間に完結する。
 *
 * justApproved は「いま確定したぶん」= 1段目に残すもの。それ以外のバラバラを畳む。
 * 前回までに畳み損なったものがあっても、それは1段目の定義そのものなので自然に入る。 */
export function foldDoneColumn(projectId: number, justApproved: number[]): void {
  const loose = listLooseDoneIds().filter((id) => !justApproved.includes(id));
  if (loose.length === 0) return;

  const folded = archiveTasks(loose);
  if (folded.length === 0) return;

  const now = Date.now();
  const kept = foldedContainer(projectId) ?? [];
  containers.set(projectId, [...kept, ...folded.map((t) => ({ ...t, foldedAt: now }))]);
  log("archive", `#${folded.map((t) => t.id).join(", #")} を畳みました`);
}

/** doneから戻されたタスクを板へ返す */
export function onTaskReopened(projectId: number, taskId: number): void {
  unarchiveTask(taskId);
  const kept = (containers.get(projectId) ?? []).filter((t) => t.id !== taskId);
  if (kept.length > 0) containers.set(projectId, kept);
  else containers.delete(projectId);
}
