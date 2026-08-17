import { hooks } from "./hooks.js";
import { log } from "./log.js";
import { admin, currentProjectId, db, projectReadonly } from "./store.js";
import { decodeUnicodeEscapes } from "./text.js";
import type { Task, TaskStatus } from "./types.js";

// #179: 担当者・割り振りは機能ごと落とした (個人利用に特化)。
// tasks.assignee / assign_reason と members / proposals / assignment_history は
// **列・テーブルごと削除してある** (store.ts の ensureProjectSchema)。
// 読まないだけにして残すと、SQL窓口 (query_log) を広げた誰かが集計に使い、
// 廃止したはずの軸が復活する — 認証 (#180) で逃げ道を残さないのと同じ判断

// #86: スキーマ定義とファイルの置き場は store.ts が持つ。
// ここは「いまアクティブなプロジェクトのDB」に対する操作だけを書く。
// db() = プロジェクトDB / admin = 管理DB (プロジェクト一覧・アプリ設定・LLM呼び出し記録)

export function listTasks(includeArchived = false): Task[] {
  // sort未設定の既存行はid順に混ざる (COALESCEでidを暫定sortとして扱う)
  // #102: ゴミ箱(trashed_at)は常に除外。復元できる形にしただけで、見え方は削除と同じ
  const where = includeArchived ? "WHERE trashed_at IS NULL" : "WHERE archived = 0 AND trashed_at IS NULL";
  return (db().prepare(`SELECT * FROM tasks ${where} ORDER BY COALESCE(sort, id), id`).all() as any[]).map(rowToTask);
}

/** ゴミ箱の中身 (新しい順)。UIの復元導線とチャットの「戻して」で使う */
export function listTrashedTasks(): Task[] {
  return (
    db().prepare("SELECT * FROM tasks WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC, id DESC").all() as any[]
  ).map(rowToTask);
}

function rowToTask(r: any): Task {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    context: r.context ?? null,
    summary: r.summary ?? null,
    due: r.due ?? null,
    blockedBy: r.blocked_by ? JSON.parse(r.blocked_by) : null,
    rejected: !!r.rejected,
    trashedAt: r.trashed_at ?? null,
    checkedAt: r.checked_at ?? null,
    doneAt: r.done_at ?? null,
    contextVersion: r.context_version ?? 1,
    sort: r.sort ?? r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createTask(title: string, status: TaskStatus = "todo"): Task {
  // 新規作成でいきなり Done は作れない。検収は「実物を確かめた」記録なので、
  // 生まれた瞬間に確かめ終わっているものは無い (mayEnterDone と同じ理由)
  if (!isTaskStatus(status)) {
    log("api", `新規作成で未知の status=${JSON.stringify(status)} を指定されたので todo にしました: ${title}`);
    status = "todo";
  }
  if (status === "done") {
    log("api", `新規作成で status=done を指定されたので review にしました: ${title}`);
    status = "review";
  }
  const info = db().prepare("INSERT INTO tasks (title, status) VALUES (?, ?)").run(title, status);
  return getTask(Number(info.lastInsertRowid))!;
}

export function getTask(id: number): Task | undefined {
  const r = db().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  return r ? rowToTask(r) : undefined;
}

export type TaskPatch = Partial<
  Pick<Task, "title" | "status" | "sort" | "context" | "summary" | "due" | "blockedBy" | "rejected">
>;

/** Doneへ入ってよい状態か。approveChecked が通す条件そのもの。
 *
 * PR #1 で「検収APIはサーバー側で条件を確かめる」ようにしたが、条件を持っていたのは
 * approveChecked だけで、PATCH /api/tasks/:id に status:"done" を投げれば素通りしていた
 * (自動レビュー指摘)。フロントは Board.tsx の handleDragEnd で Done列へのD&Dを禁止しているが、
 * **その禁止がクライアント側にしか無い** — PR #1 で塞いだのとまったく同じ形の穴。
 *
 * そこで「検収APIだけが厳しい」のをやめ、**Doneに入れる条件そのもの**を updateTasks の
 * 不変条件にする。approveChecked が通すものはこの条件を満たすので、迂回フラグは要らない。
 * checked_at を立てられるのは REST /api/tasks/:id/checked だけ (=人間のUI操作) なので、
 * 入口がRESTでもMCPでもチャットでも「人間が検収したものしかDoneに無い」が成立する。
 *
 * 「プロンプトは漏れるが、経路が無いことは漏れない」— 契約の文言ではなくコードで持つ。
 *
 * DONE_GATE_RULE は、断ったときに返す説明。REST・チャット・MCPで同じ文言を使う —
 * 「なぜ動かなかったのか」を入口ごとに違う言葉で返すと、別のルールがあるように読める */
/** 実在する列。TypeScriptの TaskStatus は実行時には消えるので、外から来た値は必ずここで確かめる。
 * "banana" のような値がそのまま保存されると、ボードは4列でしか抽出しないのでタスクが
 * どの列にも出なくなり、詳細を開くと STATUS_LABELS[status] が undefined で画面が落ちる
 * (自動レビュー指摘)。「消えた」ように見えて実在する、が一番たちが悪い */
export const TASK_STATUSES = ["todo", "inprogress", "review", "done"] as const;
export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}

export const DONE_GATE_RULE =
  "Doneへは「Review列に置く → 人間が検収チェックを付ける → 確定」の順でしか入りません。他の列からDoneへの直送はできません";

/** #153: 期限は YYYY-MM-DD だけ。契約にはそう書いてあるが確かめていなかったので、
 * `not-a-date` がそのまま保存された (ユーザー報告)。
 *
 * **文字列としての形だけでなく、暦として在る日かも見る。**正規表現だけだと 2026-02-31 や
 * 2026-13-01 が通る。通してしまうと、カードのバッジ(dueBadge)や「期限が近い順」の判断が
 * 静かに狂う — 保存できてしまう値のほうが、弾かれる値より始末が悪い。
 *
 * isTaskStatus と同じ置き方 (実行時に外から来た値を確かめる純粋関数)。DBもHTTPも要らないので
 * ユニットで押さえられるし、REST・チャット・MCPのどこから来ても同じ判定になる */
export function isDueDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // UTCで組み立てる。ローカル時刻だとタイムゾーン次第で日付がずれ、判定が環境依存になる
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export const DUE_FORMAT_RULE = "期限は YYYY-MM-DD (実在する日付) で渡してください。解除は null です";

/** Doneへ確定して要約カードに畳まれたか。
 *
 * archived は Task 型に出していない (getTask はアーカイブ済みも返すが、UIは要約カード経由で読む)。
 * 「確定してよいか」「消してよいか」の判定は隠れている列も見る必要があるので、ここに1本だけ置く */
export function isArchived(id: number): boolean {
  return !!(db().prepare("SELECT archived FROM tasks WHERE id = ?").get(id) as { archived: number } | undefined)
    ?.archived;
}

export function mayEnterDone(cur: Pick<Task, "status" | "checkedAt" | "trashedAt">): boolean {
  return cur.status === "review" && !!cur.checkedAt && !cur.trashedAt;
}

/** 複数タスクの一括更新 (#60)。完了遷移はまとめて1回だけ通知する (要約再生成のバッチ化)。
 * 単一更新もこの関数の長さ1ケースとして扱う — Doneへ入るルートはここ1本 */
export function updateTasks(patches: { id: number; patch: TaskPatch }[]): (Task | undefined)[] {
  const completed: number[] = [];
  const reopened: number[] = [];
  const results = patches.map(({ id, patch }) => {
    const cur = getTask(id);
    if (!cur) return undefined;
    // 未知の列は無視する (その行の他の項目は保存する)。REST入口でも弾いているが、
    // ここが最後の砦 — 入口が増えたときに片方だけ直る形にしない
    if (patch.status !== undefined && !isTaskStatus(patch.status)) {
      log("api", `#${id} に未知の status=${JSON.stringify(patch.status)} が来たので無視しました`);
      const { status: _ignored, ...rest } = patch;
      patch = rest; // キーごと落とす (status: undefined を残すと spread で上書きされて消える)
    }
    let next = { ...cur, ...patch };
    // Doneへ入れるのは検収を通ったものだけ。条件を満たさない遷移は status だけ元に戻す
    // (行ごと捨てると、同じ patch に入っている summary や context まで消える)
    if (cur.status !== "done" && next.status === "done" && !mayEnterDone(cur)) {
      log("api", `#${id} をDoneへ動かす指定を拒否しました (いまは ${cur.status}${cur.checkedAt ? "" : "・検収チェックなし"})`);
      next = { ...next, status: cur.status };
    }
    // #112: 経緯メモが実際に変わったときだけ版を上げる。
    // 他の列の更新で上げてしまうと、context を書いている側が無関係な変更で弾かれる
    const contextChanged = patch.context !== undefined && patch.context !== cur.context;
    // #108: 作業中の列へ戻したら検収の印は無効になる。「確かめた」のは前の状態に対してなので、
    // 作り直しているものに印が残っていると、次の検収で「もう確認済み」と誤読される。
    // review では消さない (検収待ちの列で印を付けてから一括確定するので、印は進捗そのもの)
    const backToWork = next.status === "todo" || next.status === "inprogress";
    // Doneから出るときも消す。差し戻しは「確定を取り消した」ということなので、
    // 前の検収の印をそのまま次の確定の根拠にはできない。
    //
    // approveChecked が checked_at を「人が確かめた唯一の証拠」として使い始めたことで、
    // ここが実際に踏める穴になった: Done→Review に戻すと印が残り、確認し直さずに
    // もう一度Doneへ通せてしまう (以前の approve は checked_at を見ていなかったので無害だった)。
    // 印を消せば、差し戻したものは必ずもう一度チェックを付け直すことになる
    const leavingDone = cur.status === "done" && next.status !== "done";
    db().prepare(
      "UPDATE tasks SET title = ?, status = ?, sort = ?, context = ?, summary = ?, due = ?, blocked_by = ?, rejected = ?, context_version = context_version + ?, checked_at = ?, done_at = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(
      next.title,
      next.status,
      next.sort,
      next.context,
      next.summary,
      next.due,
      next.blockedBy?.length ? JSON.stringify(next.blockedBy) : null,
      next.rejected ? 1 : 0,
      contextChanged ? 1 : 0,
      backToWork || leavingDone ? null : (cur.checkedAt ?? null),
      // 完了に入った瞬間だけ打刻する。以降の編集では動かさない (updated_at と違い「終わった日」)
      next.status === "done" ? (cur.doneAt ?? new Date().toLocaleString("sv-SE")) : null,
      id
    );
    if (cur.status !== "done" && next.status === "done") completed.push(id);
    else if (cur.status === "done" && next.status !== "done") reopened.push(id);
    return getTask(id);
  });
  // 完了/再開の遷移をアプリ層に通知 (Doneアーカイブ+要約の再生成トリガー)
  if (completed.length > 0) hooks.tasksCompleted?.(completed);
  for (const id of reopened) hooks.taskReopened?.(id);
  return results;
}

/** 検収の確定 (Review + 検収済み → Done)。Doneへ至る唯一の扉なので、条件はサーバーが持つ。
 *
 * 以前は POST /api/tasks/approve が ids をそのまま done にしていて、条件の判定は
 * フロント(App.tsx の commitApproved が status==="review" && checkedAt で絞る)にしか無かった。
 * 実測で、Todo のタスクも・Review未検収も・**ゴミ箱の中のタスクまで** done になった。
 *
 * docs/security.md には「Doneへ至る経路は人間のUI操作ただ1本」と書いてあるが、
 * その1本が無条件だった。エージェントはこのAPIを持たないので「AIは通れない」は
 * 守られていたものの、「人間が実物で確かめたものだけがDoneにある」は守られていない。
 * UIが正しく振る舞うことに依存した不変条件は、画面の競合(古い一覧のまま確定を送る)でも破れる。
 *
 * better-sqlite3 は同期APIで、Nodeのイベントループ上では判定と更新の間に他のリクエストが
 * 割り込まない。そのうえで、通らなかったものは理由つきで返す (黙って落とすと
 * 「押したのに動かない」になる) */
export function approveChecked(ids: number[]): {
  updated: (Task | undefined)[];
  skipped: { id: number; reason: string }[];
} {
  const skipped: { id: number; reason: string }[] = [];
  const eligible: number[] = [];
  // 同じIDが2回入っていたら1回として扱う。判定も更新も2度走り、updated に同じタスクが
  // 2件載って「2件確定しました」に見えていた (#157)。押した数と通った数を突き合わせられる
  // ようにしてある (#120/#123) のに、その数字自体が水増しされては意味がない
  ids = [...new Set(ids)];
  for (const id of ids) {
    const t = getTask(id);
    if (!t) skipped.push({ id, reason: "存在しません" });
    else if (t.trashedAt) skipped.push({ id, reason: "ゴミ箱にあります" });
    else if (isArchived(id)) skipped.push({ id, reason: "すでにDoneへ確定してアーカイブ済みです" });
    else if (t.status !== "review") skipped.push({ id, reason: `Review列にありません (いまは ${t.status})` });
    else if (!t.checkedAt) skipped.push({ id, reason: "検収チェックが付いていません" });
    else eligible.push(id);
  }
  const updated = eligible.length > 0 ? updateTasks(eligible.map((id) => ({ id, patch: { status: "done" as const } }))) : [];
  return { updated, skipped };
}

export function updateTask(id: number, patch: TaskPatch): Task | undefined {
  return updateTasks([{ id, patch }])[0];
}

/** #102: 削除はゴミ箱行き (論理削除)。
 * 自然言語UIでは解釈ミスが必ず起きる。「消せます?」が delete_tasks を呼んで実データが消えた事故を受け、
 * 「間違えないようにする」のではなく「間違えても取り返しがつく」形に変えた。
 * プロンプトの確認ルールは漏れるが、消えていないという事実は漏れない (#69 done封鎖と同じ考え方) */
export function trashTask(id: number): boolean {
  return (
    db()
      .prepare(
        // アーカイブ済み (Doneへ確定して要約カードに畳まれたもの) は対象外。
        // 要約カードの task_ids は更新されないので、消すとカードに存在しないIDが残り、
        // 開くと404になる — 検収済み成果の監査元が壊れる (自動レビュー指摘)。
        // ボードから見えないタスクをチャット/MCPがIDで名指しできてしまうのが入口だった
        //
        // #161: 検収の印はここでは触らない。落とすのは復元のとき (restoreTask を見る)
        "UPDATE tasks SET trashed_at = datetime('now', 'localtime') WHERE id = ? AND trashed_at IS NULL AND archived = 0"
      )
      .run(id).changes > 0
  );
}

/** #161: **戻すときに検収の印を落とす。**
 *
 * trashed_at を付け外しするだけだったので、「検収済み → ゴミ箱 → 復元」で
 * **古い checked_at が生き返り**、人間の確認を一度も挟まずに mayEnterDone が再び true になった。
 * delete_tasks / restore_tasks は **AIが呼べるMCPツール**なので、REST専用にしてある setChecked を
 * 経路として迂回できていた (「プロンプトは漏れるが、経路が無いことは漏れない」に反する)。
 * updateTasks が backToWork / leavingDone で印を消しているのと同じ理屈 —
 * 状態が変われば前の確認は根拠にならない。
 *
 * **落とすのは trash 時ではなく restore 時。**理由が2つある (Codexレビュー指摘):
 *   1. ゴミ箱の中にいる間は「検収済みだった」という事実が残る (監査の材料を消さない)。
 *      ゴミ箱にある限り mayEnterDone は trashedAt を見て false なので、残っていても危険はない
 *   2. **この変更より前からゴミ箱にある行にも効く。**trash 時に消す形だと、既にゴミ箱で
 *      眠っている checked_at 非NULLの行は復元で古い印が復活したままになる (移行が必要になる)
 *
 * 条件に trashed_at IS NOT NULL を付けているので、ゴミ箱に無いものを restore しても印は消えない。
 *
 * **戻すのは「実際に戻したとき」だけ。**以前は changes を見ずに必ず getTask を返していたので、
 * ゴミ箱に無い生きたタスクのIDを渡しても成功として扱われ、呼び出し側が
 * 「復元しました」と報告していた (Codexレビュー指摘)。**やっていないことを報告しない** —
 * 0件更新は undefined を返し、入口側 (REST 404 / restored:false) に判断させる */
export function restoreTask(id: number): Task | undefined {
  const changed = db()
    .prepare("UPDATE tasks SET trashed_at = NULL, checked_at = NULL WHERE id = ? AND trashed_at IS NOT NULL")
    .run(id).changes;
  return changed > 0 ? getTask(id) : undefined;
}

/** 実体を消す。人間のUI操作からのみ通す (チャット・MCPからは呼ばない)。
 *
 * **ゴミ箱にあるものだけ。** id しか見ていなかったので、ボード上の生タスクのIDを
 * 直接投げると、ゴミ箱を経由せず実体が消えた (自動レビュー指摘)。
 * #102 で「間違えないようにするのではなく、間違えても取り返しがつく形にする」と決めたのに、
 * 取り返しのつかない口が条件なしで開いていた — 一段目(ゴミ箱)を通っていないものを
 * 二段目(完全削除)が受け付けるなら、二段構えの意味がない。
 *
 * 復元できる状態を必ず一度経由させる。条件はコードで持つ (UIがゴミ箱画面からしか
 * 呼ばない、に依存しない — #57/#69 と同じ形) */
export function purgeTask(id: number): boolean {
  return db().prepare("DELETE FROM tasks WHERE id = ? AND trashed_at IS NOT NULL").run(id).changes > 0;
}

export interface SummaryElement {
  text: string;
  checked: boolean;
}

export interface SummaryCard {
  id: number;
  title: string;
  elements: SummaryElement[];
  taskIds: number[];
  frozen: boolean;
  createdAt: string;
}

function rowToCard(r: any): SummaryCard {
  return {
    id: r.id,
    title: r.title,
    elements: JSON.parse(r.elements),
    taskIds: JSON.parse(r.task_ids),
    frozen: !!r.frozen,
    createdAt: r.created_at,
  };
}

export function listSummaryCards(): SummaryCard[] {
  return (db().prepare("SELECT * FROM summary_cards ORDER BY id").all() as any[]).map(rowToCard);
}

export function getSummaryCard(id: number): SummaryCard | undefined {
  const r = db().prepare("SELECT * FROM summary_cards WHERE id = ?").get(id) as any;
  return r ? rowToCard(r) : undefined;
}

// #105: 完了タスクの合流先を検収バッチごとに新規作成する。
// 以前は「frozenでない最後のカード」に合流し続けたため、整頓するまで1枚が無限に育ち、
// 直近の作業と数時間前の作業が同じカードに畳まれて解像度が落ちていた。
// 人間が「このまとまりを完了にする」と決めた単位(=検収バッチ)をそのまま粒度にする。
// 分けるのは後からできないが、統合は compact_archive と日次まとめでできる = 細かい側に倒す。
export function createSummaryCard(): SummaryCard {
  const info = db()
    .prepare("INSERT INTO summary_cards (title, elements, task_ids) VALUES (?, ?, ?)")
    .run("完了タスクの要約", "[]", "[]");
  return getSummaryCard(Number(info.lastInsertRowid))!;
}

export function assignTaskToCard(taskId: number, cardId: number) {
  db().prepare("UPDATE tasks SET archived = 1, summary_card_id = ? WHERE id = ?").run(cardId, taskId);
  const ids = new Set<number>(JSON.parse((db().prepare("SELECT task_ids FROM summary_cards WHERE id = ?").get(cardId) as any).task_ids));
  ids.add(taskId);
  db().prepare("UPDATE summary_cards SET task_ids = ? WHERE id = ?").run(JSON.stringify([...ids]), cardId);
}

export function detachTaskFromCard(taskId: number) {
  const r = db().prepare("SELECT summary_card_id FROM tasks WHERE id = ?").get(taskId) as any;
  const cardId = r?.summary_card_id;
  db().prepare("UPDATE tasks SET archived = 0, summary_card_id = NULL WHERE id = ?").run(taskId);
  if (cardId) {
    const card = getSummaryCard(cardId);
    if (card) {
      const ids = card.taskIds.filter((id) => id !== taskId);
      db().prepare("UPDATE summary_cards SET task_ids = ? WHERE id = ?").run(JSON.stringify(ids), cardId);
    }
  }
  return cardId as number | undefined;
}

export function tasksOfCard(cardId: number): Task[] {
  return (db().prepare("SELECT * FROM tasks WHERE summary_card_id = ? ORDER BY id").all(cardId) as any[]).map(rowToTask);
}

export function updateCardContent(cardId: number, title: string | null, elements: SummaryElement[]) {
  const cur = getSummaryCard(cardId);
  if (!cur) return;
  db().prepare("UPDATE summary_cards SET title = ?, elements = ? WHERE id = ?").run(
    title ?? cur.title,
    JSON.stringify(elements),
    cardId
  );
}

export function deleteSummaryCards(ids: number[]) {
  const stmt = db().prepare("DELETE FROM summary_cards WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

export function reassignTasksToCard(taskIds: number[], cardId: number) {
  const stmt = db().prepare("UPDATE tasks SET summary_card_id = ? WHERE id = ?");
  for (const id of taskIds) stmt.run(cardId, id);
  db().prepare("UPDATE summary_cards SET task_ids = ? WHERE id = ?").run(JSON.stringify(taskIds), cardId);
}

export function setCardFrozen(cardId: number): void {
  db().prepare("UPDATE summary_cards SET frozen = 1 WHERE id = ?").run(cardId);
}

export function getProjectContext(): string {
  const r = db().prepare("SELECT text FROM project_context WHERE id = 1").get() as { text: string } | undefined;
  return r?.text ?? "";
}

/** 前提情報の閲覧用 (#73): 最終更新日時つき。version は上書きの突き合わせに使う (#115) */
export function getProjectContextRow(): { text: string; updatedAt: string | null; version: number } {
  const r = db().prepare("SELECT text, updated_at, version FROM project_context WHERE id = 1").get() as
    | { text: string; updated_at: string; version: number }
    | undefined;
  return { text: r?.text ?? "", updatedAt: r?.updated_at ?? null, version: r?.version ?? 1 };
}

/** #115: 前提情報は全文上書き。エージェントからは版を添えないと書けない。
 * タスクの経緯メモ(#112)と同じ形だが、こちらは全員の前提でシステムプロンプトに常時載るため、
 * 読まずに書かれると運用ルールごと消える。人間のUI経路は version を省略して従来どおり上書きできる */
export function setProjectContext(rawText: string, version?: number): { ok: boolean; current?: ReturnType<typeof getProjectContextRow> } {
  // 実際にここが壊れた: project 9 の前提情報が全文 \uXXXX エスケープで保存されていて、
  // 296字が1,346字(トークンで3.2倍)に膨らみ、しかもLLMの読み取り精度も落ちていた。
  // 前提情報はシステムプロンプトに常時載るので、発言のたびに払い続けることになる
  const text = decodeUnicodeEscapes(rawText);
  const cur = getProjectContextRow();
  if (version !== undefined && version !== cur.version) return { ok: false, current: cur };
  db().prepare(
    "INSERT INTO project_context (id, text, updated_at, version) VALUES (1, ?, datetime('now', 'localtime'), ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at, version = excluded.version"
  ).run(text, cur.version + 1);
  return { ok: true };
}

// #88: 実行時設定 (管理画面から変更可能な値)。未設定ならenv/既定値にフォールバックする。
// モデル設定はプロジェクトをまたいで共通なので管理DB側 (#86)
export function getSetting(key: string): string | null {
  const r = admin.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  admin.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, value);
}

export function deleteSetting(key: string): void {
  admin.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function saveChatMessage(
  role: "user" | "assistant",
  content: string,
  trace?: unknown,
  usage?: unknown,
  taskId?: number | null
) {
  // #126 → #180: 発言者 (speaker / speaker_email) も記録していたが、個人利用に特化して
  // 「誰が言ったか」が常に持ち主ひとりになったので列ごと落とした
  db()
    .prepare("INSERT INTO chat_messages (role, content, trace, usage, task_id) VALUES (?, ?, ?, ?, ?)")
    .run(
      role,
      content,
      trace ? JSON.stringify(trace) : null,
      usage ? JSON.stringify(usage) : null,
      taskId ?? null
    );
}

/** taskId未指定=メインチャット(task_id IS NULL)、指定=そのタスク専用の会話 */
export function listChatMessages(limit = 50, taskId?: number): {
  role: "user" | "assistant";
  content: string;
  trace: unknown;
  usage: unknown;
  createdAt: string;
}[] {
  const where = taskId != null ? "WHERE task_id = ?" : "WHERE task_id IS NULL";
  const params = taskId != null ? [taskId, limit] : [limit];
  const rows = db()
    .prepare(`SELECT * FROM (SELECT * FROM chat_messages ${where} ORDER BY id DESC LIMIT ?) ORDER BY id`)
    .all(...params) as any[];
  return rows.map((r) => ({
    role: r.role,
    content: r.content,
    trace: r.trace ? JSON.parse(r.trace) : undefined,
    usage: r.usage ? JSON.parse(r.usage) : undefined,
    createdAt: r.created_at,
  }));
}

// #181: 計測系と監査ログを撤去した。ここにあったもの:
//  - recordLlmCall() — 呼び出しごとに llm_calls へトークン・単価・概算額を打刻
//  - metrics() — 📊コストタブの集計 (総計 / モデル別 / 用途別 / 直近50件)
//  - exportAll() / exportableSettings() — 📜監査タブの「全ログExport」
//  - auditLog() — 監査タブの時系列 (会話100件 + LLM呼び出し100件)
//
// **「AIが何をしたかの説明責任」はチームだから要ったもの。**個人利用では、デバッグは
// backend/logs/chatban-YYYY-MM-DD.log で足りる (リクエスト・LLM往復・ツール実行・切断が全部残る)。
// 会話ログ (chat_messages) は残っているので、「いつ何を頼んだか」は query_log で引ける

/** #93: 「直近なにをしてた?」に実データで答えるための活動ログ。
 * 生ログ全部ではなく、経緯を語るのに要る分だけを絞って返す
 * (ツールの戻り値がそのままプロンプトに乗るので、量がコストに直結する)。
 * 会話ログは含めない — 進行中の会話は履歴として既にモデルの手元にあるため */
export function recentActivity(limit = 15) {
  const tasks = (
    db()
      .prepare(
        "SELECT id, title, status, rejected, updated_at FROM tasks WHERE trashed_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?"
      )
      .all(limit) as any[]
  ).map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    ...(r.rejected ? { rejected: true } : {}),
    at: r.updated_at,
  }));
  return { updatedTasks: tasks };
}

// #91: 並べ替えはLLMが決めた順番(ID列)をそのまま受け取る。
//
// ソートキー(id/due/title…)を渡す方式も作りかけたが捨てた。キーで表現できる並びしか作れず、
// 「重要そうな順」「デモに必要な順」「関連するものをまとめて」といった、LLMを使う意味のある
// 並びが表現できないため。ツール契約も status + ids だけで済み、スキーマの固定費が小さい。
//
// 代わりにLLMが列を作る以上の事故は必ず起きるので、コード側で正規化する:
//   - 書き忘れたタスクは元の順で末尾に付ける (「並べ替えたら消えた」を作らない)
//   - 重複は最初の1回だけ
//   - 対象列に実在しないIDは無視する
// 表示設定ではなく操作なので「いまソート中」という画面の隠れ状態は生まれず、あとから手で直せる。
export function reorderTasks(
  ids: number[],
  status: TaskStatus
): { ordered: number; appended: number; ignored?: number[] } {
  // 母集団はサーバー側で決める。listTasks() が archived=0 AND trashed_at IS NULL なので、
  // アーカイブ済み・ゴミ箱は最初から対象外 — query_log の説明で読み手に教えている
  // 「生きているタスクはこの条件」と同じ母集団を、書き込み側は実装で強制する。
  // 読みは教育で守り、書きは実装で守る (zio)
  const targets = listTasks().filter((t) => t.status === status);
  const byId = new Map(targets.map((t) => [t.id, t]));
  const seen = new Set<number>();
  const ignored: number[] = [];
  const ordered: Task[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const t = byId.get(id);
    // 対象外(アーカイブ済み・ゴミ箱・別の列・存在しない)は黙って落とさず報告する。
    // エラーで弾かないのは、古い一覧を元に呼んだだけで全体が失敗するとLLMには扱いにくいため
    if (!t) {
      ignored.push(id);
      continue;
    }
    seen.add(id);
    ordered.push(t);
  }
  const appended = targets.filter((t) => !seen.has(t.id)); // 指定漏れは元の順のまま末尾へ
  const final = [...ordered, ...appended];
  const stmt = db().prepare("UPDATE tasks SET sort = ? WHERE id = ?");
  db().transaction(() => final.forEach((t, i) => stmt.run(i + 1, t.id)))();
  return { ordered: ordered.length, appended: appended.length, ...(ignored.length ? { ignored } : {}) };
}

// #103: 経緯の横断検索。LLMが表記ゆれを自分で展開して複数語を投げ、コードは総当たりするだけ。
//
// ベクトル検索を入れなかったのは、埋め込みが持つ「意味の近さ」をLLM自身が既に持っているから。
// 「DBを分ける」と「ファイル分離」が近いことを知っているのはLLMなので、そこを外部インデックスに
// 出す必要がない。LLMが語を並べ(判断)、コードが総当たりする(機械的処理) — #91の並べ替えと同じ形。
//
// アーカイブ済みも対象にする。経緯を後から辿りたい場面はDoneになった後のほうが多い。
/** #176: **絞り込みの引数は持たない。**
 *
 * 複数語をORで引くのは表記ゆれを展開するためで、それ自体は正しい。問題は本文(経緯メモ)まで
 * 見ることで、**語がかすっただけのタスクが混ざる**こと。実例 (2026-08-15): 「記事 / スクショ /
 * Zenn / 提出」で引いたら #130(ダークモードの検討) や #103(検索機能の実装) が返った —
 * どちらも context に「提出」の2文字があっただけ。候補10件を読み直すことになった。
 *
 * `titleOnly` を足しかけたが**やめた** (zio: 「その方向だったら、SQL直接書いてもらう方向を
 * 案内しようか」)。絞りたい形は「タイトルだけ」以外にもいくらでもある — 期限つきだけ、
 * review だけ、8月に触ったものだけ、その組み合わせ。引数で並べ始めると際限が無く、
 * **#91 でソートキーを渡す方式を作りかけて捨てたのと同じ形**になる。
 *
 * 絞り込みは `query_log` (読み取り専用のSQL窓口) の仕事にする。`WHERE title LIKE '%記事%'`
 * と書けば済み、**新しい安全境界も要らない** (readonly + 許可リスト #168 で既に守ってある)。
 * ANDも同じ理由で足さない (そもそも表記ゆれの展開は「どれか1つ当たればよい」ので、
 * ANDにすると展開そのものが機能しなくなる)。
 *
 * この関数は「表記ゆれを展開して当たりを見つける」までの道具と位置づける */
export function searchTasks(terms: string[], limit = 10) {
  const words = terms.map((t) => t.trim()).filter(Boolean).slice(0, 10);
  if (words.length === 0) return { hits: [] };
  const rows = db()
    .prepare(
      "SELECT id, title, status, summary, context, archived FROM tasks WHERE trashed_at IS NULL"
    )
    .all() as any[];

  const scored = rows
    .map((r) => {
      const haystack = [r.title, r.summary, r.context].filter(Boolean).join("\n");
      const lower = haystack.toLowerCase();
      const matched = words.filter((w) => lower.includes(w.toLowerCase()));
      if (matched.length === 0) return null;
      // 当たった箇所の前後だけ返す。全文を返すとトークンがそのままコストになる
      const at = lower.indexOf(matched[0].toLowerCase());
      const snippet = haystack.slice(Math.max(0, at - 70), at + 130).replace(/\s+/g, " ");
      return {
        id: r.id,
        title: r.title,
        status: r.archived ? "archived" : r.status,
        matched, // どの語で当たったか (LLMが次の語を選び直す材料になる)
        snippet,
      };
    })
    .filter(Boolean) as any[];

  // 多くの語に当たったものほど関連が強い、という素朴な順位付けで十分
  scored.sort((a, b) => b.matched.length - a.matched.length || b.id - a.id);

  // #106追補: 会話ログも同じ語で引く。UIを作らず「あんな話してたっけ?」をAIに拾わせる。
  // チャットは揮発させる方針(#72)なので常時プロンプトには載せない — 聞かれたときだけ掘る
  const chatRows = db()
    .prepare("SELECT id, role, content, task_id, created_at FROM chat_messages ORDER BY id DESC")
    .all() as any[];
  const chatHits = chatRows
    .map((r) => {
      const lower = String(r.content).toLowerCase();
      const matched = words.filter((w) => lower.includes(w.toLowerCase()));
      if (matched.length === 0) return null;
      const at = lower.indexOf(matched[0].toLowerCase());
      return {
        role: r.role,
        at: r.created_at,
        ...(r.task_id ? { taskId: r.task_id } : {}),
        matched,
        snippet: String(r.content).slice(Math.max(0, at - 60), at + 140).replace(/\s+/g, " "),
      };
    })
    .filter(Boolean)
    .slice(0, 6) as any[];

  return { hits: scored.slice(0, limit), chatHits, searched: words };
}

// #106 → #181: 料金表 (model_prices) の保存・読み出しもここにあった。単価を打刻するために
// カタログをDBへ持っていたが、打刻ごと撤去したので置き場も要らない (テーブルはDROPする)

/** #106: 記録の集計はLLMにSQLを書かせ、コードは安全性だけ守る (#91の並べ替え・#103の検索と同じ形)。
 * 集計軸を先に決め打ちすると、そこから外れた問い(「今日の午後だけ」「8/9の午前に何を話したか」)に答えられない。
 * 守り: 書き込めない接続 / SELECT・WITH のみ / 文は1つ / 機密テーブルの遮断 / 行数上限。
 * プロンプトで「SELECTだけ」と言っても漏れるが、readonly接続は漏れない */

/** #168: SQLで開放するもの (許可リスト)。
 *
 * もとは隠す側を列挙していた。トレードオフは分かって選んでいた —
 * 「公開側を列挙すると、テーブルを足したときに閉じ忘れではなく**開き忘れ**で気づけるが、
 * 逆に隠す側を列挙すると足したテーブルは黙って開く」。後者を選んでいた。
 *
 * 実際に穴が開いた: `SELECT name FROM pragma_table_list` は遮断リストに載っていないので通り、
 * settings を含む全テーブル名が読めた (中身は読めない — SQLiteは FROM にテーブル名の式を書けないので、
 * 名前を組み立てて読むことはできない)。漏れるのは存在だけだが、
 * 「閉じ忘れ」で漏れる方式である以上、次に足すテーブルでも同じことが起きる。
 *
 * 許可リストなら**新しいテーブルは黙って閉じる**。気づき方が「開き忘れ」に変わり、
 * 失敗が安全側に倒れる。
 *
 * **ツール説明の一覧はここから生成する** (chat.ts の QUERY_LOG_DESCRIPTION が
 * `引けるもの: ...` の行をこの配列から組み立てる)。以前は説明に手で書いていて、
 * E2Eも手で書いた一覧と突き合わせていたため、**3箇所を人間が揃える前提**になっていた
 * (実際 project_context が説明とE2Eから漏れた。自動レビュー指摘)。
 * 出所を1つにすれば、増やしても減らしても説明が勝手に追いつく。
 *
 * **ビューはテーブルと同じ扱い** (判定を type IN ('table','view') から作っている)。
 * ただし**ビューを載せることは、そのビューが中で参照しているテーブルを載せることと同じ**。
 * 名前の照合はSQLの文字列しか見ないし、EXPLAIN も展開後を見るので、定義の中身までは辿らない。
 * いまの live_tasks / done_tasks はどちらも tasks しか見ておらず、その tasks も載っているので実害はない。
 * 機密を参照するビューを「列を絞ってあるから安全」と足すと、そこから読めるようになる —
 * ここは見える名前の一覧ではなく、**到達できる範囲の宣言**として読むこと */
// #181: scope が2つ (cost / audit) だったが、cost 側の llm_calls / model_prices を撤去したので
// **窓口は1つになった。**接続中のプロジェクトの記録だけを引く。
// live_tasks / done_tasks はビュー (どちらも tasks を見ている)
export const PUBLIC_TABLES: readonly string[] = [
  "tasks",
  "live_tasks",
  "done_tasks",
  "chat_messages",
  "summary_cards",
  "project_context",
];

/** #106追補: 会話ログなどプロジェクト側の記録をSQLで引く。
 * キーワード検索では「8/9の午前に何を話していたか」のような時間軸での切り出しができない。
 * 会話は揮発させる方針(#72)なので常時プロンプトには載せず、聞かれたときだけ掘る */
export function queryProjectData(sql: string, limit = 200) {
  return runReadonly(projectReadonly(), sql, limit);
}

/** 仮想テーブルを見つけて弾いたときの例外。EXPLAIN 自体の失敗と区別するために型で持つ
 * (メッセージで見分けると、文言を直した瞬間に握り潰しへ倒れる) */
class VirtualTableError extends Error {}

function runReadonly(
  conn: ReturnType<typeof projectReadonly>,
  sql: string,
  limit: number
): { rows: unknown[]; sql: string; truncated: boolean; note?: string } {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("SELECT か WITH で始まる読み取りクエリだけ実行できます");
  if (trimmed.includes(";")) throw new Error("複数の文は実行できません");
  const allowed = PUBLIC_TABLES;
  // #168: SQLをパースせず、「実在するオブジェクトの名前がSQLに現れたか」で判定する。
  // 名前の抽出をやめたのは、サブクエリ・CTE・JOIN・別名を正しく拾うには本物のパーサが要るため。
  // 実在名との突き合わせなら、書き方が何であれ「触れるのは許可したものだけ」が保てる
  const forbidden = (
    conn.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]
  )
    .map((r) => r.name)
    .filter((n) => !allowed.includes(n));
  const hit = forbidden.find((t) => new RegExp(`\\b${t}\\b`, "i").test(trimmed));
  if (hit) throw new Error(`${hit} は参照できません (この窓口から引けるのは ${allowed.join(" / ")} だけです)`);
  // 上の照合は「sqlite_master に載っているもの」から作るので、**sqlite_master 自身は載らない**。
  // 旧実装は名前を直書きして閉じていたぶん、ここだけ許可リスト化で取りこぼした (E2Eが拾った)
  if (/\bsqlite_\w+/i.test(trimmed))
    throw new Error(
      `sqlite_ で始まる内部の名前は参照できません (この窓口から引けるのは ${allowed.join(" / ")} だけです)`
    );
  // **仮想テーブルは名前で数え上げない。**sqlite_master に載らないので実在名の照合では捕まらず、
  // 名前を並べる方式では「知らないものは開く」から抜け出せない。実際 pragma_* を閉じた直後に
  // dbstat が残っていた (外部レビュー指摘) — dbstat は全テーブル名とページ構成を返すので、
  // このPRが塞ごうとしていた settings の存在漏れがそのまま残っていた。
  //
  // EXPLAIN すると仮想テーブルへのアクセスは必ず VOpen になる (通常のテーブルは OpenRead)。
  // 名前ではなく機構で塞ぐので、SQLiteに仮想テーブルが増えても効く。
  // EXPLAIN は計画を組み立てるだけで問い合わせを実行しない
  try {
    const plan = conn.prepare(`EXPLAIN ${trimmed}`).all() as { opcode: string }[];
    if (plan.some((r) => r.opcode === "VOpen"))
      throw new VirtualTableError(
        `仮想テーブル (dbstat / pragma_* など) は参照できません (この窓口から引けるのは ${allowed.join(" / ")} だけです)`
      );
  } catch (e) {
    // 弾いた本人の例外はそのまま上げる。EXPLAIN 自体が失敗したときは握って先へ進める —
    // 構文エラーなら下の prepare が同じ理由で落ち、そちらの方が直せる材料が多い
    if (e instanceof VirtualTableError) throw e;
  }
  const rows = conn.prepare(trimmed).all() as unknown[];
  return { rows: rows.slice(0, limit), sql: trimmed, truncated: rows.length > limit, ...silentTrap(trimmed) };
}

/** エラーにならない間違いに、結果と一緒に一言添える。
 *
 * 「エラーが出る間違いは事後注入で治る。エラーが出ない間違いは事前に教えるしかない」
 * (外部エージェントの整理)。ただし事前に教えても守られないものがあるので、
 * せめて結果と一緒に言う。実際にどちらも実データで踏まれている:
 *   - tasks 直引き → ゴミ箱・アーカイブ済みが混ざる (live_tasks を作った理由)
 *   - created_at で完了を数える → 登録日を数えてしまう (done_tasks を作った理由) */
function silentTrap(sql: string): { note?: string } {
  const notes: string[] = [];
  const s = sql.toLowerCase();
  if (/\bfrom\s+tasks\b/.test(s) && !/trashed_at|archived/.test(s)) {
    notes.push("tasks を直に引いています。ゴミ箱行き・アーカイブ済みも含まれるので、生きているタスクだけなら live_tasks を使ってください");
  }
  if (/count\s*\(|group\s+by/.test(s) && /date\s*\(\s*created_at/.test(s) && /\bfrom\s+tasks\b/.test(s)) {
    notes.push("created_at は登録日です。完了の集計なら done_at (または done_tasks.done_day) を使ってください");
  }
  return notes.length > 0 ? { note: notes.join(" / ") } : {};
}

/** SQLが失敗したときに、直せるだけの材料を一緒に返す。
 *
 * ツール説明を厚くする代わりに、間違えたときにその場で渡す。説明を読ませ続けるより
 * 安く、しかも「いま必要な情報」だけで済む。列やテーブルの一覧は実DBから引くので、
 * スキーマを変えても説明とズレない (契約と実装のズレは何度も踏んでいる) */
export function queryLogHelp(message: string): Record<string, unknown> {
  const conn = projectReadonly();
  const help: Record<string, unknown> = {};
  try {
    const objects = (
      conn.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY type DESC, name").all() as {
        name: string;
        type: string;
      }[]
    // #168: 引ける一覧は許可リストそのもの。ここで別の条件を書くと
    // 「案内されたのに引けない」「引けるのに案内されない」がすぐ生まれる
    ).filter((o) => PUBLIC_TABLES.includes(o.name));

    if (/no such (table|column)/i.test(message)) {
      // 何がどこにあるかを、実DBの現物で返す
      help.schema = Object.fromEntries(
        objects.map((o) => [
          `${o.name}${o.type === "view" ? " (ビュー)" : ""}`,
          (conn.prepare("SELECT name FROM pragma_table_info(?)").all(o.name) as { name: string }[])
            .map((c) => c.name)
            .join(", "),
        ])
      );
      help.hint =
        "生きているタスクは live_tasks、完了したものは done_tasks を使うと、条件を書かなくて済みます。ゴミ箱やアーカイブを見たいときだけ tasks を直に引いてください";
    } else if (/no such function/i.test(message)) {
      help.dialect = {
        note: "SQLite には date_trunc / INTERVAL / NOW() / DATEADD がありません",
        今日: "date('now','localtime')",
        月初: "date('now','localtime','start of month')",
        n日前: "date('now','localtime','-7 days')",
        日付だけ取り出す: "date(created_at)",
        時間帯: "strftime('%H', created_at) / substr(created_at,1,13)",
        月ごと: "strftime('%Y-%m', created_at)",
        文字列連結: "|| (+ ではない)",
        真偽値: "0/1 (true/false ではない)",
      };
    } else if (/syntax error/i.test(message)) {
      help.hint =
        "実行できるのは SELECT か WITH で始まる1文だけです。セミコロンで区切った複数文・DMLを含むCTEは通りません";
    }
    help.tables = objects.map((o) => (o.type === "view" ? `${o.name} (ビュー)` : o.name));
  } catch {
    /* 補助情報が作れなくても、エラー自体は返す */
  }
  return help;
}

/** #108: 検収の印を付け外しする。人間のUI操作 (REST) からのみ呼ぶ。
 * agentWrite の TaskPatch には入れない — エージェントが「確認しておきました」と
 * 自分でチェックを付けてしまう事故を、プロンプトではなく経路の有無で防ぐ */
export function setChecked(id: number, checked: boolean): { task?: Task; error?: string } {
  const cur = getTask(id);
  if (!cur) return {};
  // 印を付けられるのは Review にあるものだけ。以前は列を見ていなかったので、
  // Todoのうちに印を付けてから Review へ動かすと、Reviewに入ってから一度も確かめずに
  // 確定まで通せた (自動レビュー指摘)。mayEnterDone が「Review + 印」しか見ないぶん、
  // 印を付ける側で順序を守らせる必要がある。外すのはいつでもよい (印を消す方向は安全)
  if (checked) {
    if (cur.trashedAt) return { error: "ゴミ箱にあるタスクには検収チェックを付けられません" };
    if (cur.status !== "review")
      return { error: `検収チェックを付けられるのは Review 列のタスクだけです (いまは ${cur.status})。${DONE_GATE_RULE}` };
  }
  db()
    .prepare("UPDATE tasks SET checked_at = ? WHERE id = ?")
    .run(checked ? new Date().toLocaleString("sv-SE") : null, id);
  return { task: getTask(id) };
}
