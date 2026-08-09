import Database from "better-sqlite3";
import { hooks } from "./hooks.js";
import type { Member, Proposal, Task, TaskStatus } from "./types.js";

const db = new Database(process.env.DB_PATH ?? "chatban.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  assignee TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  skills TEXT
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  assignee TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS assignment_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_title TEXT NOT NULL,
  assignee TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS project_context (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  trace TEXT,
  usage TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  routed_model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`);

// 既存DBへの列追加 (EF Migration不使用の流儀: 失敗=適用済みとして無視)
try {
  db.exec("ALTER TABLE tasks ADD COLUMN sort REAL");
} catch {
  /* already exists */
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN lane TEXT");
} catch {
  /* already exists */
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
} catch {
  /* already exists */
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN summary_card_id INTEGER");
} catch {
  /* already exists */
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN context TEXT");
} catch {
  /* already exists */
}
try {
  db.exec("ALTER TABLE llm_calls ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0");
} catch {
  /* already exists */
}
try {
  db.exec("ALTER TABLE chat_messages ADD COLUMN task_id INTEGER");
} catch {
  /* already exists */
}
db.exec(`
CREATE TABLE IF NOT EXISTS summary_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  elements TEXT NOT NULL,
  task_ids TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`);
try {
  db.exec("ALTER TABLE summary_cards ADD COLUMN settled INTEGER NOT NULL DEFAULT 0");
} catch {
  /* already exists */
}

// 初回起動時のみシード
const memberCount = db.prepare("SELECT COUNT(*) AS c FROM members").get() as { c: number };
if (memberCount.c === 0) {
  const insMember = db.prepare("INSERT INTO members (name, skills) VALUES (?, ?)");
  insMember.run("zio", "アーキテクチャ設計, .NET, LLM連携");
  insMember.run("佐藤", "フロントエンド, デザイン, 動画編集");
  insMember.run("鈴木", "記事執筆, 検証, ドキュメント");
  insMember.run("高橋", "インフラ, API検証, 計測");
  const insHist = db.prepare("INSERT INTO assignment_history (task_title, assignee, note) VALUES (?, ?, ?)");
  insHist.run("競合サービスのスクショ収集", "鈴木", "検証系は鈴木が担当してきた");
  insHist.run("デモ動画の絵コンテ", "佐藤", "動画まわりは佐藤の領域");
  insHist.run("OrcaRouter接続検証", "高橋", "API検証の実績");
  const insTask = db.prepare("INSERT INTO tasks (title, status, assignee, reason) VALUES (?, ?, ?, ?)");
  insTask.run("OrcaRouter接続検証とコスト計測", "done", "高橋", "API検証の経験");
  insTask.run("ボードUI(かんばん)の骨格実装", "inprogress", "zio", "実装の中心");
}

export function listTasks(includeArchived = false): Task[] {
  // sort未設定の既存行はid順に混ざる (COALESCEでidを暫定sortとして扱う)
  const where = includeArchived ? "" : "WHERE archived = 0";
  return (db.prepare(`SELECT * FROM tasks ${where} ORDER BY COALESCE(sort, id), id`).all() as any[]).map(rowToTask);
}

function rowToTask(r: any): Task {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    assignee: r.assignee,
    reason: r.reason,
    context: r.context ?? null,
    lane: r.lane ?? null,
    sort: r.sort ?? r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createTask(title: string, status: TaskStatus = "todo", assignee: string | null = null, reason: string | null = null): Task {
  const info = db
    .prepare("INSERT INTO tasks (title, status, assignee, reason) VALUES (?, ?, ?, ?)")
    .run(title, status, assignee, reason);
  return getTask(Number(info.lastInsertRowid))!;
}

export function getTask(id: number): Task | undefined {
  const r = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  return r ? rowToTask(r) : undefined;
}

export function updateTask(
  id: number,
  patch: Partial<Pick<Task, "title" | "status" | "assignee" | "reason" | "sort" | "lane" | "context">>
): Task | undefined {
  const cur = getTask(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  db.prepare(
    "UPDATE tasks SET title = ?, status = ?, assignee = ?, reason = ?, sort = ?, lane = ?, context = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(next.title, next.status, next.assignee, next.reason, next.sort, next.lane, next.context, id);
  if (patch.assignee && patch.assignee !== cur.assignee) {
    db.prepare("INSERT INTO assignment_history (task_title, assignee, note) VALUES (?, ?, ?)").run(
      next.title,
      patch.assignee,
      patch.reason ?? null
    );
  }
  // 完了/再開の遷移をアプリ層に通知 (Doneアーカイブ+要約の再生成トリガー)
  if (cur.status !== "done" && next.status === "done") hooks.taskCompleted?.(id);
  else if (cur.status === "done" && next.status !== "done") hooks.taskReopened?.(id);
  return getTask(id);
}

export function deleteTask(id: number): boolean {
  return db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
}

export function listMembers(): Member[] {
  return db.prepare("SELECT * FROM members ORDER BY id").all() as Member[];
}

export function memberLoads(): { name: string; openTasks: number }[] {
  return listMembers().map((m) => ({
    name: m.name,
    openTasks: (
      db
        .prepare("SELECT COUNT(*) AS c FROM tasks WHERE assignee = ? AND status != 'done'")
        .get(m.name) as { c: number }
    ).c,
  }));
}

export function assignmentHistory(limit = 20): { taskTitle: string; assignee: string; note: string | null }[] {
  return (
    db.prepare("SELECT task_title, assignee, note FROM assignment_history ORDER BY id DESC LIMIT ?").all(limit) as any[]
  ).map((r) => ({ taskTitle: r.task_title, assignee: r.assignee, note: r.note }));
}

export function createProposal(taskId: number, assignee: string, reason: string): Proposal | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  const info = db.prepare("INSERT INTO proposals (task_id, assignee, reason) VALUES (?, ?, ?)").run(taskId, assignee, reason);
  return getProposal(Number(info.lastInsertRowid));
}

export function getProposal(id: number): Proposal | undefined {
  const r = db
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
  const rows = db
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
  db.prepare("UPDATE proposals SET status = ? WHERE id = ?").run(status, id);
  const p = getProposal(id);
  if (p && status === "approved") {
    updateTask(p.taskId, { assignee: p.assignee, reason: p.reason });
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
  return (db.prepare("SELECT * FROM summary_cards ORDER BY id").all() as any[]).map(rowToCard);
}

export function getSummaryCard(id: number): SummaryCard | undefined {
  const r = db.prepare("SELECT * FROM summary_cards WHERE id = ?").get(id) as any;
  return r ? rowToCard(r) : undefined;
}

// 完了タスクの合流先。settled=0 のカードが「育っているアクティブ要約」。
// 過去ログ化(settle)の引き金は整頓(compact_archive)のみ (#58)。
export function getOrCreateActiveCard(): SummaryCard {
  const active = listSummaryCards().filter((c) => !c.settled).at(-1);
  if (active) return active;
  const info = db
    .prepare("INSERT INTO summary_cards (title, elements, task_ids) VALUES (?, ?, ?)")
    .run("完了タスクの要約", "[]", "[]");
  return getSummaryCard(Number(info.lastInsertRowid))!;
}

export function assignTaskToCard(taskId: number, cardId: number) {
  db.prepare("UPDATE tasks SET archived = 1, summary_card_id = ? WHERE id = ?").run(cardId, taskId);
  const ids = new Set<number>(JSON.parse((db.prepare("SELECT task_ids FROM summary_cards WHERE id = ?").get(cardId) as any).task_ids));
  ids.add(taskId);
  db.prepare("UPDATE summary_cards SET task_ids = ? WHERE id = ?").run(JSON.stringify([...ids]), cardId);
}

export function detachTaskFromCard(taskId: number) {
  const r = db.prepare("SELECT summary_card_id FROM tasks WHERE id = ?").get(taskId) as any;
  const cardId = r?.summary_card_id;
  db.prepare("UPDATE tasks SET archived = 0, summary_card_id = NULL WHERE id = ?").run(taskId);
  if (cardId) {
    const card = getSummaryCard(cardId);
    if (card) {
      const ids = card.taskIds.filter((id) => id !== taskId);
      db.prepare("UPDATE summary_cards SET task_ids = ? WHERE id = ?").run(JSON.stringify(ids), cardId);
    }
  }
  return cardId as number | undefined;
}

export function tasksOfCard(cardId: number): Task[] {
  return (db.prepare("SELECT * FROM tasks WHERE summary_card_id = ? ORDER BY id").all(cardId) as any[]).map(rowToTask);
}

export function updateCardContent(cardId: number, title: string | null, elements: SummaryElement[]) {
  const cur = getSummaryCard(cardId);
  if (!cur) return;
  db.prepare("UPDATE summary_cards SET title = ?, elements = ? WHERE id = ?").run(
    title ?? cur.title,
    JSON.stringify(elements),
    cardId
  );
}

export function deleteSummaryCards(ids: number[]) {
  const stmt = db.prepare("DELETE FROM summary_cards WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

export function reassignTasksToCard(taskIds: number[], cardId: number) {
  const stmt = db.prepare("UPDATE tasks SET summary_card_id = ? WHERE id = ?");
  for (const id of taskIds) stmt.run(cardId, id);
  db.prepare("UPDATE summary_cards SET task_ids = ? WHERE id = ?").run(JSON.stringify(taskIds), cardId);
}

export function setCardSettled(cardId: number): void {
  db.prepare("UPDATE summary_cards SET settled = 1 WHERE id = ?").run(cardId);
}

export function getProjectContext(): string {
  const r = db.prepare("SELECT text FROM project_context WHERE id = 1").get() as { text: string } | undefined;
  return r?.text ?? "";
}

export function setProjectContext(text: string) {
  db.prepare(
    "INSERT INTO project_context (id, text, updated_at) VALUES (1, ?, datetime('now', 'localtime')) ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at"
  ).run(text);
}

export function saveChatMessage(
  role: "user" | "assistant",
  content: string,
  trace?: unknown,
  usage?: unknown,
  taskId?: number | null
) {
  db.prepare("INSERT INTO chat_messages (role, content, trace, usage, task_id) VALUES (?, ?, ?, ?, ?)").run(
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
  const rows = db
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
}) {
  db.prepare(
    "INSERT INTO llm_calls (purpose, model, routed_model, prompt_tokens, completion_tokens, cached_tokens, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(row.purpose, row.model, row.routedModel, row.promptTokens, row.completionTokens, row.cachedTokens ?? 0, row.elapsedMs);
}

export function metrics() {
  const total = db
    .prepare(
      "SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct, COALESCE(AVG(elapsed_ms),0) AS avgMs FROM llm_calls"
    )
    .get() as any;
  const byModel = db
    .prepare(
      "SELECT model, COUNT(*) AS calls, SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct, CAST(AVG(elapsed_ms) AS INTEGER) AS avgMs FROM llm_calls GROUP BY model"
    )
    .all();
  const recent = db.prepare("SELECT * FROM llm_calls ORDER BY id DESC LIMIT 20").all();
  return {
    totalCalls: total.calls,
    promptTokens: total.pt,
    completionTokens: total.ct,
    avgElapsedMs: Math.round(total.avgMs),
    byModel,
    recent,
  };
}
