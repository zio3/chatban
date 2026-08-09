import Database from "better-sqlite3";
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

export function listTasks(): Task[] {
  // sort未設定の既存行はid順に混ざる (COALESCEでidを暫定sortとして扱う)
  return (db.prepare("SELECT * FROM tasks ORDER BY COALESCE(sort, id), id").all() as any[]).map(rowToTask);
}

function rowToTask(r: any): Task {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    assignee: r.assignee,
    reason: r.reason,
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
  patch: Partial<Pick<Task, "title" | "status" | "assignee" | "reason" | "sort">>
): Task | undefined {
  const cur = getTask(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  db.prepare(
    "UPDATE tasks SET title = ?, status = ?, assignee = ?, reason = ?, sort = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(next.title, next.status, next.assignee, next.reason, next.sort, id);
  if (patch.assignee && patch.assignee !== cur.assignee) {
    db.prepare("INSERT INTO assignment_history (task_title, assignee, note) VALUES (?, ?, ?)").run(
      next.title,
      patch.assignee,
      patch.reason ?? null
    );
  }
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

export function recordLlmCall(row: {
  purpose: string;
  model: string;
  routedModel: string | null;
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number;
}) {
  db.prepare(
    "INSERT INTO llm_calls (purpose, model, routed_model, prompt_tokens, completion_tokens, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(row.purpose, row.model, row.routedModel, row.promptTokens, row.completionTokens, row.elapsedMs);
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
