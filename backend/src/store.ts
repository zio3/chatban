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
  reason TEXT,
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
  frozen INTEGER NOT NULL DEFAULT 0,
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
  // #108: Doneへ確定した日時。「いつ終わったか」を持つ列がどこにも無く、
  // created_at(登録日) や summary_cards.created_at(#105の日次まとめで引き継がれる) では
  // 完了の集計ができなかった。SQL窓口にしたことで露呈した穴 —
  // 固定集計のツールでは聞ける質問が決まっているので見えなかった。
  addColumn("ALTER TABLE tasks ADD COLUMN done_at TEXT");
  // 列を作る前に終わったものは updated_at で埋める。完了後に触らなければ
  // 最終更新 ≒ 完了日時になるため (実データで確認: アーカイブ済み89件が14通りの時刻に散り、
  // 検収バッチの単位と一致していた。#105の日次まとめは summary_card_id しか書き換えないので
  // updated_at は潰れていない)。近似値だが、null のまま「不明」にするより答えられることが増える。
  // 何度流しても既に入っている行は触らないので、DBを開くたびに走って構わない
  db.exec("UPDATE tasks SET done_at = updated_at WHERE done_at IS NULL AND (status = 'done' OR archived = 1)");
  // #115/#116: 前提情報も全文上書きなので、タスクの経緯メモ(#112)と同じく版で守る。
  // こちらの方が失うものが大きい — プロジェクト全員の前提で、チャットのシステムプロンプトに常時載る
  addColumn("ALTER TABLE project_context ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  // settled → frozen。名前が実態から2回ズレていた:
  //   #58以前: Doneカードに人間がチェックを付け、全部付いたら「確認済み=settled」
  //   #58:     チェックボックス廃止 (検収がReview側に移った) → 引き金は手動整頓だけに
  //   #105:    カードがバッチごとに分かれ、settledは「日次まとめの対象外」の意味も持った
  // 「人が確認した」だったものが「もう育たない」になったのに、名前だけ残っていた。
  // 作った本人(zio)も外部エージェントも意味を取り違えたので、実態に名前を合わせる。
  // #92(reasonの用途が分からず汚された)と同型だが、今回は書いた本人にも分からなくなっていた
  try {
    const cols = (db.prepare("PRAGMA table_info(summary_cards)").all() as any[]).map((c) => c.name);
    if (cols.includes("settled") && !cols.includes("frozen")) {
      db.exec("ALTER TABLE summary_cards RENAME COLUMN settled TO frozen");
      log("schema", "summary_cards.settled を frozen に改名しました");
    }
  } catch (e: any) {
    log("schema", `summary_cards.settled の改名に失敗: ${e?.message ?? e}`);
  }
  addColumn("ALTER TABLE summary_cards ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0");
  addColumn("ALTER TABLE chat_messages ADD COLUMN task_id INTEGER");
  // #126: 誰の発言かを記録する。監査ログは「何をしたか」だけでなく「誰が言ったか」が要る。
  // speaker=表示名 / speaker_email=ログイン済みのときだけ入る本人確認済みのアドレス。
  // 両方持つのは、ログイン必須で展開する場合と、自分ひとりでログインなしで使う場合の
  // 両睨みにするため — 認証があれば確かな発言者、無ければ自己申告と分かる形で残す
  // #126: reason を任意にする。裏付けの無い理由を作らせるくらいなら理由なしで提案させたい。
  // 既存DBの列は NOT NULL のままなので作り直す (提案は承認/却下で消える一時データなので、
  // pending だけ引き継げば実害がない)
  try {
    const notNull = (db.prepare("PRAGMA table_info(proposals)").all() as any[]).some(
      (c) => c.name === "reason" && c.notnull === 1
    );
    if (notNull) {
      db.exec(`
CREATE TABLE proposals_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  assignee TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
INSERT INTO proposals_new (id, task_id, assignee, reason, status, created_at)
  SELECT id, task_id, assignee, reason, status, created_at FROM proposals;
DROP TABLE proposals;
ALTER TABLE proposals_new RENAME TO proposals;`);
      log("schema", "proposals.reason を任意に作り直しました (#126)");
    }
  } catch (e: any) {
    log("schema", `proposals の作り直しに失敗: ${e?.message ?? e}`);
  }
  addColumn("ALTER TABLE chat_messages ADD COLUMN speaker TEXT");
  addColumn("ALTER TABLE chat_messages ADD COLUMN speaker_email TEXT");

  // 「生きているタスク」をVIEWにする。外部エージェントからの指摘 —
  // 「archived=0 AND trashed_at IS NULL ORDER BY COALESCE(sort,id), id を毎回コピーしている。
  //  忘れるとゴミ箱のタスクが混ざる。ビューが1つあるだけで済む話」。
  //
  // list_tasks を消してSQL窓口に寄せたとき(#108)、母集団の条件は説明文で教えれば足りると
  // 判断したが、毎回書かせるのは手抜きだった。「読みは教育で守る」の教育コストを、
  // 教える側ではなくスキーマ側で払う。書き込みは相変わらずサーバー実装が強制する(非対称のまま)。
  //
  // 列を足したときに古い定義が残らないよう、毎回作り直す(VIEWは実体を持たないので安全)。
  // sort_key は COALESCE(sort,id) をそのまま出したもの。ORDER BY を書き忘れても
  // VIEW 側の並びで返るが、明示したいときはこの列を使える
  // 完了したものだけを見るビュー。live_tasks の対になる (生きている / 終わった)。
  //
  // 説明で教えて漏れた罠を構造で消す。query_log の説明に「完了の集計には done_at を使う
  // (created_at だと登録日を数えてしまう)」と書いてあるのに、実測のクエリ25本のうち1本が
  //   SELECT date(created_at) d, COUNT(*) n FROM tasks WHERE archived=1 ...
  // を投げていた。done_day を先に出しておけば date() すら書かなくてよく、
  // そもそも created_at を完了日と取り違える余地がなくなる。
  //
  // ビューを増やすほど「どれを使うか」の判断が増えるので、2本(生きている/終わった)で止める
  db.exec(`
DROP VIEW IF EXISTS done_tasks;
CREATE VIEW done_tasks AS
  SELECT id, title, assignee, assign_reason, summary, rejected, checked_at, done_at,
         date(done_at) AS done_day, summary_card_id, created_at
    FROM tasks
   WHERE done_at IS NOT NULL
   ORDER BY done_at DESC;`);

  db.exec(`
DROP VIEW IF EXISTS live_tasks;
CREATE VIEW live_tasks AS
  SELECT id, status, title, assignee, assign_reason, summary, context, context_version,
         due, blocked_by, rejected, checked_at, done_at, sort, COALESCE(sort, id) AS sort_key,
         created_at, updated_at
    FROM tasks
   WHERE archived = 0 AND trashed_at IS NULL
   ORDER BY COALESCE(sort, id), id;`);
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

/** #107: 無効/有効の切り替え。隠すだけで実体は残る。
 *
 * **既定 (active) のプロジェクトは無効にできない。** activeProjectId() は archived を見ないので、
 * 無効にするとドロップダウンからは消えるのに既定のまま残り、
 * ヘッダ指定のないREST操作やSocketの追従先として書き込まれ続ける。
 * さらに trashProject が active を弾くので削除もできない —
 * **見えない・消せない・でも書き込まれる**状態が作れてしまう (自動コードレビュー指摘)。
 *
 * 削除と同じ形で断る。隠す操作と消す操作で「既定は触れない」の扱いが割れているほうが不自然 */
export function setProjectArchived(id: number, archived: boolean): void {
  if (archived && id === activeProjectId())
    throw new Error(
      "既定のプロジェクトは無効にできません。ヘッダ指定のない操作の行き先として使われるため、一覧から消すと辿れなくなります"
    );
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

/** そのプロジェクトへの接続を全部閉じる。
 *
 * 読み書き用 (handles) だけを閉じていたので、**SQL窓口で一度でも監査クエリを流した
 * プロジェクトは削除できなくなっていた** (自動レビュー指摘)。projectReadonly() が
 * 別の Map (roHandles) にハンドルを持ち続け、Windowsでは開いたままのSQLiteファイルを
 * renameSync できず EBUSY になる。プロセスを再起動するまで復旧しない。
 *
 * 「接続を1つ足したら、閉じる側にも足す」を忘れると、Windowsでだけ壊れる。
 * 開ける場所が2つあるなら閉じる場所も2つ要る */
export function closeProjectDb(id: number): void {
  for (const map of [handles, roHandles]) {
    const h = map.get(id);
    if (h) {
      h.close();
      map.delete(id);
    }
  }
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
  const row = getProject(id);
  if (!row) throw new Error(`project #${id} not found`);
  // 無効化済み (ドロップダウンに出ない) ものを既定にしない。
  // setProjectArchived 側で「既定は無効にできない」を塞いだが、**順序を入れ替えれば同じ状態が作れた**
  // (先に無効化 → activate)。「見えない・消せない・でも書き込まれる」は入口ごとに塞ぐのではなく、
  // 「既定 かつ 無効」という組み合わせ自体を作らせない (自動レビュー指摘)
  if (row.archived)
    throw new Error("無効になっているプロジェクトは既定にできません (先に有効へ戻してください)");
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
  /** #117: このプロジェクト用のMCP接続先 (.mcp.json に貼る) */
  mcpUrl: string;
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
      // #117: MCPの接続先。プロジェクトはURLで固定する設計(#96)なので、
      // .mcp.json に貼る値をプロジェクトごとに出す。ポートを知っているのはサーバー側
      mcpUrl: `http://localhost:${process.env.PORT ?? 8787}/mcp/${p.id}`,
      // ゴミ箱を数えない (ボードから消えているのに件数が減らない、を防ぐ)。
      // 条件はボードの一覧と揃える — 母集団の条件を書き分けると必ずズレる
      openTasks: (
        pdb
          .prepare("SELECT COUNT(*) AS c FROM tasks WHERE archived = 0 AND status != 'done' AND trashed_at IS NULL")
          .get() as { c: number }
      ).c,
      members: (pdb.prepare("SELECT name FROM members ORDER BY id").all() as { name: string }[]).map((m) => m.name),
    };
  });
}

/** 新規プロジェクト。メンバーはこのプロジェクトのDBに入る (プロジェクトごとの参加者) */
/** #115/#116: 新規プロジェクトの前提情報の下書き。
 * 列の意味と完了の条件はプロジェクトごとに違うのに、埋める枠が無いと誰も書かない。
 * 実例: あるプロジェクトは review=検収待ち、別のプロジェクトは review=相手待ち(返答・承認待ち)。
 * エージェントには列の enum しか見えないので、ここに書いてあることが唯一の手がかりになる。
 * 空欄のまま残っても害はない (「まだ決めていない」と読める) */
/** 新規プロジェクトの前提情報。空欄ではなく既定値を書いておく。
 *
 * 最初は空欄+ヒント(「reviewが検収待ちか相手待ちかはプロジェクトによる」)にしていたが、
 * 外部エージェントの指摘で分かった —「空欄には2種類あるのに、スキーマからは区別がつかない。
 * LLMは黙っていると『まだ入っていない』に倒す(空欄は埋めるもの、という強い癖)」。
 * 実際 review= の右が空白だったプロジェクトで、一般的な意味(PRレビュー待ち)に読まれた。
 *
 * 空欄を読ませると推測される。埋めておけば読み間違えようがない。
 * プロジェクトごとに本当に違うのは review の意味くらいなので、
 * 標準形を書いておいて「違うなら書き換える」と添えるほうが素直 (zio判断)。
 * ask ツールのときと同じで、プロンプトで「推測するな」と書いても効かない側の問題 */
export const CONTEXT_TEMPLATE = [
  "## このプロジェクトについて",
  "(何をするプロジェクトか、関係者、参照先など)",
  "",
  "## 列の意味",
  "- todo = これからやること",
  "- inprogress = 着手中。長くかかるものだけ置けばよく、着手のたびに動かさなくてよい",
  "- review = 検収待ち。作業が終わったらここに置く",
  "- done = 人間が実物で確かめたもの。AIからは付けられない",
  "",
  "※ このプロジェクトで意味が違うなら書き換える。例: review を「相手待ち(返答・承認・レビュー待ち)」として使うこともある。書き換えたらこの但し書きごと消すこと — 例が残っていると「このプロジェクトはどちらなのか」を考えさせる",
  "",
  "## 完了の条件",
  "作業が終わり、確かめる材料(実測結果・コミットID・スクショなど)を経緯メモに書いたら review に置く。",
  "done は人間の検収でのみ付く。",
  "",
  "## できなかったとき・やらないとき",
  "- 前提が足りず進められない → status は変えず、summary に「◯◯待ちで保留」と現況を書く",
  "- やらない決定 → rejected を立てて review に置く。判断した記録として残る",
  "- 誤登録・重複 → 削除する(ゴミ箱行きなので復元できる)",
  "",
  "## このプロジェクトで使わないもの",
  "(空欄には「まだ入っていない」と「ここでは使わない」の2種類があり、書いていないと前者に読まれて埋められる。使わないものはここに書く)",
  "(例) 担当者は割り当てない。一人で回すため",
  "",
].join("\n");

/** テンプレートに含まれる節。前提情報にこれらが揃っているかを見て、
 * 足りないときだけテンプレートを渡す (zio案「テンプレートリファレンスを取得できる形にして合成できるように」)。
 *
 * 必要になった理由: テンプレートは新規プロジェクトにしか入らないので、
 * テンプレートを直しても既存プロジェクトは取り残される。実際、今日2回直したが
 * 既存はどれも古いまま。「人間が全プロジェクトに手で流し込む」は続かない。
 * 常に渡すと600字が毎回乗るので、欠けているときだけ出す */
const TEMPLATE_SECTIONS = [
  "## 列の意味",
  "## 完了の条件",
  "## できなかったとき・やらないとき",
  "## このプロジェクトで使わないもの",
];

/** 前提情報の書き方のリファレンス。雛形ではなく「こういう使い方がある」のカタログで、
 * 自分のプロジェクトに合うものを選んで採る (zio案)。
 *
 * 雛形を配ると、そのまま書き戻されて全プロジェクトが同じ文面になる。実際に違うのは
 * 「reviewが何を意味するか」「何を使わないか」で、そこは選ぶしかない。
 * ChatBan自身の運用と、実在プロジェクトの実例から起こしてある */
const CONTEXT_REFERENCE = [
  "前提情報の書き方の参考。自分のプロジェクトに合うものを選んで採り、合わないものは書かない。",
  "",
  // 「リファレンスの例と、自分が前提情報に書いた方針がぶつかるので今のままにしてあります」
  // という報告を受けて追加。どちらが優先かをどこにも書いていなかった。
  // 答えは決まっていて (STATUS_DESCRIPTION に「前提情報の定義に従うこと」とある)、
  // 書いていなかっただけ。判断させずに名指しする
  "**ここに書いてあることと、いまの前提情報が食い違っていたら、前提情報が優先。** そのプロジェクトで決めたことのほうが具体的だから。参考に合わせて書き換えるのは、決め直したときだけ。",
  "",
  "## 列の使い方 (どれか選ぶ)",
  "- review = 検収待ち … 作業が終わったら置き、人間が実物で確かめて Done へ。開発・制作向き",
  "- review = 相手待ち … 自分の手を離れて相手の返答・承認・レビューを待っている状態。依頼や調整が多い仕事向き",
  "- inprogress を使わない … 着手中を管理しないなら todo → review だけで回る。長くかかるものだけ置く運用もある",
  "",
  "## 完了の条件 (例)",
  "- コミットIDと実測結果を経緯メモに書いたら review に置く",
  "- PRを作ったら review。マージは人間がする",
  "- 本番に出したが確かめられるのは来週 → それでも review に置き、summary に「水曜に確認」と書く",
  "",
  "## できなかったとき・やらないとき (例)",
  "- 前提が足りず進まない → status は動かさず、summary に「APIキー待ちで保留」と現況を書く",
  "- やらない決定 → rejected を立てて review。「やらないと決めた」も判断の記録として残す",
  "- 誤登録・重複 → 削除する(ゴミ箱行きなので戻せる)",
  "",
  "## summary の書き方 (どれか選ぶ)",
  "summary は「AIとユーザーに、極力短く、状況や次の判断を促す1行」。どんな判断を促したいかは仕事によって違う。",
  // 「実装完了」だけだと、読んだ人が確かめに行く先が無く、結局タスクを開くことになる。
  // 効いているのは確認先が付いていることなので、裸との対比で示す (指摘を受けて修正)
  "- 開発 … 裸の「実装完了」では足りない。「実装完了 (commit abc123)」「PR#42 レビュー待ち」のように確認先を添えると、そのまま検収の入口になる",
  "- 依頼・調整 … 「先方の返答待ち。8/15に来なければ再送」— 誰の手番で、いつ動くかを書く",
  "- 運用 … 「本番反映済み。水曜に実機で確認」— いつ確かめるかを書く",
  "",
  "## 経緯メモ(context)の書き方",
  "追記で積んでいく前提なら、末尾に「## 経過」を作る。前半(背景・決めたこと)は固定、経過だけが伸びる形にすれば context_append で1行ずつ足せる。",
  "節で細かく構造化する(【実測】【原因】【対処】など)と、追記が節の外に付いてしまい、毎回全文を書き直すことになる。",
  "",
  "## 使わないものの例",
  "- 担当者を使わない … 一人で回すプロジェクト。空欄が正常な状態であって欠落ではない",
  "- due を使わない … 締切のない継続業務。急ぎは並び順で表す",
  "- 依存(blocked_by)を使わない … 順番は並び順で表し、依存は「終わらないと着手できない」ものだけに使う",
  "",
  "## そのほか書いておくとよいこと",
  "- 関係者と、それぞれが何を見ているか",
  "- このプロジェクト特有の用語(略称・システム名)",
  "- 定例のタイミング(毎週の締め、リリース日)",
].join("\n");

/** 前提情報に足りない節を知らせる。何も足りなければ null (=何も渡さない)。
 *
 * リファレンス全文はここでは返さない。毎回の足場取得に乗せないため、
 * 「足りないものがある」とだけ言い、中身は reference=true で引かせる2段階にする (zio案)。 */
export function contextTemplateHint(text: string): { missing: string[]; note: string } | null {
  const missing = TEMPLATE_SECTIONS.filter((h) => !text.includes(h));
  if (missing.length === 0) return null;
  return {
    missing,
    note: "この前提情報には上の節が無い。get_project_context を reference=true で呼ぶと書き方の参考が取れるので、このプロジェクトに合うものを選んで足せる",
  };
}

export function contextReference(): string {
  return CONTEXT_REFERENCE;
}

export function createProjectWithMembers(name: string, memberNames: string[] = []): ProjectRow {
  const p = insertProject(name);
  const pdb = projectDb(p.id);
  const ins = pdb.prepare("INSERT OR IGNORE INTO members (name, skills) VALUES (?, NULL)");
  for (const n of memberNames.map((s) => s.trim()).filter(Boolean)) ins.run(n);
  pdb.prepare("INSERT OR IGNORE INTO project_context (id, text) VALUES (1, ?)").run(CONTEXT_TEMPLATE);
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

/** 取り込んでよい旧DBか。空ファイル・別物・壊れたファイルを移行対象にしない。
 * 判定は tasks テーブルの有無 — ChatBanのDBなら必ずあり、たまたま同名の別ファイルには無い */
function looksLikeChatBanDb(path: string): boolean {
  if (!existsSync(path)) return false;
  let probe: Database.Database | undefined;
  try {
    probe = new Database(path, { readonly: true });
    return !!probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
  } catch {
    return false; // SQLiteですらない・壊れている
  } finally {
    probe?.close();
  }
}

/** 起動時に一度だけ: 旧 chatban.db があればプロジェクト1として取り込む。
 * llm_calls だけは管理DBへ移す (コストは口座単位で見るため) */
export function migrateLegacyDbIfNeeded(): void {
  if (listProjects().length > 0) return;

  const legacy = process.env.DB_PATH ?? "chatban.db";

  // まっさらな環境: 既定のプロジェクトを1つ作るだけ
  const startEmpty = () => {
    const p = insertProject("マイプロジェクト");
    projectDb(p.id);
    setActiveProjectId(p.id);
    log("project", `initialized empty project #${p.id}`);
  };

  // **ファイルがあるだけでは取り込まない。**中身がChatBanのDBかを先に確かめる。
  //
  // 実際に踏んだ: 調査中に作られた0バイトの chatban.db が置かれていただけで、
  // 移行に入って rename を済ませたあと llm_calls の SELECT で落ち、**サーバーが起動しなくなった**。
  // しかも rename は済んでいるので、次の起動では legacy が無く「まっさら」扱いになる —
  // 1回だけ落ちて、症状が消える。原因に辿り着きにくい壊れ方だった。
  //
  // 「途中まで適用して失敗」を作らない (#120と同じ考え方)。動かす前に確かめる
  if (!looksLikeChatBanDb(legacy)) {
    if (existsSync(legacy))
      log("project", `${legacy} は取り込みませんでした (ChatBanのDBに見えません。tasks テーブルがありません)`);
    startEmpty();
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
  // llm_calls を管理DBへ引っ越す (プロジェクトDB側からは落とす)。
  // 無くても落とさない — ここで投げると、rename が済んだあとなので中途半端な状態で起動不能になる。
  // 隣の settings は最初から try で囲ってあったのに、こちらだけ無防備だった
  let rows: any[] = [];
  try {
    rows = pdb
      .prepare(
        "SELECT purpose, model, routed_model, prompt_tokens, completion_tokens, cached_tokens, elapsed_ms, created_at FROM llm_calls ORDER BY id"
      )
      .all() as any[];
  } catch {
    log("project", `${legacy} に llm_calls がありませんでした (コスト記録の引き継ぎはスキップします)`);
  }
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
