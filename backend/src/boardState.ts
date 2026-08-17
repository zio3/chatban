import { getProjectContextRow, listSummaryCards, listTasks } from "./db.js";
import { currentProjectId } from "./store.js";
import { log } from "./log.js";

// #150/#187: MCP経由のエージェント向けに「ボードの写し + 同期トークン」を配る。
//
// 直したい事故はこれ: エージェントは自分が最後に読んだ一覧を現在の状態だと思い込み、
// 食い違うとボードのほうを疑う。実際 2026-08-15 に「live_tasks に review が出ないバグがある」と
// 誤報告した (人間が9件を検収して done+archived にしていただけで、ビューは正しかった)。
// 人間はUIで視覚的に上書きされるが、**LLMのコンテキストは追記型で上書きが無い**。
//
// 設計は promptState.ts (#50) と同じ「スナップショットを2つ比べる」方式で、変更ログは持たない。
// 書き込み経路にフックを刺さずに済み、追加・変更に加えて**消滅**も同じ計算で拾える
// (「要約カードに畳まれて消えた」は updated_at では絶対に拾えない — Done要約が主戦場になる以上ここは効く)。
//
// promptState と分けているのは用途が違うため: あちらはプロンプトのプレフィックスをバイト単位で
// 安定させるための表示テキスト、こちらはMCPの応答に載せる「何がどう変わったか」。

/** 同期トークンが有効な上限時間。これを過ぎたスナップショットは捨て、全件返しにフォールバックする */
const TTL_MS = 60 * 60 * 1000;
/** 1プロジェクトあたりの保持数。エージェントが何本も繋いでいても足りる程度の上限 */
const MAX_SNAPSHOTS = 32;
/** 差分がこれを超えたら、差分を読ませるより全件を渡したほうが速い (promptState の MAX_EVENTS と同じ考え) */
const MAX_CHANGES = 40;

/** 差分に出す分だけを持つ。context本文のような重いものは持たない (版だけ見る) */
export interface TaskFacts {
  title: string;
  status: string;
  /** #179 で担当者を廃止したらこの項目ごと消える。それまでは変更を見逃さないために持つ */
  assignee: string | null;
  summary: string | null;
  due: string | null;
  blockedBy: number[] | null;
  rejected: boolean;
  contextVersion: number;
  /** 人が実物で確かめた日時。**この機能が拾いたいものの本体。**
   * 2026-08-15 の事故は「人間が検収したことをエージェントが知らなかった」ために起きた。
   * setChecked は updated_at を動かさないので、タイムスタンプ方式では二重に拾えない (自動レビュー指摘) */
  checkedAt: string | null;
  /** 並び順。reorder_tasks で動く。1件動かすと周りも連動して変わるので、差分では1行にまとめる */
  sort: number;
}

export interface BoardSnapshot {
  syncToken: string;
  takenAt: number;
  tasks: Map<number, TaskFacts>;
  cards: Map<number, string>;
  /** 前提情報は**本文を持たない (#187)**。応答に載せるのも版だけで、
   * 中身が要るなら get_project_context を呼ばせる。
   * 3,000字級の本文がボードを取るたびに乗るのを止めるのが目的 (#186 と同じ問題) */
  projectContextVersion: number;
}

// 同期トークンの時刻部分。**再起動をまたいだ偶然の一致を防ぐのが目的** —
// 連番はプロセス起動ごとに振り直されるので、これが無いと前のプロセスが配ったトークンが
// たまたま一致し、無関係なスナップショットからの差分を返してしまう。
// 乱数でも防げるが (以前はそうしていた)、秒までの時刻なら**いつのものかが読んで分かる**。
// backend/logs と突き合わせられるほうが、失効の調査で効く
function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `T${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

let counter = 0;

const snapshots = new Map<number, BoardSnapshot[]>();

/** 要約カードの索引。**区切り文字で連結しない** — 要素に同じ文字列を書けるので、
 * ['B / C'] と ['B', 'C'] が同じ索引になり、カードの分割・編集を見逃す (自動レビュー指摘) */
function cardIndex(title: string, elements: string[]): string {
  return JSON.stringify([title, elements]);
}

/** 索引から人が読める形へ戻す。差分の文面に出すのは連結した見た目のほうでよい */
function cardLabel(index: string): string {
  try {
    const [title, elements] = JSON.parse(index) as [string, string[]];
    return `${title} :: ${elements.join(" / ")}`;
  } catch {
    return index;
  }
}

/** いまのボードを写し取る。DBに触るのはここだけで、差分計算(diffBoards)は純粋関数にしてある */
export function captureBoard(): Omit<BoardSnapshot, "syncToken" | "takenAt"> {
  const tasks = new Map<number, TaskFacts>(
    listTasks().map((t) => [
      t.id,
      {
        title: t.title,
        status: t.status,
        assignee: t.assignee,
        summary: t.summary ?? null,
        due: t.due,
        blockedBy: t.blockedBy,
        rejected: t.rejected,
        contextVersion: t.contextVersion,
        checkedAt: t.checkedAt ?? null,
        sort: t.sort,
      },
    ])
  );
  const cards = new Map<number, string>(
    listSummaryCards().map((c) => [c.id, cardIndex(c.title, c.elements.map((e) => e.text))])
  );
  return { tasks, cards, projectContextVersion: getProjectContextRow().version };
}

/** 列ごとの「並んでいるIDの列」。sort の数値ではなくこの並びを比べる。
 * only を渡すと、そこに含まれるIDだけで並びを作る (追加・消滅による見かけの変化を除くため)。
 * sort が同値のときは id で決める — 実データは listTasks の ORDER BY sort, id 順で入るので、
 * 比較関数にも同じ規則を書いておく (暗黙の安定性に寄りかからない) */
function columnLists(tasks: Map<number, TaskFacts>, only?: Set<number>): Map<string, number[]> {
  const byStatus = new Map<string, { id: number; sort: number }[]>();
  for (const [id, t] of tasks) {
    if (only && !only.has(id)) continue;
    const list = byStatus.get(t.status) ?? [];
    list.push({ id, sort: t.sort });
    byStatus.set(t.status, list);
  }
  const out = new Map<string, number[]>();
  for (const [status, list] of byStatus) {
    out.set(
      status,
      list.sort((a, b) => a.sort - b.sort || a.id - b.id).map((x) => x.id)
    );
  }
  return out;
}

function columnOrders(tasks: Map<number, TaskFacts>, only?: Set<number>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [status, ids] of columnLists(tasks, only)) out.set(status, ids.map((id) => `#${id}`).join(","));
  return out;
}

/** 列の中でそのタスクがどこに居るか。**追加行にこれが要る** —
 * ゴミ箱からの復元は sort を保ったまま戻るので列の途中に入りうるが、
 * 「追加」は並び順の判定 (居続けたIDの比較) から外れるため、ここで言わないと位置が分からない (自動レビュー指摘) */
function positionIn(lists: Map<string, number[]>, status: string, id: number): string {
  const ids = lists.get(status) ?? [];
  const at = ids.indexOf(id);
  if (at < 0 || ids.length <= 1) return `${status} の先頭`;
  if (at === 0) return `${status} の先頭 (次が #${ids[1]})`;
  if (at === ids.length - 1) return `${status} の末尾 (前が #${ids[at - 1]})`;
  return `${status} の #${ids[at - 1]} と #${ids[at + 1]} の間`;
}

function sameDeps(a: number[] | null, b: number[] | null): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** 1件のタスクについて、変わったフィールドだけを "status: todo -> inprogress" の形で並べる */
function fieldChanges(prev: TaskFacts, cur: TaskFacts): string[] {
  const out: string[] = [];
  if (prev.status !== cur.status) out.push(`status: ${prev.status} -> ${cur.status}`);
  if (prev.title !== cur.title) out.push(`title: 「${prev.title}」-> 「${cur.title}」`);
  if (prev.assignee !== cur.assignee) out.push(`担当: ${prev.assignee ?? "なし"} -> ${cur.assignee ?? "なし"}`);
  if (prev.rejected !== cur.rejected) out.push(cur.rejected ? "却下された" : "却下を取り消した");
  if (prev.due !== cur.due) out.push(`期限: ${prev.due ?? "なし"} -> ${cur.due ?? "なし"}`);
  if (!sameDeps(prev.blockedBy, cur.blockedBy))
    out.push(`依存: [${(prev.blockedBy ?? []).join(",")}] -> [${(cur.blockedBy ?? []).join(",")}]`);
  if (prev.summary !== cur.summary) out.push(`現況: ${cur.summary ?? "(消去)"}`);
  if (prev.checkedAt !== cur.checkedAt)
    out.push(cur.checkedAt ? `人が検収の印を付けた (${cur.checkedAt})` : "検収の印が外れた");
  // 経緯メモは本文を載せると差分が膨らむので、変わったことだけ伝えて中身は取りに行かせる
  if (prev.contextVersion !== cur.contextVersion) out.push(`経緯メモが更新された (v${cur.contextVersion})`);
  return out;
}

/**
 * 2つのスナップショットの差分を、LLMがそのまま読める1行の並びで返す。
 *
 * **各行はそれ単体で現在が確定する形にしてある。** LLMのコンテキストは追記型なので、
 * 古い一覧が残ったまま差分を渡されると自力でマージを迫られる。IDだけを指す差分にしない。
 */
export function diffBoards(
  prev: Pick<BoardSnapshot, "tasks" | "cards" | "projectContextVersion">,
  cur: Pick<BoardSnapshot, "tasks" | "cards" | "projectContextVersion">
): string[] {
  const changes: string[] = [];
  const curLists = columnLists(cur.tasks);

  for (const [id, t] of cur.tasks) {
    const before = prev.tasks.get(id);
    if (!before) {
      // 追加はIDだけでは何か分からないので内容ごと載せる。
      // **検収済みかどうかもここに要る** — ゴミ箱からの復元は checked_at を保ったまま
      // 「追加」として現れるので、fieldChanges を通らずに検収状態が抜け落ちる (自動レビュー指摘)
      const marks = [
        positionIn(curLists, t.status, id),
        ...(t.due ? [`期限 ${t.due}`] : []),
        ...(t.rejected ? ["却下"] : []),
        ...(t.checkedAt ? ["検収済み"] : []),
      ];
      changes.push(`+ #${id}「${t.title}」が追加された (${marks.join(", ")})`);
      continue;
    }
    const fields = fieldChanges(before, t);
    if (fields.length > 0) changes.push(`~ #${id}「${t.title}」 ${fields.join(" / ")}`);
  }

  for (const [id, t] of prev.tasks) {
    if (!cur.tasks.has(id)) {
      // 完了アーカイブ・要約への畳み込み・削除はどれもここに落ちる。
      // どれだったかはボードから消えた事実ほど重要ではないので、まとめて1つの表現にする
      changes.push(`- #${id}「${t.title}」がボードから消えた (完了アーカイブ・要約への統合・削除のいずれか)`);
    }
  }

  // **見るのは sort の数値ではなく、列に並んだIDの順そのもの。**
  // 数値で比べると両側に穴があった (自動レビュー指摘):
  //   - 列をまたいで動かすと sort が変わらないことがある (UIは移動先の先頭要素の sort-1 を振るので、
  //     0 の前に入れると 0 のまま)。数値が同じなので「並びが変わった」を出せない
  //   - 逆に sort を 0,1 -> 5,9 に振り直しただけで、見た目の順が同じでも「変わった」と出る
  //
  // 判定に使うのは**その列に居続けたIDの相対順序**。全IDで比べると、1件足すたび・
  // 1件動かすたびに「並び順が変わった」が付いてくる (出入りは + / - / status の行がもう伝えている)。
  // ただし列を移ってきたものは、**どこに入ったか**が status の行では分からないので、
  // 並びが2件以上ある列に限って現在順を出す
  const stayed = new Set(
    [...cur.tasks.entries()].filter(([id, t]) => prev.tasks.get(id)?.status === t.status).map(([id]) => id)
  );
  const prevOrder = columnOrders(prev.tasks, stayed);
  const curOrder = columnOrders(cur.tasks, stayed);
  const arrived = new Set(
    [...cur.tasks.entries()]
      .filter(([id, t]) => {
        const p = prev.tasks.get(id);
        return p !== undefined && p.status !== t.status;
      })
      .map(([, t]) => t.status)
  );
  const shown = columnOrders(cur.tasks);
  const countIn = (status: string) => (shown.get(status) ? shown.get(status)!.split(",").length : 0);
  const movedColumns = [...new Set([...prevOrder.keys(), ...curOrder.keys(), ...arrived])].filter((status) =>
    prevOrder.get(status) !== curOrder.get(status) ? true : arrived.has(status) && countIn(status) > 1
  );
  if (movedColumns.length > 0) {
    // 出すのは**全部入りの現在順**。判定から外した新入りも、いま何番目に居るかは知りたい
    const lines = movedColumns.map((status) => `${status}: ${shown.get(status) || "(空)"}`);
    changes.push(`並び順が変わった。現在の順は ${lines.join(" / ")}`);
  }

  for (const [id, idx] of cur.cards) {
    const before = prev.cards.get(id);
    if (!before) changes.push(`+ 要約カード#${id} が追加された (${cardLabel(idx)})`);
    else if (before !== idx) changes.push(`~ 要約カード#${id} が更新された (${cardLabel(idx)})`);
  }
  for (const [id, idx] of prev.cards) {
    if (!cur.cards.has(id)) changes.push(`- 要約カード#${id} が統合され消滅した (${cardLabel(idx)})`);
  }

  // 版で比べる。本文を持っていないので中身の差は出せないが、そもそも出すつもりが無い
  // (差分に3,000字が乗る)。「変わった」とだけ言って get_project_context を呼ばせる
  if (prev.projectContextVersion !== cur.projectContextVersion)
    changes.push(`プロジェクトの前提情報が更新された (v${cur.projectContextVersion})`);

  return changes;
}

/** いまのボードを写し取り、同期トークンを払い出して保持する */
export function takeSnapshot(): BoardSnapshot {
  const projectId = currentProjectId();
  const now = Date.now();
  const snap: BoardSnapshot = {
    syncToken: `p${projectId}-${stamp(new Date(now))}-${++counter}`,
    takenAt: now,
    ...captureBoard(),
  };
  const list = snapshots.get(projectId) ?? [];
  list.push(snap);
  // TTL切れと溢れた分を捨てる。失効は正常系なので、消えたこと自体は問題にならない
  const alive = list.filter((s) => Date.now() - s.takenAt <= TTL_MS).slice(-MAX_SNAPSHOTS);
  snapshots.set(projectId, alive);
  return snap;
}

/** 同期トークンからスナップショットを引く。無ければ null (呼び出し側は全件返しにフォールバックする) */
export function findSnapshot(syncToken: string): BoardSnapshot | null {
  const list = snapshots.get(currentProjectId()) ?? [];
  const found = list.find((s) => s.syncToken === syncToken);
  if (!found) return null;
  if (Date.now() - found.takenAt > TTL_MS) return null;
  return found;
}

/** テスト用。プロセス内に溜まったスナップショットを捨てる */
export function resetSnapshots(): void {
  snapshots.clear();
}

export interface BoardDelta {
  syncToken: string;
  /** 差分を返したときだけ入る。渡された同期トークン */
  since?: string;
  changes?: string[];
  full?: boolean;
  note?: string;
  /** 前提情報の版。**全件でも差分でも必ず載せる (#187)** —
   * 本文を返さなくなったぶん、「自分が読んだときから変わっていないか」を
   * これ1つで確かめられるようにしておく */
  projectContextVersion: number;
}

/**
 * MCPの応答に載せるボード状況を組み立てる。
 *
 * - `since` が無い / メモリに無い / 失効している → **全件を返す** (エラーにしない)。
 *   失効は正常系で、エラーを返すとLLMがリトライを考え始める
 * - 見つかれば、そこからの差分だけ返す
 * - 差分が MAX_CHANGES を超えたら、読ませる負担が上回るので全件に切り替える
 */
/**
 * 書き込み応答に混ぜるボード部分を組み立てる。**boardDelta と分けてあるのはテストのため** —
 * ここはDBに触らない純粋関数なので、キーの取り違えを単体で固定できる。
 *
 * note ではなく boardNote を使うのが肝。書き込み側が返す note (「#9999 は存在しません。
 * 古い一覧を見ている可能性があります」等の**警告**) と同じキーにすると、spread の順で警告が消える。
 */
export function formatBoardUpdate(d: BoardDelta, since?: string): Record<string, unknown> {
  if (!d.full)
    return {
      syncToken: d.syncToken,
      projectContextVersion: d.projectContextVersion,
      ...(d.changes?.length ? { boardChanges: d.changes } : {}),
    };
  if (!since) return { syncToken: d.syncToken, projectContextVersion: d.projectContextVersion };
  // 差分を返せなかったとき、**新しい同期トークンを渡さない。**
  // 渡すとエージェントはそれを次の sync_token に使い、「変化なし」が返って
  // 全件を一度も見ないまま古い認識のまま進む
  return {
    boardNote: `${d.note ?? "差分を返せなかった"}。sync_token を付けずに sync_board を呼び、全体を取り直すこと`,
  };
}

export function boardDelta(since?: string): BoardDelta {
  const snap = takeSnapshot();
  const base = since ? findSnapshot(since) : null;
  const head = { syncToken: snap.syncToken, projectContextVersion: snap.projectContextVersion };

  if (!since) return { ...head, full: true };
  if (!base) {
    return {
      ...head,
      full: true,
      note: `同期トークン ${since} は保持期間(60分)を過ぎたか、このプロジェクトのものではないため、最新の全件を返した`,
    };
  }

  const changes = diffBoards(base, snap);
  if (changes.length > MAX_CHANGES) {
    log("board", `diff ${since} -> ${snap.syncToken}: ${changes.length}件で上限超過、全件に切り替え`);
    return {
      ...head,
      full: true,
      note: `前回から${changes.length}件変わっており差分が大きいため、最新の全件を返した`,
    };
  }
  return { ...head, since, changes };
}
