import { archiveTasks, listLooseDoneIds, unarchiveTask } from "./db.js";
import { log } from "./log.js";

// #200: Done列は3段。
//
//   1. バラバラ  status='done', archived=0   直近の検収バッチ。個別カードで並ぶ
//   2. 箱        archived=1 + 下のメモリ     それ以前。折りたたんで1枚
//   3. 消える    archived=1 だけ             24時間経過。板に出ない
//
// **状態が動くのはDoneボタンを押した瞬間だけ** (と、Doneから差し戻したとき)。タイマーも
// バックグラウンド処理も起動時sweepも持たず、**読み取りは何も書き換えない**。
// 列が汚れて困るのは見ている人だけで、押すときは必ず見ている。
//
// **箱はDBに持たない。**中身は「直近24時間に畳んだカード」でしかなく、器としての寿命が
// セッションより短い。再起動すれば消えるが、消えて困るものは何も入っていない
// (カード本体は archived=1 でDBに残り、search_cards と番地で引ける)。
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

/** 期限内のものだけ。**純粋関数**にしてあるのが要点 (下の foldedContainer を見る) */
function fresh(items: FoldedTask[] | undefined): FoldedTask[] {
  const limit = Date.now() - CONTAINER_HOURS * 3600_000;
  return (items ?? []).filter((t) => t.foldedAt > limit);
}

/** 24時間より古いものを落とした中身。空なら undefined (箱ごと出さない)。
 *
 * **読むだけで、状態は変えない。**ここは `GET /api/board` と `broadcastBoard()` から呼ばれ、
 * broadcastBoard はカードの追加・更新・ゴミ箱・チャット・MCP操作など**Doneと無関係な経路**から
 * 何度も走る。期限切れをここで捨てて書き戻すと、「押した瞬間にしか動かない」が嘘になり、
 * 板を眺めているだけで中身が消える (自動レビュー指摘)。
 * 実際に捨てるのは次に畳むときで、それまで残っていても読み手には見えない */
export function foldedContainer(projectId: number): FoldedTask[] | undefined {
  const kept = fresh(containers.get(projectId));
  return kept.length === 0 ? undefined : kept;
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

  // 期限切れを捨てるのはここ (書くのはこの経路だけ、という不変条件を保つため)
  const now = Date.now();
  containers.set(projectId, [...fresh(containers.get(projectId)), ...folded.map((t) => ({ ...t, foldedAt: now }))]);
  log("archive", `#${folded.map((t) => t.id).join(", #")} を畳みました`);
}

/** doneから戻されたカードを板へ返す */
export function onTaskReopened(projectId: number, taskId: number): void {
  unarchiveTask(taskId);
  const kept = (containers.get(projectId) ?? []).filter((t) => t.id !== taskId);
  if (kept.length > 0) containers.set(projectId, kept);
  else containers.delete(projectId);
}
