import { getProjectContext, listSummaryCards, listTasks } from "./db.js";
import { currentProjectId } from "./store.js";
import { log } from "./log.js";

// #150: MCP経由のエージェント向けに「ボードの状況スナップショット + 状況ID」を配る。
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

/** 状況IDを保つ上限時間。これを過ぎたスナップショットは捨て、全件返しにフォールバックする */
const TTL_MS = 60 * 60 * 1000;
/** 1プロジェクトあたりの保持数。エージェントが何本も繋いでいても足りる程度の上限 */
const MAX_SNAPSHOTS = 32;
/** 差分がこれを超えたら、差分を読ませるより全件を渡したほうが速い (promptState の MAX_EVENTS と同じ考え) */
const MAX_CHANGES = 40;

/** 差分に出す分だけを持つ。context本文のような重いものは持たない (版だけ見る) */
export interface TaskFacts {
  title: string;
  status: string;
  summary: string | null;
  due: string | null;
  blockedBy: number[] | null;
  rejected: boolean;
  contextVersion: number;
}

export interface BoardSnapshot {
  stateId: string;
  takenAt: number;
  tasks: Map<number, TaskFacts>;
  cards: Map<number, string>;
  projectContext: string;
}

// プロセス起動ごとに変わる接頭辞。再起動で連番が振り直されるため、これが無いと
// **前のプロセスが配った状況IDが偶然一致して、無関係なスナップショットからの差分を返す**
const RUN = Math.random().toString(36).slice(2, 8);
let counter = 0;

const snapshots = new Map<number, BoardSnapshot[]>();

function cardIndex(title: string, elements: string[]): string {
  return `${title} :: ${elements.join(" / ")}`;
}

/** いまのボードを写し取る。DBに触るのはここだけで、差分計算(diffBoards)は純粋関数にしてある */
export function captureBoard(): Omit<BoardSnapshot, "stateId" | "takenAt"> {
  const tasks = new Map<number, TaskFacts>(
    listTasks().map((t) => [
      t.id,
      {
        title: t.title,
        status: t.status,
        summary: t.summary ?? null,
        due: t.due,
        blockedBy: t.blockedBy,
        rejected: t.rejected,
        contextVersion: t.contextVersion,
      },
    ])
  );
  const cards = new Map<number, string>(
    listSummaryCards().map((c) => [c.id, cardIndex(c.title, c.elements.map((e) => e.text))])
  );
  return { tasks, cards, projectContext: getProjectContext() ?? "" };
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
  if (prev.rejected !== cur.rejected) out.push(cur.rejected ? "却下された" : "却下を取り消した");
  if (prev.due !== cur.due) out.push(`期限: ${prev.due ?? "なし"} -> ${cur.due ?? "なし"}`);
  if (!sameDeps(prev.blockedBy, cur.blockedBy))
    out.push(`依存: [${(prev.blockedBy ?? []).join(",")}] -> [${(cur.blockedBy ?? []).join(",")}]`);
  if (prev.summary !== cur.summary) out.push(`現況: ${cur.summary ?? "(消去)"}`);
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
  prev: Pick<BoardSnapshot, "tasks" | "cards" | "projectContext">,
  cur: Pick<BoardSnapshot, "tasks" | "cards" | "projectContext">
): string[] {
  const changes: string[] = [];

  for (const [id, t] of cur.tasks) {
    const before = prev.tasks.get(id);
    if (!before) {
      // 追加はIDだけでは何か分からないので内容ごと載せる
      changes.push(
        `+ #${id}「${t.title}」が追加された (${t.status}${t.due ? `, 期限 ${t.due}` : ""}${t.rejected ? ", 却下" : ""})`
      );
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

  for (const [id, idx] of cur.cards) {
    const before = prev.cards.get(id);
    if (!before) changes.push(`+ 要約カード#${id} が追加された (${idx})`);
    else if (before !== idx) changes.push(`~ 要約カード#${id} が更新された (${idx})`);
  }
  for (const [id, idx] of prev.cards) {
    if (!cur.cards.has(id)) changes.push(`- 要約カード#${id} が統合され消滅した (${idx})`);
  }

  if (prev.projectContext !== cur.projectContext) changes.push("プロジェクトの前提情報が更新された");

  return changes;
}

/** いまのボードを写し取り、状況IDを払い出して保持する */
export function takeSnapshot(): BoardSnapshot {
  const projectId = currentProjectId();
  const snap: BoardSnapshot = {
    stateId: `p${projectId}-${RUN}-${++counter}`,
    takenAt: Date.now(),
    ...captureBoard(),
  };
  const list = snapshots.get(projectId) ?? [];
  list.push(snap);
  // TTL切れと溢れた分を捨てる。失効は正常系なので、消えたこと自体は問題にならない
  const alive = list.filter((s) => Date.now() - s.takenAt <= TTL_MS).slice(-MAX_SNAPSHOTS);
  snapshots.set(projectId, alive);
  return snap;
}

/** 状況IDからスナップショットを引く。無ければ null (呼び出し側は全件返しにフォールバックする) */
export function findSnapshot(stateId: string): BoardSnapshot | null {
  const list = snapshots.get(currentProjectId()) ?? [];
  const found = list.find((s) => s.stateId === stateId);
  if (!found) return null;
  if (Date.now() - found.takenAt > TTL_MS) return null;
  return found;
}

/** テスト用。プロセス内に溜まった状況IDを捨てる */
export function resetSnapshots(): void {
  snapshots.clear();
}

export interface BoardDelta {
  stateId: string;
  /** 差分を返したときだけ入る。渡された状況ID */
  since?: string;
  changes?: string[];
  full?: boolean;
  note?: string;
}

/**
 * MCPの応答に載せるボード状況を組み立てる。
 *
 * - `since` が無い / メモリに無い / 失効している → **全件を返す** (エラーにしない)。
 *   失効は正常系で、エラーを返すとLLMがリトライを考え始める
 * - 見つかれば、そこからの差分だけ返す
 * - 差分が MAX_CHANGES を超えたら、読ませる負担が上回るので全件に切り替える
 */
export function boardDelta(since?: string): BoardDelta {
  const snap = takeSnapshot();
  const base = since ? findSnapshot(since) : null;

  if (!since) return { stateId: snap.stateId, full: true };
  if (!base) {
    return {
      stateId: snap.stateId,
      full: true,
      note: `状況ID ${since} は保持期間(60分)を過ぎたか、このプロジェクトのものではないため、最新の全件を返した`,
    };
  }

  const changes = diffBoards(base, snap);
  if (changes.length > MAX_CHANGES) {
    log("board", `diff ${since} -> ${snap.stateId}: ${changes.length}件で上限超過、全件に切り替え`);
    return {
      stateId: snap.stateId,
      full: true,
      note: `前回から${changes.length}件変わっており差分が大きいため、最新の全件を返した`,
    };
  }
  return { stateId: snap.stateId, since, changes };
}
