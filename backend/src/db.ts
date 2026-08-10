import { hooks } from "./hooks.js";
import { admin, adminReadonly, currentProjectId, db, projectReadonly } from "./store.js";
import type { Member, Proposal, Task, TaskStatus } from "./types.js";

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
    assignee: r.assignee,
    assignReason: r.assign_reason ?? null,
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

export function createTask(title: string, status: TaskStatus = "todo", assignee: string | null = null, assignReason: string | null = null): Task {
  const info = db()
    .prepare("INSERT INTO tasks (title, status, assignee, assign_reason) VALUES (?, ?, ?, ?)")
    .run(title, status, assignee, assignReason);
  return getTask(Number(info.lastInsertRowid))!;
}

export function getTask(id: number): Task | undefined {
  const r = db().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  return r ? rowToTask(r) : undefined;
}

export type TaskPatch = Partial<
  Pick<Task, "title" | "status" | "assignee" | "assignReason" | "sort" | "context" | "summary" | "due" | "blockedBy" | "rejected">
>;

/** 複数タスクの一括更新 (#60)。完了遷移はまとめて1回だけ通知する (要約再生成のバッチ化)。
 * 単一更新もこの関数の長さ1ケースとして扱う — Doneへ入るルートはここ1本 */
export function updateTasks(patches: { id: number; patch: TaskPatch }[]): (Task | undefined)[] {
  const completed: number[] = [];
  const reopened: number[] = [];
  const results = patches.map(({ id, patch }) => {
    const cur = getTask(id);
    if (!cur) return undefined;
    // #87: 空文字の担当は「未割り当て」の意図。文字列""のまま保存すると
    // 誰にも割り当たっていないのにフィルタにも負荷計算にも乗らない幽霊状態になる
    if (patch.assignee === "") patch = { ...patch, assignee: null };
    const next = { ...cur, ...patch };
    // #112: 経緯メモが実際に変わったときだけ版を上げる。
    // 他の列の更新で上げてしまうと、context を書いている側が無関係な変更で弾かれる
    const contextChanged = patch.context !== undefined && patch.context !== cur.context;
    // #108: 作業中の列へ戻したら検収の印は無効になる。「確かめた」のは前の状態に対してなので、
    // 作り直しているものに印が残っていると、次の検収で「もう確認済み」と誤読される。
    // done と review では消さない (done=検収の結果、review=検収待ちで印は進捗そのもの)
    const backToWork = next.status === "todo" || next.status === "inprogress";
    db().prepare(
      "UPDATE tasks SET title = ?, status = ?, assignee = ?, assign_reason = ?, sort = ?, context = ?, summary = ?, due = ?, blocked_by = ?, rejected = ?, context_version = context_version + ?, checked_at = ?, done_at = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(
      next.title,
      next.status,
      next.assignee,
      next.assignReason,
      next.sort,
      next.context,
      next.summary,
      next.due,
      next.blockedBy?.length ? JSON.stringify(next.blockedBy) : null,
      next.rejected ? 1 : 0,
      contextChanged ? 1 : 0,
      backToWork ? null : (cur.checkedAt ?? null),
      // 完了に入った瞬間だけ打刻する。以降の編集では動かさない (updated_at と違い「終わった日」)
      next.status === "done" ? (cur.doneAt ?? new Date().toLocaleString("sv-SE")) : null,
      id
    );
    if (patch.assignee && patch.assignee !== cur.assignee) {
      db().prepare("INSERT INTO assignment_history (task_title, assignee, note) VALUES (?, ?, ?)").run(
        next.title,
        patch.assignee,
        patch.assignReason ?? null
      );
    }
    if (cur.status !== "done" && next.status === "done") completed.push(id);
    else if (cur.status === "done" && next.status !== "done") reopened.push(id);
    return getTask(id);
  });
  // 完了/再開の遷移をアプリ層に通知 (Doneアーカイブ+要約の再生成トリガー)
  if (completed.length > 0) hooks.tasksCompleted?.(completed);
  for (const id of reopened) hooks.taskReopened?.(id);
  return results;
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
      .prepare("UPDATE tasks SET trashed_at = datetime('now', 'localtime') WHERE id = ? AND trashed_at IS NULL")
      .run(id).changes > 0
  );
}

export function restoreTask(id: number): Task | undefined {
  db().prepare("UPDATE tasks SET trashed_at = NULL WHERE id = ?").run(id);
  return getTask(id);
}

/** 実体を消す。人間のUI操作からのみ通す (チャット・MCPからは呼ばない) */
export function purgeTask(id: number): boolean {
  return db().prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
}

export function listMembers(): Member[] {
  return db().prepare("SELECT * FROM members ORDER BY id").all() as Member[];
}

export function memberLoads(): { name: string; openTasks: number }[] {
  return listMembers().map((m) => ({
    name: m.name,
    openTasks: (
      db()
        .prepare("SELECT COUNT(*) AS c FROM tasks WHERE assignee = ? AND status != 'done'")
        .get(m.name) as { c: number }
    ).c,
  }));
}

export function assignmentHistory(limit = 20): { taskTitle: string; assignee: string; note: string | null }[] {
  return (
    db().prepare("SELECT task_title, assignee, note FROM assignment_history ORDER BY id DESC LIMIT ?").all(limit) as any[]
  ).map((r) => ({ taskTitle: r.task_title, assignee: r.assignee, note: r.note }));
}

export function createProposal(taskId: number, assignee: string, reason: string): Proposal | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  const info = db().prepare("INSERT INTO proposals (task_id, assignee, reason) VALUES (?, ?, ?)").run(taskId, assignee, reason);
  return getProposal(Number(info.lastInsertRowid));
}

export function getProposal(id: number): Proposal | undefined {
  const r = db()
    .prepare(
      "SELECT p.*, t.title AS task_title FROM proposals p JOIN tasks t ON t.id = p.task_id WHERE p.id = ?"
    )
    .get(id) as any;
  if (!r) return undefined;
  return {
    id: r.id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    assignee: r.assignee,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
  };
}

export function listPendingProposals(): Proposal[] {
  const rows = db()
    .prepare(
      "SELECT p.*, t.title AS task_title FROM proposals p JOIN tasks t ON t.id = p.task_id WHERE p.status = 'pending' ORDER BY p.id"
    )
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    assignee: r.assignee,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export function resolveProposal(id: number, status: "approved" | "rejected"): Proposal | undefined {
  db().prepare("UPDATE proposals SET status = ? WHERE id = ?").run(status, id);
  const p = getProposal(id);
  if (p && status === "approved") {
    updateTask(p.taskId, { assignee: p.assignee, assignReason: p.reason });
  }
  return p;
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
  settled: boolean;
  createdAt: string;
}

function rowToCard(r: any): SummaryCard {
  return {
    id: r.id,
    title: r.title,
    elements: JSON.parse(r.elements),
    taskIds: JSON.parse(r.task_ids),
    settled: !!r.settled,
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
// 以前は「settledでない最後のカード」に合流し続けたため、整頓するまで1枚が無限に育ち、
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

export function setCardSettled(cardId: number): void {
  db().prepare("UPDATE summary_cards SET settled = 1 WHERE id = ?").run(cardId);
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
export function setProjectContext(text: string, version?: number): { ok: boolean; current?: ReturnType<typeof getProjectContextRow> } {
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
  db().prepare("INSERT INTO chat_messages (role, content, trace, usage, task_id) VALUES (?, ?, ?, ?, ?)").run(
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

export function recordLlmCall(row: {
  purpose: string;
  model: string;
  routedModel: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  elapsedMs: number;
  /** #106: 呼び出し時点の単価と概算額。あとで単価が改定されても過去の記録が変わらない */
  priceInPerM?: number | null;
  priceOutPerM?: number | null;
  estimatedUsd?: number | null;
}) {
  admin.prepare(
    "INSERT INTO llm_calls (purpose, model, routed_model, prompt_tokens, completion_tokens, cached_tokens, elapsed_ms, project_id, price_in_per_m, price_out_per_m, estimated_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    row.purpose,
    row.model,
    row.routedModel,
    row.promptTokens,
    row.completionTokens,
    row.cachedTokens ?? 0,
    row.elapsedMs,
    currentProjectId(),
    row.priceInPerM ?? null,
    row.priceOutPerM ?? null,
    row.estimatedUsd ?? null
  );
}

export function metrics() {
  const total = admin
    .prepare(
      "SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct, COALESCE(SUM(cached_tokens),0) AS cached, COALESCE(AVG(elapsed_ms),0) AS avgMs FROM llm_calls"
    )
    .get() as any;
  const byModel = admin
    .prepare(
      "SELECT model, COUNT(*) AS calls, SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct, SUM(cached_tokens) AS cached, CAST(AVG(elapsed_ms) AS INTEGER) AS avgMs FROM llm_calls GROUP BY model ORDER BY calls DESC"
    )
    .all();
  // 用途別: 「対話は固定・要約は品質ルーティング・定型はコスト優先」の使い分けが数字で見える (#21)
  const byPurpose = admin
    .prepare(
      "SELECT purpose, COUNT(*) AS calls, SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct, SUM(cached_tokens) AS cached, CAST(AVG(elapsed_ms) AS INTEGER) AS avgMs, COUNT(DISTINCT routed_model) AS models FROM llm_calls GROUP BY purpose ORDER BY calls DESC"
    )
    .all();
  const recent = admin.prepare("SELECT * FROM llm_calls ORDER BY id DESC LIMIT 50").all();
  return {
    totalCalls: total.calls,
    promptTokens: total.pt,
    completionTokens: total.ct,
    cachedTokens: total.cached,
    avgElapsedMs: Math.round(total.avgMs),
    byModel,
    byPurpose,
    recent,
  };
}

/** 全ログExport (#83): 検証利用向けのフルダンプ。全テーブルをもれなく生のまま出す (期間指定は将来必要になったら) */
export function exportAll() {
  const all = (table: string) => db().prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  return {
    exportedAt: new Date().toLocaleString("ja-JP"),
    tasks: all("tasks"), // アーカイブ済み含む全件
    summaryCards: all("summary_cards"),
    chatMessages: all("chat_messages"), // trace/usage含む生データ
    llmCalls: admin.prepare("SELECT * FROM llm_calls WHERE project_id = ? ORDER BY id").all(currentProjectId()),
    assignmentHistory: all("assignment_history"),
    proposals: all("proposals"),
    members: all("members"),
    projectContext: db().prepare("SELECT * FROM project_context WHERE id = 1").get() ?? null,
    settings: admin.prepare("SELECT * FROM settings ORDER BY key").all(), // #88: どのモデルで動いていたかの記録
  };
}

/** オーディットログ (#33): 会話・LLM呼び出し・割り振り履歴の時系列閲覧用 */
export function auditLog() {
  const chat = (
    db().prepare("SELECT id, role, content, task_id, created_at FROM chat_messages ORDER BY id DESC LIMIT 100").all() as any[]
  ).map((r) => ({
    id: r.id,
    role: r.role,
    content: String(r.content).slice(0, 200),
    taskId: r.task_id ?? null,
    createdAt: r.created_at,
  }));
  // LLM呼び出しは管理DB。監査は「このプロジェクトで何が起きたか」を見る画面なので絞る (#86)
  const llm = (
    admin
      .prepare(
        "SELECT id, purpose, model, routed_model, prompt_tokens, completion_tokens, cached_tokens, elapsed_ms, created_at FROM llm_calls WHERE project_id = ? ORDER BY id DESC LIMIT 100"
      )
      .all(currentProjectId()) as any[]
  ).map((r) => ({
    id: r.id,
    purpose: r.purpose,
    model: r.model,
    routedModel: r.routed_model,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    cachedTokens: r.cached_tokens,
    elapsedMs: r.elapsed_ms,
    createdAt: r.created_at,
  }));
  const assignments = (
    db().prepare("SELECT id, task_title, assignee, note, created_at FROM assignment_history ORDER BY id DESC LIMIT 50").all() as any[]
  ).map((r) => ({ id: r.id, taskTitle: r.task_title, assignee: r.assignee, note: r.note, createdAt: r.created_at }));
  return { chat, llm, assignments };
}

/** #93: 「直近なにをしてた?」に実データで答えるための活動ログ。
 * 監査タブの生ログ全部ではなく、経緯を語るのに要る分だけを絞って返す
 * (ツールの戻り値がそのままプロンプトに乗るので、量がコストに直結する)。
 * 会話ログは含めない — 進行中の会話は履歴として既にモデルの手元にあるため */
export function recentActivity(limit = 15) {
  const tasks = (
    db()
      .prepare(
        "SELECT id, title, status, assignee, rejected, updated_at FROM tasks WHERE trashed_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?"
      )
      .all(limit) as any[]
  ).map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    assignee: r.assignee,
    ...(r.rejected ? { rejected: true } : {}),
    at: r.updated_at,
  }));
  const assignments = (
    db()
      .prepare("SELECT task_title, assignee, note, created_at FROM assignment_history ORDER BY id DESC LIMIT 10")
      .all() as any[]
  ).map((r) => ({ task: r.task_title, to: r.assignee, note: r.note ? String(r.note).slice(0, 80) : null, at: r.created_at }));
  return { updatedTasks: tasks, assignments };
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
export function reorderTasks(ids: number[], status?: TaskStatus): { ordered: number; appended: number } {
  const targets = listTasks().filter((t) => !status || t.status === status);
  const byId = new Map(targets.map((t) => [t.id, t]));
  const seen = new Set<number>();
  const ordered: Task[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t || seen.has(id)) continue;
    seen.add(id);
    ordered.push(t);
  }
  const appended = targets.filter((t) => !seen.has(t.id)); // 指定漏れは元の順のまま末尾へ
  const final = [...ordered, ...appended];
  const stmt = db().prepare("UPDATE tasks SET sort = ? WHERE id = ?");
  db().transaction(() => final.forEach((t, i) => stmt.run(i + 1, t.id)))();
  return { ordered: ordered.length, appended: appended.length };
}

// #103: 経緯の横断検索。LLMが表記ゆれを自分で展開して複数語を投げ、コードは総当たりするだけ。
//
// ベクトル検索を入れなかったのは、埋め込みが持つ「意味の近さ」をLLM自身が既に持っているから。
// 「DBを分ける」と「ファイル分離」が近いことを知っているのはLLMなので、そこを外部インデックスに
// 出す必要がない。LLMが語を並べ(判断)、コードが総当たりする(機械的処理) — #91の並べ替えと同じ形。
//
// アーカイブ済みも対象にする。経緯を後から辿りたい場面はDoneになった後のほうが多い。
export function searchTasks(terms: string[], limit = 10) {
  const words = terms.map((t) => t.trim()).filter(Boolean).slice(0, 10);
  if (words.length === 0) return { hits: [] };
  const rows = db()
    .prepare(
      "SELECT id, title, status, assignee, summary, assign_reason, context, archived FROM tasks WHERE trashed_at IS NULL"
    )
    .all() as any[];

  const scored = rows
    .map((r) => {
      const haystack = [r.title, r.summary, r.assign_reason, r.context].filter(Boolean).join("\n");
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
        assignee: r.assignee,
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

// #106: 料金表をDBに保存する。呼び出しごとに単価を打刻するので、外部APIが落ちていても
// 「単価が引けず概算から漏れる」行が出ないようにしたい (以前は5件が黙って除外されていた)
export function saveModelPrices(
  entries: { id: string; inputPerM: number | null; outputPerM: number | null; contextLength: number | null; inputModalities: string[] }[]
): void {
  const stmt = admin.prepare(
    `INSERT INTO model_prices (id, input_per_m, output_per_m, context_length, input_modalities, fetched_at)
     VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(id) DO UPDATE SET input_per_m = excluded.input_per_m, output_per_m = excluded.output_per_m,
       context_length = excluded.context_length, input_modalities = excluded.input_modalities, fetched_at = excluded.fetched_at`
  );
  admin.transaction(() => {
    for (const e of entries) {
      stmt.run(e.id, e.inputPerM, e.outputPerM, e.contextLength, JSON.stringify(e.inputModalities));
    }
  })();
}

export function loadModelPrices() {
  return (admin.prepare("SELECT * FROM model_prices").all() as any[]).map((r) => ({
    id: r.id as string,
    name: null,
    inputPerM: r.input_per_m as number | null,
    outputPerM: r.output_per_m as number | null,
    contextLength: r.context_length as number | null,
    inputModalities: r.input_modalities ? JSON.parse(r.input_modalities) : [],
  }));
}

/** #106: 記録の集計はLLMにSQLを書かせ、コードは安全性だけ守る (#91の並べ替え・#103の検索と同じ形)。
 * 集計軸を先に決め打ちすると、そこから外れた問い(「今日の午後だけ」「8/9の午前に何を話したか」)に答えられない。
 * 守り: 書き込めない接続 / SELECT・WITH のみ / 文は1つ / 機密テーブルの遮断 / 行数上限。
 * プロンプトで「SELECTだけ」と言っても漏れるが、readonly接続は漏れない */

/** SQLで開放しないもの。「機密以外は読み取り専用で開放する」方針なので、隠す側を列挙する —
 * 公開側を列挙すると、テーブルを足したときに閉じ忘れではなく「開き忘れ」で気づけるが、
 * 逆に隠す側を列挙すると足したテーブルは黙って開く。ここでは後者を選び、
 * 機密になりうるものだけを閉じる (APIキーはDBに入れていない。ファイルとenvのみ) */
const PRIVATE_TABLES = ["settings", "sqlite_master", "sqlite_schema"];

export function queryLlmCalls(sql: string, limit = 200) {
  return runReadonly(adminReadonly(), sql, limit);
}

/** #106追補: 会話ログ・割り振り履歴などプロジェクト側の記録もSQLで引く。
 * キーワード検索では「8/9の午前に何を話していたか」のような時間軸での切り出しができない。
 * 会話は揮発させる方針(#72)なので常時プロンプトには載せず、聞かれたときだけ掘る */
export function queryProjectData(sql: string, limit = 200) {
  return runReadonly(projectReadonly(), sql, limit);
}

function runReadonly(
  conn: ReturnType<typeof adminReadonly>,
  sql: string,
  limit: number
): { rows: unknown[]; sql: string; truncated: boolean } {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("SELECT か WITH で始まる読み取りクエリだけ実行できます");
  if (trimmed.includes(";")) throw new Error("複数の文は実行できません");
  const hit = PRIVATE_TABLES.find((t) => new RegExp(`\\b${t}\\b`, "i").test(trimmed));
  if (hit) throw new Error(`${hit} は参照できません (機密として閉じているテーブル)`);
  const rows = conn.prepare(trimmed).all() as unknown[];
  return { rows: rows.slice(0, limit), sql: trimmed, truncated: rows.length > limit };
}

/** #108: 検収の印を付け外しする。人間のUI操作 (REST) からのみ呼ぶ。
 * agentWrite の TaskPatch には入れない — エージェントが「確認しておきました」と
 * 自分でチェックを付けてしまう事故を、プロンプトではなく経路の有無で防ぐ */
export function setChecked(id: number, checked: boolean): Task | undefined {
  db()
    .prepare("UPDATE tasks SET checked_at = ? WHERE id = ?")
    .run(checked ? new Date().toLocaleString("sv-SE") : null, id);
  return getTask(id);
}
