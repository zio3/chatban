import { createTask, getTask, updateTask, updateTasks, type TaskPatch } from "./db.js";
import type { TaskStatus } from "./types.js";

// #114: エージェント(内蔵チャット / MCP越しの外部エージェント)からのタスク書き込みは、
// 必ずこのモジュールを通す。
//
// なぜ集約したか: ガードをチャット側にだけ書いていたため、MCP経由では素通りしていた。
// 実際に「AIが自主的にDoneへ移動した」事故が起きている(#114)。同じズレは3回起きた —
// #92(MCPのreasonに説明が無く進捗を書き込んで汚した) / #108(create_tasksにdueが無く2回叩いた) /
// #114(done封鎖が無くDoneへ直行できた)。個別に直すのではなく入口を1本にする。
//
// 「ルートは共通で強制、判断基準だけプロジェクト依存」(zio方針):
// Doneへ至る経路はどのプロジェクトでも1本(人間の検収UI)。プロジェクトごとに違うのは
// 「いつ検収OKを付けるか」であって、経路そのものではない。

/** 発言者ラベルが本文として書き写されたときの保険 (#95)。プロンプトは漏れるがツール契約は漏れない。
 * 先頭だけでなく行頭のどこに出ても落とす (経緯メモに段落として混ざる例があった) */
function stripSpeakerLabel<T extends string | undefined | null>(v: T): T {
  if (typeof v !== "string") return v;
  return v.replace(/^\s*\[発言者:[^\]]*\]\s*/gm, "") as T;
}

export interface AgentTaskInput {
  title: string;
  status?: string;
  assignee?: string | null;
  assign_reason?: string;
  context?: string;
  summary?: string;
  due?: string | null;
  blocked_by?: number[] | null;
}

export interface AgentTaskUpdate extends Partial<AgentTaskInput> {
  id: number;
  rejected?: boolean;
  /** #112: 読んだ時点の経緯メモの版。context を書き換えるときは必須 */
  context_version?: number;
}

/** 経緯メモの更新が古い版に基づいていた場合。エージェントに再マージさせるため現在値を返す */
export interface ContextConflict {
  id: number;
  contextVersion: number;
  context: string | null;
  note: string;
}

/** doneはエージェントから設定できない。唯一の扉は人間の検収UI (#69) */
function coerceStatus(status: string | undefined): { status?: TaskStatus; coerced: boolean } {
  if (status === undefined) return { coerced: false };
  if (status === "done") return { status: "review", coerced: true };
  return { status: status as TaskStatus, coerced: false };
}

const CONFLICT_NOTE =
  "経緯メモの版が合わないため、この行の更新は一切適用していません (他のフィールドも保存されていません)。conflicts の context に自分の追記をマージし、その contextVersion を添えて再実行してください。上書きに失敗したことをユーザーにも伝えてください";

const DONE_NOTE =
  "done を指定されましたが review に置きました。done への確定はボードの検収チェック(人間)のみが行えます。その旨をユーザーに伝えてください";

export function createTasksAsAgent(tasks: AgentTaskInput[]): { created: unknown[]; note?: string } {
  let anyCoerced = false;
  const created = tasks.map((t) => {
    const { status, coerced } = coerceStatus(t.status);
    if (coerced) anyCoerced = true;
    const task = createTask(
      stripSpeakerLabel(t.title),
      status ?? "todo",
      t.assignee ?? null,
      stripSpeakerLabel(t.assign_reason) ?? null
    );
    const patch: TaskPatch = {
      ...(t.context !== undefined ? { context: stripSpeakerLabel(t.context) } : {}),
      ...(t.summary !== undefined ? { summary: t.summary } : {}),
      ...(t.due !== undefined ? { due: t.due } : {}),
      ...(t.blocked_by !== undefined ? { blockedBy: t.blocked_by } : {}),
    };
    return Object.keys(patch).length > 0 ? updateTask(task.id, patch) : task;
  });
  return { created, ...(anyCoerced ? { note: DONE_NOTE } : {}) };
}

export function updateTasksAsAgent(updates: AgentTaskUpdate[]): {
  ok: boolean;
  updated: unknown[];
  coerced: number[];
  conflicts?: ContextConflict[];
  note?: string;
} {
  const coerced: number[] = [];
  const conflicts: ContextConflict[] = [];

  const patches = updates.map((u) => {
    // #87: 「差分だけ送る」モデルを前提にしない。全フィールドをエコーバックするモデル
    // (実測: gpt-5.6-terra) だと、変更していない値まで patch に載って既存値を壊す。
    // 現在値と突き合わせ、実際に変わったフィールドだけを通す
    const cur = getTask(u.id);
    const changed = <T>(incoming: T | undefined, current: T) => incoming !== undefined && incoming !== current;

    const { status, coerced: didCoerce } = coerceStatus(u.status);
    if (didCoerce) coerced.push(u.id);

    const assignee = u.assignee === "" ? null : u.assignee; // 空文字は「未割り当て」の意図とみなす
    const due = u.due === "" ? null : u.due;
    const blockedBy = u.blocked_by === undefined ? undefined : (u.blocked_by ?? null);
    const sameDeps =
      blockedBy !== undefined && JSON.stringify(blockedBy ?? []) === JSON.stringify(cur?.blockedBy ?? []);

    const statusChanged = changed(status, cur?.status);
    const assigneeChanged = changed(assignee, cur?.assignee ?? null);
    const rejectedChanged = u.rejected !== undefined && !!u.rejected !== !!cur?.rejected;

    // reason上書きガード: 担当・状態の変更を伴わない更新(due/依存のみ等)で
    // reasonを添えられると既存の割り振り理由が破壊されるため無視する (実事故2件の再発防止)。
    // 空文字のreasonは常に拒否する — 理由を「消す」操作に意味はない
    const keepReason =
      typeof u.assign_reason === "string" &&
      u.assign_reason.trim() !== "" &&
      u.assign_reason !== cur?.assignReason &&
      (assigneeChanged || statusChanged || rejectedChanged);

    // #112: 経緯メモは「読む→マージ→全文で書き戻す」契約なので、読んでから書くまでの間に
    // 他人(人間のUI・別セッション)が追記していると、その追記が黙って消える。
    // 版が合わないときは弾くのではなく、現在の全文と版を返して再マージさせる
    // (#114のdone→reviewと同じ「拒否ではなく情報を返す」形。LLMは読み直して考え直せる)
    const contextIncoming = changed(u.context, cur?.context ?? null);
    const contextStale = contextIncoming && u.context_version !== cur?.contextVersion;
    if (contextStale) {
      conflicts.push({
        id: u.id,
        contextVersion: cur?.contextVersion ?? 1,
        context: cur?.context ?? null,
        note:
          u.context_version === undefined
            ? "経緯メモの更新には context_version が必要です。返した context に自分の追記をマージし、この contextVersion を添えて再実行してください"
            : "経緯メモが他から更新されています。返した context に自分の追記をマージし、この contextVersion を添えて再実行してください",
      });
    }

    // 版が合わなければ、その行は何も適用しない (contextだけ弾いて他を通すと、
    // updated に載ったのを見て「書けた」と読まれる。成功と失敗は排他にする #120)
    if (contextStale) return null;

    return {
      id: u.id,
      patch: {
        ...(changed(stripSpeakerLabel(u.title), cur?.title) ? { title: stripSpeakerLabel(u.title) } : {}),
        ...(statusChanged ? { status: status as TaskStatus } : {}),
        ...(assigneeChanged ? { assignee } : {}),
        ...(keepReason ? { assignReason: stripSpeakerLabel(u.assign_reason) } : {}),
        ...(changed(due, cur?.due ?? null) ? { due } : {}),
        ...(blockedBy !== undefined && !sameDeps ? { blockedBy } : {}),
        ...(contextIncoming && !contextStale ? { context: stripSpeakerLabel(u.context) } : {}),
        ...(changed(u.summary, cur?.summary ?? null) ? { summary: u.summary } : {}),
        ...(rejectedChanged ? { rejected: !!u.rejected } : {}),
      } as TaskPatch,
    };
  });

  // 一括更新は db 層でまとめて処理 (完了遷移の通知=要約再生成が1回で済む #60)
  const updated = updateTasks(patches.filter((p): p is NonNullable<typeof p> => p !== null));
  const notes = [
    ...(coerced.length > 0 ? [`#${coerced.join(", #")} は${DONE_NOTE}`] : []),
    ...(conflicts.length > 0 ? [`#${conflicts.map((c) => c.id).join(", #")} は${CONFLICT_NOTE}`] : []),
  ];
  return {
    // 部分成功を ok:true と返すと、多くのエージェントはここで分岐して先へ進む。
    // 1件でも弾いたなら false にして、中身を読ませる (#120)
    ok: conflicts.length === 0,
    updated,
    coerced,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(notes.length > 0 ? { note: notes.join(" / ") } : {}),
  };
}
