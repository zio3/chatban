import { getProjectContext, listTasks } from "./db.js";
import { currentProjectId } from "./store.js";
import { log } from "./log.js";

// #50: イベントログ型プロンプト + TTL意識の再ベースライン (docs/cost-engineering-log.md)
// プロンプトキャッシュはプレフィックス一致なので、ボード状態を「基準スナップショット(不変) + 変更イベントの追記」で
// 表現し、連続リクエスト間でプレフィックスをバイト単位で安定させる。
// キャッシュTTL(OpenAI公称5〜10分)を過ぎたら次のリクエストはどうせコールドなので、その瞬間に再ベースライン(圧縮)する。
// 「生データは保持し、文脈に載せるものは蒸留し、蒸留のタイミングはコスト境界で決める」原則の3回目の適用。

const TTL_MS = 5 * 60 * 1000; // これを超えて間が空いたら再ベースライン
const MAX_EVENTS = 40; // イベントが溜まりすぎたら再ベースライン (差分適用の負担が基準の鮮度を上回る前に畳む)

interface Snapshot {
  tasks: Map<number, string>; // id -> 索引JSON
  projectContext: string;
  date: string; // 日付が変わったら再ベースライン (「今日」がプレフィックスに入るため)
}

interface State {
  baselineText: string; // プロンプトに載る基準スナップショット (再ベースラインまでバイト不変)
  lastSeen: Snapshot | null; // 直近リクエストでプロンプトに反映済みの状態 (差分計算の基準)
  events: string[];
  lastRequestAt: number;
}

// #119: プロジェクトごとに持つ。以前はモジュール変数1組だったため、
// あるプロジェクトで作った基準スナップショットが別プロジェクトのチャットにそのまま載っていた
// (前提情報が空のプロジェクトで、別プロジェクトの前提情報を喋る)。
// #97 でタブごとに別プロジェクトを開けるようにした時点で、1組では表現できなくなっていた。
// 「サーバー側に隠れた"いま見ているもの"を持たない」(#97) がプロンプト側だけ守れていなかった
const states = new Map<number, State>();

function state(): State {
  const id = currentProjectId();
  let st = states.get(id);
  if (!st) {
    st = { baselineText: "", lastSeen: null, events: [], lastRequestAt: 0 };
    states.set(id, st);
  }
  return st;
}

/** #86: プロジェクトの中身が総取っ替えになったときに呼ぶ。差分イベントでは表現できないので、
 * 次のリクエストで基準スナップショットを作り直させる */
export function resetPromptState(): void {
  states.clear();
}

function todayLabel(): string {
  return new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
}

function capture(): Snapshot {
  const tasks = new Map(
    listTasks().map((t) => [
      t.id,
      JSON.stringify({
        id: t.id,
        title: t.title,
        status: t.status,
        ...(t.due ? { due: t.due } : {}),
        ...(t.blockedBy?.length ? { dep: t.blockedBy } : {}),
        ...(t.rejected ? { rejected: true } : {}),
        ...(t.context ? { hasContext: true } : {}),
      }),
    ])
  );
  return { tasks, projectContext: getProjectContext() ?? "", date: todayLabel() };
}

function buildBaselineText(s: Snapshot): string {
  return [
    `## 今日: ${s.date}`,
    s.projectContext ? `## プロジェクトの前提情報 (全員共有)\n${s.projectContext}\n` : "",
    "## ボードの索引 — 基準スナップショット (status: todo=未着手, inprogress=作業中, review=レビュー中, done=完了)",
    "タイトルは要約品質。詳細(割り振り理由・経緯メモ)が必要なら query_log で取る (SELECT context FROM tasks WHERE id=...)。完了タスクは自動アーカイブされここには載らない。",
    "後続に「変更イベント」がある場合、この索引にそれを適用した状態が現在のボードである。",
    `[${[...s.tasks.values()].join(",")}]`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** ボード状態のプロンプトセクションを返す。プレフィックス安定性を保つため、
 * 温かい間は基準スナップショット+イベント追記のみ、コールド時は再ベースラインする */
export function getBoardPromptSection(): string {
  const st = state();
  const now = Date.now();
  const needRebase =
    !st.lastSeen || now - st.lastRequestAt > TTL_MS || st.events.length > MAX_EVENTS || st.lastSeen.date !== todayLabel();
  st.lastRequestAt = now;

  if (needRebase) {
    st.lastSeen = capture();
    st.baselineText = buildBaselineText(st.lastSeen);
    st.events = [];
    log("prompt", `rebaseline (project #${currentProjectId()}): tasks=${st.lastSeen.tasks.size}`);
    return st.baselineText;
  }

  // 前回反映済み状態との差分をイベントとして追記 (チャット外のREST/MCP起因の変更もここで拾える)
  const seen = st.lastSeen!; // needRebase=false の分岐なので非null
  const cur = capture();
  const fresh: string[] = [];
  for (const [id, json] of cur.tasks) {
    const prev = seen.tasks.get(id);
    if (prev === undefined) fresh.push(`+ ${json}`);
    else if (prev !== json) fresh.push(`~ ${json}`);
  }
  for (const id of seen.tasks.keys()) {
    if (!cur.tasks.has(id)) fresh.push(`- #${id} (完了アーカイブまたは削除)`);
  }
  if (cur.projectContext !== seen.projectContext) {
    fresh.push(`前提情報の全文更新: ${cur.projectContext}`);
  }
  if (fresh.length > 0) {
    st.events.push(...fresh);
    st.lastSeen = cur;
  }

  if (st.events.length === 0) return st.baselineText;
  return `${st.baselineText}\n\n## 変更イベント (基準スナップショット以降の差分。+=追加 ~=変更 -=消滅。適用後が現在の状態)\n${st.events
    .map((e) => `- ${e}`)
    .join("\n")}`;
}
