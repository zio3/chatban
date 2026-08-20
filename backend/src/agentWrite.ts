import {
  createTask,
  DONE_GATE_RULE,
  DUE_FORMAT_RULE,
  getTask,
  isDueDate,
  restoreTask,
  updateTask,
  updateTasks,
  type TaskPatch,
} from "./db.js";
import { cleanAgentText } from "./text.js";
import type { TaskStatus } from "./types.js";

// #114: エージェント(内蔵チャット / MCP越しの外部エージェント)からのカード書き込みは、
// 必ずこのモジュールを通す。
//
// なぜ集約したか: ガードをチャット側にだけ書いていたため、MCP経由では素通りしていた。
// 実際に「AIが自主的にDoneへ移動した」事故が起きている(#114)。同じズレは3回起きた —
// #92(MCPのreasonに説明が無く進捗を書き込んで汚した) / #108(create_cardsにdueが無く2回叩いた) /
// #114(done封鎖が無くDoneへ直行できた)。個別に直すのではなく入口を1本にする。
//
// 「ルートは共通で強制、判断基準だけプロジェクト依存」(zio方針):
// Doneへ至る経路はどのプロジェクトでも1本(人間の検収UI)。プロジェクトごとに違うのは
// 「いつ検収OKを付けるか」であって、経路そのものではない。

export interface AgentTaskInput {
  title: string;
  status?: string;
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
  /** 経緯メモへの追記。版が要らない唯一の書き込み経路 (下の CONTEXT_APPEND_DESCRIPTION を参照) */
  context_append?: string;
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

/** 経緯メモへの追記。外部エージェントからの指摘 —
 * 「1行足すだけでも全文置換。トークンも時間も食いますし、送り直す過程で私が要約してしまう危険が
 *  あります(長いので無意識に削る)。実際 CB8 は一度書き直したときに短くなりました」。
 *
 * #112 で版を入れたとき「読む→マージ→全文で書き戻す」しか想定していなかったが、
 * 追記は他人の追記を消さないので、そもそも版で守る必要がない操作だった。
 * 版が要る理由は「読まずに書くと消える」ことで、消さない書き方には理由が無い。 */
export const CONTEXT_APPEND_DESCRIPTION =
  "経緯メモの末尾に追記する。既存を読む必要も context_version も要らない(足すだけなので他の人の追記を消さない)。進捗・決定事項・検収エビデンスを1件足すときはこちらを使う。全文を整理したい・過去の記述を書き換えたいときだけ context + context_version の上書きを使う。" +
  // 実例: 経緯メモを【実測】【原因】【対処】と節で構造化したため、末尾に足すと節の外に付いてしまい、
  // 追記の口があるのに一度も使えなかった(5回の更新で6000字以上を送り直していた)。
  // 「追記を使え」という指示はあったが、使える形で書き始める方法が無かった
  "追記で積む前提なら、経緯メモの末尾に「## 経過」を作っておく。前半(背景・決めたこと)は固定、経過だけが伸びる形なら追記が効く — 節で細かく構造化すると追記が節の外に付き、毎回全文を書き直すことになる";

/** #153: 期限の形が違うとき。**その行ごと落とさず、due だけ捨てて名指しで言う。**
 * 他のフィールド (タイトル・経緯メモ) は書けているのに全体を失敗にすると、エージェントは
 * 同じ内容を送り直すことになる (#120/#108 と同じ理由)。かといって黙って捨てると
 * 「期限を入れたつもり」が残るので、必ず報告する */
const BAD_DUE_NOTE = `期限の形式が違うため、その指定だけ適用していません (他の項目は保存しました)。${DUE_FORMAT_RULE}。その旨をユーザーにも伝えてください`;

const NOT_FOUND_NOTE =
  "は存在しません。IDを確認してください (古い一覧を見ている可能性があります)。この指定は何も適用していません。その旨をユーザーにも伝えてください";

const CONFLICT_NOTE =
  "経緯メモの版が合わないため、この行の更新は一切適用していません (他のフィールドも保存されていません)。conflicts の context に自分の追記をマージし、その contextVersion を添えて再実行してください。上書きに失敗したことをユーザーにも伝えてください";

// 「できません」だけ返すと、エージェントは何度か言い換えて再挑戦する。
// なぜ通らないのか(経路)と、代わりに何をしたのかを両方言う
const DONE_NOTE =
  `done は指定できないので review に置きました。${DONE_GATE_RULE}。` +
  "実装や作業が終わったという意味だと解釈しています。ユーザーには「reviewに置いたので検収してください」と伝えてください";

/** 渡された due を「保存してよい値」に均す。#153: 形が違うものは捨てる (undefined を返す) */
function acceptableDue(due: string | null | undefined): { due?: string | null; bad: boolean } {
  if (due === undefined) return { bad: false };
  if (due === null || due === "") return { due: null, bad: false };
  return isDueDate(due) ? { due, bad: false } : { bad: true };
}

export function createTasksAsAgent(cards: AgentTaskInput[]): {
  created: unknown[];
  note?: string;
  /** 期限の形が違って捨てたもの (タイトルで返す。作成時点ではIDを知らせても意味が薄い) */
  badDue?: string[];
} {
  let anyCoerced = false;
  const badDue: string[] = [];
  const created = cards.map((t) => {
    const { status, coerced } = coerceStatus(t.status);
    if (coerced) anyCoerced = true;
    const title = cleanAgentText(t.title);
    const task = createTask(title, status ?? "todo");
    const due = acceptableDue(t.due);
    if (due.bad) badDue.push(title);
    const patch: TaskPatch = {
      ...(t.context !== undefined ? { context: cleanAgentText(t.context) } : {}),
      ...(t.summary !== undefined ? { summary: cleanAgentText(t.summary) } : {}),
      ...(due.due !== undefined ? { due: due.due } : {}),
      ...(t.blocked_by !== undefined ? { blockedBy: t.blocked_by } : {}),
    };
    return Object.keys(patch).length > 0 ? updateTask(task.id, patch) : task;
  });
  // 2つ重なったら両方言う。片方だけ返すと、もう片方は起きなかったことになる
  const notes = [anyCoerced ? DONE_NOTE : "", badDue.length > 0 ? BAD_DUE_NOTE : ""].filter(Boolean);
  return {
    created,
    ...(notes.length > 0 ? { note: notes.join(" / ") } : {}),
    ...(badDue.length > 0 ? { badDue } : {}),
  };
}

/** #161: 復元の契約。**チャットとMCPで結果の読み方を揃えるために、ここに集約する。**
 *
 * 前の周までは各入口が restoreTask を直接呼んでいて、MCPは「1件でも戻せなければ ok:false」、
 * チャットは「常に ok:true」になっていた (Codexレビュー指摘)。**ok だけを見るエージェントは
 * 入口によって失敗を見落とす** — 同じ道具の名前で結果の意味が違うのが一番たちが悪い。
 *
 * 重複IDも先に落とす。[N, N] を渡すと1回目は成功・2回目は0件更新になり、
 * **同じNが restored と notRestored の両方に載って ok:false** になっていた
 * (approveChecked が同じ理由で先に dedupe しているのに合わせる)。
 *
 * 復元は検収の印を落とすので、**それを note で言う**。境界はコードで守られているが、
 * 戻したエージェントが「検収状態が変わった」ことを知る手段が無いと、
 * 「さっき検収されていたから確定できる」という前提のまま話を進めてしまう */
export function restoreTasksAsAgent(ids: number[]): {
  ok: boolean;
  /** 戻したものの要点だけ。**Task をそのまま載せない** — `context` (1件1,000字超) が
   * 応答に乗り、チャットではそれが次のLLM入力とtraceへ再投入される (#108 と同じ無駄)。
   * ここで絞っておけば入口ごとに要約する必要がなく、経路差も生まれない (Codexレビュー指摘) */
  restored: { id: number; title: string; status: string }[];
  notRestored?: number[];
  note?: string;
} {
  const unique = [...new Set(ids)];
  const results = unique.map((id) => ({ id, task: restoreTask(id) }));
  const restored = results
    .map((r) => r.task)
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));
  const notRestored = results.filter((r) => !r.task).map((r) => r.id);
  const notes = [
    restored.length > 0 ? RESTORE_CHECKED_NOTE : "",
    notRestored.length > 0
      ? `#${notRestored.join(", #")} はゴミ箱に無いので戻していません (既にボードにあるか、存在しないIDです)。その旨をユーザーにも伝えてください`
      : "",
  ].filter(Boolean);
  return {
    ok: notRestored.length === 0,
    restored,
    ...(notRestored.length > 0 ? { notRestored } : {}),
    ...(notes.length > 0 ? { note: notes.join(" / ") } : {}),
  };
}

/** 復元したときに必ず言うこと。ツールの説明 (RESTORE_DESCRIPTION) と応答の両方で使う */
export const RESTORE_CHECKED_NOTE =
  "戻したカードの検収の印は外れています (ゴミ箱を通る間に人間の確認は挟まっていないため)。Doneへ確定するには、人間がもう一度ボードで検収チェックを付ける必要があります";

export const RESTORE_DESCRIPTION = `ゴミ箱に入れたカードを元に戻す(複数可)。**戻すと検収の印は外れる** — ${DONE_GATE_RULE}。戻せなかったIDは notRestored で名指しで返る`;

export function updateTasksAsAgent(updates: AgentTaskUpdate[]): {
  ok: boolean;
  /** #123: 全件通ったのか一部だけかを、配列を数えさせずに言う。
   * ok だけだと「全部失敗」と「一部だけ失敗」が同じ false になる */
  status: "ok" | "partial" | "failed";
  updated: unknown[];
  coerced: number[];
  conflicts?: ContextConflict[];
  notFound?: number[];
  /** #153: 期限の形が違って、その指定だけ捨てたカードID */
  badDue?: number[];
  note?: string;
} {
  const coerced: number[] = [];
  const conflicts: ContextConflict[] = [];
  const notFound: number[] = [];
  const badDue: number[] = [];

  const patches = updates.map((u) => {
    // #87: 「差分だけ送る」モデルを前提にしない。全フィールドをエコーバックするモデル
    // (実測: gpt-5.6-terra) だと、変更していない値まで patch に載って既存値を壊す。
    // 現在値と突き合わせ、実際に変わったフィールドだけを通す
    const cur = getTask(u.id);
    // #123: 存在しないIDは名指しで返す。以前は updated に null が混ざるだけで、
    // ok:true / updated:[null, {...}] を見て「2件とも書けた」と読めてしまった。
    // エラーで全体を落とさないのは #120/#108 と同じ理由 (古い一覧を元に呼んだだけで
    // 全部失敗するとLLMには扱いにくい) — 適用できたものは適用し、できなかったものを報告する
    if (!cur) {
      notFound.push(u.id);
      return null;
    }
    const changed = <T>(incoming: T | undefined, current: T) => incoming !== undefined && incoming !== current;

    // done → review の倒し込みも、報告に積むのは行の適用が決まってから (下の contextStale の後)。
    // badDue と同じ形で、版が合わずに行ごと未適用のときに「reviewに置きました」と返っていた
    // (Codexレビュー指摘: 直した badDue の隣に同型が残っていた)
    const { status, coerced: didCoerce } = coerceStatus(u.status);

    // #153: 形が違う due は捨てて名指しで返す ("" は解除として扱う。従来どおり)。
    // **報告に積むのは行が実際に適用されると分かってから** (下の contextStale の後)。
    // 版が合わずに行ごと未適用のときに badDue も返すと、「他の項目は保存しました」と
    // 「この行は一切適用していません」が同時に返って矛盾する (Codexレビュー指摘)
    const dueCheck = acceptableDue(u.due);
    const due = dueCheck.due;
    const blockedBy = u.blocked_by === undefined ? undefined : (u.blocked_by ?? null);
    const sameDeps =
      blockedBy !== undefined && JSON.stringify(blockedBy ?? []) === JSON.stringify(cur?.blockedBy ?? []);

    const statusChanged = changed(status, cur?.status);
    const rejectedChanged = u.rejected !== undefined && !!u.rejected !== !!cur?.rejected;

    // #112: 経緯メモは「読む→マージ→全文で書き戻す」契約なので、読んでから書くまでの間に
    // 他人(人間のUI・別セッション)が追記していると、その追記が黙って消える。
    // 版が合わないときは弾くのではなく、現在の全文と版を返して再マージさせる
    // (#114のdone→reviewと同じ「拒否ではなく情報を返す」形。LLMは読み直して考え直せる)
    // 追記は「既存の末尾に足す」だけなので版で守る必要がない。
    // 全文置換と併用されたら、置換後の全文の末尾に足す (自然な読み方。片方を黙って捨てない)
    const appended = typeof u.context_append === "string" ? cleanAgentText(u.context_append).trim() : "";
    const baseContext = u.context !== undefined ? u.context : cur?.context ?? null;
    const nextContext = appended
      ? [baseContext, appended].filter((s) => s && s.trim() !== "").join("\n\n")
      : u.context;

    const contextIncoming = changed(nextContext, cur?.context ?? null);
    // 版を確認するのは全文置換のときだけ。追記のみなら読んでいなくてよい
    const contextStale = u.context !== undefined && contextIncoming && u.context_version !== cur?.contextVersion;
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

    // ここまで来た行は適用される。**適用されたことが前提の報告はこの位置で積む** (#153)
    if (dueCheck.bad) badDue.push(u.id);
    if (didCoerce) coerced.push(u.id);

    return {
      id: u.id,
      patch: {
        ...(changed(cleanAgentText(u.title), cur?.title) ? { title: cleanAgentText(u.title) } : {}),
        ...(statusChanged ? { status: status as TaskStatus } : {}),
        ...(changed(due, cur?.due ?? null) ? { due } : {}),
        ...(blockedBy !== undefined && !sameDeps ? { blockedBy } : {}),
        ...(contextIncoming && !contextStale ? { context: cleanAgentText(nextContext) } : {}),
        ...(changed(cleanAgentText(u.summary), cur?.summary ?? null) ? { summary: cleanAgentText(u.summary) } : {}),
        ...(rejectedChanged ? { rejected: !!u.rejected } : {}),
      } as TaskPatch,
    };
  });

  // 一括更新は db 層でまとめて処理 (完了遷移の通知=要約再生成が1回で済む #60)
  const updated = updateTasks(patches.filter((p): p is NonNullable<typeof p> => p !== null));
  const notes = [
    // 件数を先に言う。「何件通って何件通らなかったか」を数えさせない
    ...(conflicts.length + notFound.length > 0
      ? [`${updates.length}件のうち${updates.length - conflicts.length - notFound.length}件を適用しました`]
      : []),
    ...(coerced.length > 0 ? [`#${coerced.join(", #")} は${DONE_NOTE}`] : []),
    ...(conflicts.length > 0 ? [`#${conflicts.map((c) => c.id).join(", #")} は${CONFLICT_NOTE}`] : []),
    ...(notFound.length > 0 ? [`#${notFound.join(", #")} ${NOT_FOUND_NOTE}`] : []),
    // #153: 期限だけ捨てた行。**rejected には数えない** — 他の項目は保存できているので、
    // ここで ok:false にすると「1件も書けなかった」と読まれて全部送り直される
    ...(badDue.length > 0 ? [`#${badDue.join(", #")} は${BAD_DUE_NOTE}`] : []),
  ];
  // #124: 適用できた行だけが入る。undefined/null は混ざらない (内部事情を漏らさない)
  const applied = updated.filter((t): t is NonNullable<typeof t> => t != null);
  const rejected = conflicts.length + notFound.length;
  return {
    // 部分成功を ok:true と返すと、多くのエージェントはここで分岐して先へ進む。
    // 1件でも適用できなかったなら false にして、中身を読ませる (#120/#123)
    ok: rejected === 0,
    status: rejected === 0 ? "ok" : applied.length > 0 ? "partial" : "failed",
    updated: applied,
    coerced,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(notFound.length > 0 ? { notFound } : {}),
    ...(badDue.length > 0 ? { badDue } : {}),
    ...(notes.length > 0 ? { note: notes.join(" / ") } : {}),
  };
}
