import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./log.js";

// #86: プロジェクトごとにSQLiteファイルを分ける。
//
// なぜ project_id 列でなくファイル分離か:
//  - タスクの #ID がプロジェクトごとに1から始まる。#IDは会話の語彙(「#7を後回し」)なので
//    2桁で収まることが手触りに直結する。通し番号だと #247 になり口に出せなくなる
//  - 全クエリに WHERE project_id を書く必要がない = 絞り忘れが構造的に起きない。
//    混ざったボード索引をLLMが読むと誤った提案をするが、人間はそれに気づけない
//  - プロジェクトの複製・削除・受け渡しがファイル操作で済む (デモ用に作って捨てるが楽)
//  - 実録データと他案件が物理的に別ファイルになり、公開時の混入リスクを管理しやすい
//
// 置き場所:
//   data/chatban-admin.db          projects / settings / llm_calls (コストは口座単位なので横断)
//   data/projects/<id>-<slug>.db   tasks / summary_cards / chat_messages / proposals /
//                                  assignment_history / project_context / members

const DATA_DIR = process.env.CHATBAN_DATA_DIR ?? "data";
const ADMIN_PATH = join(DATA_DIR, "chatban-admin.db");
const PROJECT_DIR = join(DATA_DIR, "projects");

function open(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return db;
}

/** 管理DBのスキーマ。プロジェクト一覧・アプリ全体の設定・全LLM呼び出し */
function ensureAdminSchema(db: Database.Database) {
  db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS model_prices (
  id TEXT PRIMARY KEY,
  input_per_m REAL,
  output_per_m REAL,
  context_length INTEGER,
  input_modalities TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  routed_model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`);
  // #107: 無効フラグ。削除するほどではないが普段は見せたくないプロジェクト用。
  // ドロップダウンから消えるだけで、設定画面には出る (実体もタスクもそのまま)
  const addProj = (sql: string) => {
    try {
      db.exec(sql);
    } catch {
      /* already exists */
    }
  };
  addProj("ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  // 旧DBから移設した llm_calls には project_id が無いので後付けする
  const add = (sql: string) => {
    try {
      db.exec(sql);
    } catch {
      /* already exists */
    }
  };
  add("ALTER TABLE llm_calls ADD COLUMN project_id INTEGER");
  // #106: 呼び出し時点の単価と概算額を打刻する。あとで単価が改定されても過去の記録が変わらない。
  // 単価も残すのは、キャッシュ割引率(0.1)が仮定値で、後から見直したときに再計算できるようにするため
  add("ALTER TABLE llm_calls ADD COLUMN price_in_per_m REAL");
  add("ALTER TABLE llm_calls ADD COLUMN price_out_per_m REAL");
  add("ALTER TABLE llm_calls ADD COLUMN estimated_usd REAL");
}

/** #106: コスト分析はLLMにSQLを書かせる。書き込めない接続を別に持つのが安全境界
 * (プロンプトで「SELECTだけ」と言っても漏れるが、readonly接続は漏れない) */
let adminRo: Database.Database | null = null;
export function adminReadonly(): Database.Database {
  if (!adminRo) adminRo = new Database(ADMIN_PATH, { readonly: true });
  return adminRo;
}

/** プロジェクトDBのスキーマ。DBを開くたびに流すので、新規作成と既存の移行が同じ経路になる
 * (EF Migration不使用の流儀: CREATE IF NOT EXISTS + ALTER の失敗は適用済みとして無視) */
export function ensureProjectSchema(db: Database.Database) {
  db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  assignee TEXT,
  assign_reason TEXT,
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
  task_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS summary_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  elements TEXT NOT NULL,
  task_ids TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`);
  const addColumn = (sql: string) => {
    try {
      db.exec(sql);
    } catch {
      /* already exists */
    }
  };
  addColumn("ALTER TABLE tasks ADD COLUMN sort REAL");
  // #107: lane (demo/later) は廃止。「今回やる/後で」は他ツールでも列(Backlog)やスプリントで
  // 表すもので、フィールドは代用でしかなかった。実データでも47件中1件しか使われず、
  // rejected と意味が近いせいで「後回しは却下ではない」という注記をプロンプトに書く羽目になっていた。
  // #91 で並べ替えをLLMに任せられるようになったので、列の下へ落とすことで表現する
  addColumn("ALTER TABLE tasks DROP COLUMN lane");
  addColumn("ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  addColumn("ALTER TABLE tasks ADD COLUMN summary_card_id INTEGER");
  addColumn("ALTER TABLE tasks ADD COLUMN context TEXT");
  addColumn("ALTER TABLE tasks ADD COLUMN due TEXT");
  addColumn("ALTER TABLE tasks ADD COLUMN blocked_by TEXT");
  addColumn("ALTER TABLE tasks ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0");
  // #102: 削除は論理削除 (ゴミ箱)。解釈ミスが取り返しのつかない結果に直結しないようにする
  addColumn("ALTER TABLE tasks ADD COLUMN trashed_at TEXT");
  // #92: 現況の一言 (カードに出る)。「なぜこの人か」(reason)と「いまどうなっているか」は別の情報
  addColumn("ALTER TABLE tasks ADD COLUMN summary TEXT");
  // #92: reason → assign_reason へ改名。「reason」だけでは何の理由か分からず、
  // MCP経由のエージェントが進捗を書き込む欄になっていた。名前で用途が分かるようにする
  // (既存DBのみRENAMEが成功し、新規DBはCREATE時点でassign_reasonなので失敗して無視される)
  addColumn("ALTER TABLE tasks RENAME COLUMN reason TO assign_reason");
  // #112: 楽観ロックは経緯メモ(context)にだけ効かせる。
  // エージェントは「読む→考える(数十秒)→書く」なので、その間の変更を踏み潰しうる。
  // ただし失うものが大きいのは context だけ — 全文上書きの契約なので、衝突すると
  // 他人の追記が消える。status や due のような単一値は後勝ちでも実害が小さく、
  // むしろ長いサイクル(context)と同じ番号で守ると、実害のない衝突でリトライが多発する
  addColumn("ALTER TABLE tasks ADD COLUMN context_version INTEGER NOT NULL DEFAULT 1");
  // #108: 検収の印。人が実物で確かめた日時が入る (nullなら未検収)。
  // status とは別物 — done は「列が動いた」、checked_at は「人が確かめた」。
  // 一塊の完了を管理する重要なフラグなので、UIの一時状態ではなくDBに持つ。
  // 書けるのは人間のUI経路(REST)だけで、エージェント(agentWrite)からは触れない
  addColumn("ALTER TABLE tasks ADD COLUMN checked_at TEXT");
  addColumn("ALTER TABLE summary_cards ADD COLUMN settled INTEGER NOT NULL DEFAULT 0");
  addColumn("ALTER TABLE chat_messages ADD COLUMN task_id INTEGER");
}

export const admin = open(ADMIN_PATH);
ensureAdminSchema(admin);

/** ファイル名に使える形へ。ファイルを見て中身が分かることを優先し、日本語はそのまま残す
 * (パスに使えない文字とスペースだけ潰す。長すぎる名前は切る) */
function slug(name: string): string {
  const s = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
  return s || "project";
}

export interface ProjectRow {
  id: number;
  name: string;
  file: string;
  archived: number;
  created_at: string;
}

export function listProjects(): ProjectRow[] {
  return admin.prepare("SELECT * FROM projects ORDER BY id").all() as ProjectRow[];
}

export function getProject(id: number): ProjectRow | undefined {
  return admin.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

export function insertProject(name: string): ProjectRow {
  const info = admin.prepare("INSERT INTO projects (name, file) VALUES (?, '')").run(name);
  const id = Number(info.lastInsertRowid);
  const file = join("projects", `${id}-${slug(name)}.db`);
  admin.prepare("UPDATE projects SET file = ? WHERE id = ?").run(file, id);
  return getProject(id)!;
}

export function renameProject(id: number, name: string): void {
  admin.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
}

/** #107: 無効/有効の切り替え。隠すだけで実体は残る */
export function setProjectArchived(id: number, archived: boolean): void {
  admin.prepare("UPDATE projects SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
}

export function deleteProjectRow(id: number): void {
  admin.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function projectFilePath(p: ProjectRow): string {
  return join(DATA_DIR, p.file);
}

// 開いたハンドルは使い回す (better-sqlite3は同期APIなのでプロセス内で持てば足りる)
const handles = new Map<number, Database.Database>();

export function projectDb(id: number): Database.Database {
  const cached = handles.get(id);
  if (cached) return cached;
  const row = getProject(id);
  if (!row) throw new Error(`project #${id} not found`);
  const db = open(projectFilePath(row));
  ensureProjectSchema(db);
  handles.set(id, db);
  return db;
}

export function closeProjectDb(id: number): void {
  const h = handles.get(id);
  if (!h) return;
  h.close();
  handles.delete(id);
}

/** アクティブプロジェクト。サーバー側で1つだけ持つ (MCP・チャットのツール契約に
 * project_id を足さないための選択。単一ユーザー運用+デモでの切り替え体験を優先) */
export function activeProjectId(): number {
  const v = admin.prepare("SELECT value FROM settings WHERE key = 'project.active'").get() as
    | { value: string }
    | undefined;
  const id = v ? Number(v.value) : NaN;
  if (Number.isFinite(id) && getProject(id)) return id;
  const list = listProjects();
  const first = list.find((p) => !p.archived) ?? list[0];
  if (!first) throw new Error("プロジェクトが1つもありません");
  return first.id;
}

// #98: 処理単位のプロジェクト上書き。
// MCPは接続URLでプロジェクトが決まる (#96) ため、「UIが表示中のプロジェクト」とは独立に
// 「この処理はどのプロジェクトに対するものか」を持てる必要がある。
const scope = new AsyncLocalStorage<number>();

/** fn の実行中だけ対象プロジェクトを固定する。非同期関数でも await の向こうまで維持される */
export function withProject<T>(id: number, fn: () => T): T {
  if (!getProject(id)) throw new Error(`project #${id} not found`);
  return scope.run(id, fn);
}

/** いまの処理が対象とするプロジェクト。上書きが無ければUIが表示中のもの */
export function currentProjectId(): number {
  return scope.getStore() ?? activeProjectId();
}

export function setActiveProjectId(id: number): void {
  if (!getProject(id)) throw new Error(`project #${id} not found`);
  admin
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('project.active', ?, datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(String(id));
  log("project", `active -> #${id} (${getProject(id)!.name})`);
}

/** #106追補: いま対象のプロジェクトDBへの書き込めない接続。LLMにSQLを書かせるための安全境界 */
const roHandles = new Map<number, Database.Database>();
export function projectReadonly(): Database.Database {
  const id = currentProjectId();
  let h = roHandles.get(id);
  if (!h) {
    const row = getProject(id);
    if (!row) throw new Error(`project #${id} not found`);
    projectDb(id); // ファイルとスキーマを確実に作ってから読み取り専用で開く
    h = new Database(projectFilePath(row), { readonly: true });
    roHandles.set(id, h);
  }
  return h;
}

/** いま操作対象のプロジェクトDB (処理単位の上書き > UIが表示中のもの) */
export function db(): Database.Database {
  return projectDb(currentProjectId());
}

export interface ProjectSummary {
  id: number;
  name: string;
  file: string;
  createdAt: string;
  active: boolean;
  /** #107: 無効。ドロップダウンには出さないが設定画面には出る */
  archived: boolean;
  openTasks: number;
  members: string[];
}

export function projectSummaries(): ProjectSummary[] {
  const activeId = activeProjectId();
  return listProjects().map((p) => {
    const pdb = projectDb(p.id);
    return {
      id: p.id,
      name: p.name,
      file: p.file,
      createdAt: p.created_at,
      active: p.id === activeId,
      archived: !!p.archived,
      openTasks: (
        pdb.prepare("SELECT COUNT(*) AS c FROM tasks WHERE archived = 0 AND status != 'done'").get() as { c: number }
      ).c,
      members: (pdb.prepare("SELECT name FROM members ORDER BY id").all() as { name: string }[]).map((m) => m.name),
    };
  });
}

/** 新規プロジェクト。メンバーはこのプロジェクトのDBに入る (プロジェクトごとの参加者) */
export function createProjectWithMembers(name: string, memberNames: string[] = []): ProjectRow {
  const p = insertProject(name);
  const pdb = projectDb(p.id);
  const ins = pdb.prepare("INSERT OR IGNORE INTO members (name, skills) VALUES (?, NULL)");
  for (const n of memberNames.map((s) => s.trim()).filter(Boolean)) ins.run(n);
  log("project", `created #${p.id} ${name} (members: ${memberNames.join(", ") || "なし"})`);
  return p;
}

export function setProjectMembers(id: number, memberNames: string[]): void {
  const pdb = projectDb(id);
  const names = memberNames.map((s) => s.trim()).filter(Boolean);
  pdb.transaction(() => {
    // 既存担当者として使われている名前は消さない (タスクのassigneeは文字列なので孤児になる)
    const inUse = new Set(
      (pdb.prepare("SELECT DISTINCT assignee FROM tasks WHERE assignee IS NOT NULL").all() as { assignee: string }[]).map(
        (r) => r.assignee
      )
    );
    for (const r of pdb.prepare("SELECT id, name FROM members").all() as { id: number; name: string }[]) {
      if (!names.includes(r.name) && !inUse.has(r.name)) pdb.prepare("DELETE FROM members WHERE id = ?").run(r.id);
    }
    const ins = pdb.prepare("INSERT OR IGNORE INTO members (name, skills) VALUES (?, NULL)");
    for (const n of names) ins.run(n);
  })();
}

/** 削除はファイルを消さず data/trash/ へ退避する (実録データを扱うので取り返しがつく形にする) */
export function trashProject(id: number): void {
  if (listProjects().length <= 1) throw new Error("最後のプロジェクトは削除できません");
  if (id === activeProjectId()) throw new Error("表示中のプロジェクトは削除できません (先に切り替えてください)");
  const row = getProject(id);
  if (!row) throw new Error(`project #${id} not found`);
  closeProjectDb(id);
  const src = projectFilePath(row);
  const trashDir = join(DATA_DIR, "trash");
  mkdirSync(trashDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  for (const sfx of ["", "-wal", "-shm"]) {
    if (existsSync(src + sfx)) renameSync(src + sfx, join(trashDir, `${id}-${stamp}.db${sfx}`));
  }
  deleteProjectRow(id);
  log("project", `trashed #${id} ${row.name} -> data/trash/`);
}

// --- 旧構成 (backend/chatban.db 単一ファイル) からの移行 -------------------

/** 起動時に一度だけ: 旧 chatban.db があればプロジェクト1として取り込む。
 * llm_calls だけは管理DBへ移す (コストは口座単位で見るため) */
export function migrateLegacyDbIfNeeded(): void {
  if (listProjects().length > 0) return;

  const legacy = process.env.DB_PATH ?? "chatban.db";
  if (!existsSync(legacy)) {
    // まっさらな環境: 既定のプロジェクトを1つ作るだけ
    const p = insertProject("マイプロジェクト");
    projectDb(p.id);
    setActiveProjectId(p.id);
    log("project", `initialized empty project #${p.id}`);
    return;
  }

  const p = insertProject("ChatBan開発");
  const dest = projectFilePath(p);
  mkdirSync(PROJECT_DIR, { recursive: true });
  // WALを畳んでから移動する (-wal/-shm を持ち歩かなくて済む)
  const src = open(legacy);
  src.pragma("wal_checkpoint(TRUNCATE)");
  src.close();
  renameSync(legacy, dest);
  for (const sfx of ["-wal", "-shm"]) {
    if (existsSync(legacy + sfx)) renameSync(legacy + sfx, dest + sfx);
  }

  const pdb = projectDb(p.id);
  // llm_calls を管理DBへ引っ越す (プロジェクトDB側からは落とす)
  const rows = pdb
    .prepare(
      "SELECT purpose, model, routed_model, prompt_tokens, completion_tokens, cached_tokens, elapsed_ms, created_at FROM llm_calls ORDER BY id"
    )
    .all() as any[];
  const ins = admin.prepare(
    "INSERT INTO llm_calls (purpose, model, routed_model, prompt_tokens, completion_tokens, cached_tokens, elapsed_ms, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  admin.transaction(() => {
    for (const r of rows) {
      ins.run(
        r.purpose,
        r.model,
        r.routed_model,
        r.prompt_tokens,
        r.completion_tokens,
        r.cached_tokens ?? 0,
        r.elapsed_ms,
        p.id,
        r.created_at
      );
    }
  })();
  // 旧 settings も引き継ぐ (モデル設定はアプリ全体の設定として管理DBへ)
  try {
    const s = pdb.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const insS = admin.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    for (const r of s) insS.run(r.key, r.value);
  } catch {
    /* 旧DBにsettingsが無い場合 */
  }
  // 管理DBへ移したもの / プロジェクトDBに居るべきでないものを落とす
  // (projects・project_members は project_id 方式を試した名残。空のまま残っている)
  pdb.exec(
    "DROP TABLE IF EXISTS llm_calls; DROP TABLE IF EXISTS settings; DROP TABLE IF EXISTS projects; DROP TABLE IF EXISTS project_members;"
  );
  setActiveProjectId(p.id);
  log("project", `migrated legacy ${legacy} -> ${dest} (llm_calls ${rows.length}件を管理DBへ)`);
}

/** 起動時に孤児ファイルを拾わないための健全性チェック (ログのみ) */
export function reportOrphanFiles(): void {
  if (!existsSync(PROJECT_DIR)) return;
  const known = new Set(listProjects().map((p) => p.file.replace(/^projects[\\/]/, "")));
  const orphans = readdirSync(PROJECT_DIR).filter((f) => f.endsWith(".db") && !known.has(f));
  if (orphans.length > 0) log("project", `管理DBに登録のないDBファイル: ${orphans.join(", ")}`);
}
