import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./log.js";
import { CONTEXT_TEMPLATE } from "./contextTemplate.js";

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
//   data/chatban-admin.db          projects / settings
//   data/projects/<id>-<slug>.db   tasks / summary_cards / chat_messages / project_context
//
// #179: members / proposals / assignment_history と tasks.assignee / assign_reason は
// 作るのをやめ、既存DBからも削除する (下の ensureProjectSchema 末尾)
// #181: 管理DBにあった llm_calls (LLM呼び出しの記録) と model_prices (料金表) も同様に落とす
// (下の ensureAdminSchema 末尾)。LLM呼び出しの記録は backend/logs/ の1行だけになった

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

  // #180: 認証の設定を消す。**特に auth.sessionSecret は平文のセッション署名鍵**で、
  // 読める相手は誰にでもなりすませた。使う側が消えたあとも残しておく理由が無い
  // (使われない秘密が置きっぱなしになるのが、いちばんよくある漏れ方)。
  // allowedEmails は個人のメールアドレスなので、記録に混ざらないよう一緒に落とす。
  //
  // #181: モデル設定 (model.main / archive / cheap) も消す。⚙設定タブを撤去して供給元が
  // env だけになったので、DBに残っていると**画面から変えられない値が実効値として優先され続ける**
  // (「設定したのに効かない」ではなく「消したのに効き続ける」ほうの事故)。
  //
  // 消えたときだけ記録する。**鍵の値そのものはログに出さない** (消した記録が漏洩経路になっては本末転倒)
  const purged = db.prepare("DELETE FROM settings WHERE key LIKE 'auth.%' OR key LIKE 'model.%'").run().changes;
  if (purged > 0) log("schema", `認証とモデルの設定 ${purged}件を削除しました (#180 / #181)`);

  // #181: 計測系のテーブルを落とす。llm_calls (呼び出しごとのトークン・単価・概算額) と
  // model_prices (182件の料金表)。**読まないだけにして残さない** — #179/#180 と同じ判断で、
  // スキーマに残るとSQL窓口を広げた誰かが集計に使い、廃止したはずの軸が復活する。
  // トークン・レイテンシは backend/logs/ に残るので、速度やキャッシュ効きの確認はログでできる
  const droppedTables: string[] = [];
  db.transaction(() => {
    for (const t of ["llm_calls", "model_prices"]) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t)) continue;
      db.exec(`DROP TABLE IF EXISTS ${t}`);
      droppedTables.push(t);
    }
  })();
  if (droppedTables.length > 0) log("schema", `${droppedTables.join(" / ")} を削除しました (#181 計測系の撤去)`);
}

// #106 → #181: 管理DBの readonly 接続 (adminReadonly) もここにあった。
// コスト分析のSQL窓口 (query_log の scope='cost') 専用だったので、計測系の撤去で用途を失った。
// **プロジェクト側の readonly 接続 (projectReadonly) は残る** — 安全境界そのものは変わらない

/** プロジェクトDBのスキーマ。DBを開くたびに流すので、新規作成と既存の移行が同じ経路になる
 * (EF Migration不使用の流儀: CREATE IF NOT EXISTS + ALTER の失敗は適用済みとして無視) */
export function ensureProjectSchema(db: Database.Database) {
  db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
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
  // #126 → #180: ここで speaker / speaker_email (誰の発言か) を足していた。
  // 個人利用に特化して発言者という概念ごと廃止したので、追加もしないし既存も落とす
  // (下の削除マイグレーション)

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
  SELECT id, title, summary, rejected, checked_at, done_at,
         date(done_at) AS done_day, summary_card_id, created_at
    FROM tasks
   WHERE done_at IS NOT NULL
   ORDER BY done_at DESC;`);

  db.exec(`
DROP VIEW IF EXISTS live_tasks;
CREATE VIEW live_tasks AS
  SELECT id, status, title, summary, context, context_version,
         due, blocked_by, rejected, checked_at, done_at, sort, COALESCE(sort, id) AS sort_key,
         created_at, updated_at
    FROM tasks
   WHERE archived = 0 AND trashed_at IS NULL
   ORDER BY COALESCE(sort, id), id;`);

  // #179: 担当者・割り振りを廃止 / #180: 認証を廃止。**列とテーブルごと落とす。**
  //
  // 読まないだけにして残す案を採らなかったのは、認証と同じ理由 —
  // 「開けられる」が残ると、いつか開ける日が来る。スキーマに列があれば、
  // SQL窓口 (query_log) を広げた誰かが集計に使い、廃止したはずの軸が復活する。
  //
  // **これは取り返しがつかない** (assignment_history は誰にどう振ったかの実録)。
  // 消してよいと確認した上でやっている (zio 2026-08-17)。
  // ゴミ箱 (#102) のような二段構えにはしない — 一度きりの片付けで、戻す運用が無い。
  //
  // **ビューの作り直しより後に置くこと。** SQLite は列がビューから参照されていると
  // DROP COLUMN を拒む。古い定義 (assignee を SELECT していたころのもの) が残ったままだと、
  // 列がいつまでも消えない。
  //
  // **addColumn は使わない。**あれは全例外を「適用済み」とみなして捨てるので、
  // 想定外の理由 (未知のindex・trigger・view からの参照など) で失敗しても起動は成功し、
  // 「列は残ったままテーブルだけ消えた」状態に静かに着地する。手元の13DBで成功したことは、
  // 未知の参照を持つDBで成功する保証にならない (自動レビュー指摘)。
  // 消えていないなら消えていないと言わせる
  //
  // **全部消えるか、何も消えないか。**列だけ残ってテーブルが消えた中途半端な状態を作らない
  // (途中で失敗しても、次の起動でもう一度そこから始められる)。
  // 列が消せないのに起動を続けると、**廃止したはずの軸がスキーマに残ったまま固定される** —
  // ログは誰も見ないので、部分適用に気づく機会が無い (自動レビュー指摘)。異常なので止める
  // **ログは transaction の外で出す。**中で出すと、後続のDDLが失敗して巻き戻ったあとも
  // 「削除しました」だけが残る (ログは即座にファイルへ書かれるが、DBは戻る)。
  // 異常を調べている人に「assignee は消したはずだ」と思わせるのが一番まずい (自動レビュー指摘)
  const dropped: string[] = [];
  db.transaction(() => {
    dropColumn("tasks", "assignee", dropped);
    dropColumn("tasks", "assign_reason", dropped);
    for (const t of ["members", "proposals", "assignment_history"]) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t)) continue;
      db.exec(`DROP TABLE IF EXISTS ${t}`);
      dropped.push(t);
    }
    // #180: 発言者。speaker_email は本人確認済みアドレスで、認証が無くなれば埋まる経路も無い。
    // speaker (自己申告の表示名) も一緒に落とす — 話しかけてくるのが持ち主ひとりなら、
    // 「誰が言ったか」の欄は常に同じ値か空になる (実測 null 554件 / "zio" 100件)。
    // 「認証を戻したときのために取っておく」もしない。戻さないと決めたのが #180 で、
    // 列だけ残すと「いつか入るかもしれない欄」になり、空欄の意味を説明し続けることになる (#92の教訓)
    dropColumn("chat_messages", "speaker_email", dropped);
    dropColumn("chat_messages", "speaker", dropped);
  })();
  // 消えたときだけ記録する。起動のたびに出しても意味がない
  if (dropped.length > 0) log("schema", `${dropped.join(" / ")} を削除しました (#179 担当者の廃止 / #180 認証の廃止)`);

  /** 列が実在するときだけ DROP し、**消えたことを確かめる**。
   * 無ければ何もしない (適用済み) / 消せなければ投げる (黙って通さない) */
  function dropColumn(table: string, column: string, out: string[]): void {
    const has = () => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
    if (!has()) return;
    try {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    } catch (e: any) {
      throw new Error(
        `${table}.${column} を削除できませんでした: ${e?.message ?? e}。` +
          `この列を参照している index / trigger / view が残っている可能性があります`
      );
    }
    if (has()) throw new Error(`${table}.${column} の削除が反映されていません`);
    out.push(`${table}.${column}`);
  }
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
  /** #117: このプロジェクト用のMCP接続先 (.mcp.json に貼る) */
  mcpUrl: string;
  /** #167: AI提案チップを出すか。デモ動画の撮影中は毎回違うチップが出ると撮り直しになるため切れるようにした */
  suggestEnabled: boolean;
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
      suggestEnabled: suggestEnabled(p.id),
    };
  });
}

/** #167: AI提案チップ(#75)を出すかどうか。プロジェクトごとに持つ。
 *
 * 動画を撮り直すたびに違うチップが出るので同じ画面をもう一度撮れない、という実務上の困りごとから。
 * プロジェクト単位にしたのは、撮影用プロジェクトだけ切っておけば開発用のタブは生かしたままにできるため
 * (タブごとに別プロジェクトを開ける #97)。
 *
 * 設定キーに projectId を含めるだけにして、テーブルは足していない。既定はON —
 * 設定が無いプロジェクト(新規作成された直後など)を勝手にOFFにしない */
// settings の読み書きは db.ts にも同じものがあるが、db.ts はこのファイルを import しているので
// ここから呼ぶと循環参照になる。admin を直接使う
const SUGGEST_KEY = (projectId: number) => `suggest.enabled.${projectId}`;

export function suggestEnabled(projectId: number): boolean {
  const r = admin.prepare("SELECT value FROM settings WHERE key = ?").get(SUGGEST_KEY(projectId)) as
    | { value: string }
    | undefined;
  return r?.value !== "0";
}

export function setSuggestEnabled(projectId: number, enabled: boolean): void {
  // OFFのときだけ書き、ONに戻したら消す。既定(ON)の行をDBに残さないので、
  // settings を見たときに「意図して切っているプロジェクト」だけが並ぶ
  if (enabled) admin.prepare("DELETE FROM settings WHERE key = ?").run(SUGGEST_KEY(projectId));
  else
    admin
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, '0', datetime('now', 'localtime')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(SUGGEST_KEY(projectId));
}

/** #115/#116: 新規プロジェクトの前提情報の下書き。
 * 列の意味と完了の条件はプロジェクトごとに違うのに、埋める枠が無いと誰も書かない。
 * 実例: あるプロジェクトは review=検収待ち、別のプロジェクトは review=相手待ち(返答・承認待ち)。
 * エージェントには列の enum しか見えないので、ここに書いてあることが唯一の手がかりになる。
 * 空欄のまま残っても害はない (「まだ決めていない」と読める) */

export function createProject(name: string): ProjectRow {
  const p = insertProject(name);
  projectDb(p.id).prepare("INSERT OR IGNORE INTO project_context (id, text) VALUES (1, ?)").run(CONTEXT_TEMPLATE);
  log("project", `created #${p.id} ${name}`);
  return p;
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

/** まっさらな環境なら、既定のプロジェクトを1つ作る。
 *
 * #179 で旧DBの移行コードを消したとき、この初期化がその関数に同居していたため
 * 一緒に消えてしまい、**空の data ディレクトリでサーバーが起動しなくなった**
 * (activeProjectId が「プロジェクトが1つもありません」で落ちる)。E2Eは毎回
 * データを消してから起動するので、52件が丸ごと落ちて気づいた。
 *
 * 移行と初期化は別の責務。片方を消してももう片方が残る形にしておく */
export function ensureInitialProject(): void {
  if (listProjects().length > 0) return;
  // #179: 旧構成 (単一の chatban.db) からの移行は撤去した。**取り込まないこと自体は決定事項**だが、
  // 中身のあるDBが転がっているのに黙って空ボードを出すと、利用者からは「データが消えた」に見える。
  // 消えていないことと、原本の場所は言う (自動レビュー指摘)
  const legacy = process.env.DB_PATH ?? "chatban.db";
  if (existsSync(legacy)) {
    log(
      "project",
      `${legacy} を見つけましたが取り込みません (#179で旧構成からの移行は廃止)。原本はそのまま残っています。` +
        `中身が必要なら 2026-08-17 より前の版で一度起動して data/ 形式へ移してから上げ直してください`
    );
  }
  const p = insertProject("マイプロジェクト");
  projectDb(p.id); // ここで ensureProjectSchema が当たる
  setActiveProjectId(p.id);
  log("project", `initialized empty project #${p.id}`);
}

/** 起動時に孤児ファイルを拾わないための健全性チェック (ログのみ) */
export function reportOrphanFiles(): void {
  if (!existsSync(PROJECT_DIR)) return;
  const known = new Set(listProjects().map((p) => p.file.replace(/^projects[\\/]/, "")));
  const orphans = readdirSync(PROJECT_DIR).filter((f) => f.endsWith(".db") && !known.has(f));
  if (orphans.length > 0) log("project", `管理DBに登録のないDBファイル: ${orphans.join(", ")}`);
}
