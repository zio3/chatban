import { getProjectContext, listSummaryCards, listTasks } from "./db.js";
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
  cards: Map<number, string>; // id -> 要約カードJSON
  projectContext: string;
  date: string; // 日付が変わったら再ベースライン (「今日」がプレフィックスに入るため)
}

let baselineText = ""; // プロンプトに載る基準スナップショット (再ベースラインまでバイト不変)
let lastSeen: Snapshot | null = null; // 直近リクエストでプロンプトに反映済みの状態 (差分計算の基準)
let events: string[] = [];
let lastRequestAt = 0;

/** #86: プロジェクト切り替え時に呼ぶ。ボードが総取っ替えになるので差分イベントでは表現できない
 * (次のリクエストで基準スナップショットを作り直させる) */
export function resetPromptState(): void {
  lastSeen = null;
  events = [];
  baselineText = "";
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
        assignee: t.assignee,
        ...(t.due ? { due: t.due } : {}),
        ...(t.blockedBy?.length ? { dep: t.blockedBy } : {}),
        ...(t.rejected ? { rejected: true } : {}),
        ...(t.context ? { hasContext: true } : {}),
      }),
    ])
  );
  const cards = new Map(
    listSummaryCards().map((c) => [
      c.id,
      JSON.stringify({ id: c.id, title: c.title, elements: c.elements.map((e) => e.text) }),
    ])
  );
  return { tasks, cards, projectContext: getProjectContext() ?? "", date: todayLabel() };
}

function buildBaselineText(s: Snapshot): string {
  return [
    `## 今日: ${s.date}`,
    s.projectContext ? `## プロジェクトの前提情報 (全員共有)\n${s.projectContext}\n` : "",
    "## ボードの索引 — 基準スナップショット (status: todo=未着手, inprogress=作業中, review=レビュー中, done=完了)",
    "タイトルは要約品質。詳細(割り振り理由・経緯メモ)が必要なら get_task_details で取る。完了タスクは自動アーカイブされここには載らない。",
    "後続に「変更イベント」がある場合、この索引にそれを適用した状態が現在のボードである。",
    `[${[...s.tasks.values()].join(",")}]`,
    "",
    s.cards.size > 0
      ? `## アーカイブ要約 (過去の完了の蒸留。過去の作業について聞かれたらここを参照)\n[${[...s.cards.values()].join(",")}]`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** ボード状態のプロンプトセクションを返す。プレフィックス安定性を保つため、
 * 温かい間は基準スナップショット+イベント追記のみ、コールド時は再ベースラインする */
export function getBoardPromptSection(): string {
  const now = Date.now();
  const needRebase =
    !lastSeen || now - lastRequestAt > TTL_MS || events.length > MAX_EVENTS || lastSeen.date !== todayLabel();
  lastRequestAt = now;

  if (needRebase) {
    lastSeen = capture();
    baselineText = buildBaselineText(lastSeen);
    events = [];
    log("prompt", `rebaseline: tasks=${lastSeen.tasks.size} cards=${lastSeen.cards.size}`);
    return baselineText;
  }

  // 前回反映済み状態との差分をイベントとして追記 (チャット外のREST/MCP起因の変更もここで拾える)
  const seen = lastSeen!; // needRebase=false の分岐なので非null
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
  for (const [id, json] of cur.cards) {
    if (seen.cards.get(id) !== json) fresh.push(`要約カード更新: ${json}`);
  }
  for (const id of seen.cards.keys()) {
    if (!cur.cards.has(id)) fresh.push(`要約カード#${id}は統合され消滅`);
  }
  if (cur.projectContext !== seen.projectContext) {
    fresh.push(`前提情報の全文更新: ${cur.projectContext}`);
  }
  if (fresh.length > 0) {
    events.push(...fresh);
    lastSeen = cur;
  }

  if (events.length === 0) return baselineText;
  return `${baselineText}\n\n## 変更イベント (基準スナップショット以降の差分。+=追加 ~=変更 -=消滅。適用後が現在の状態)\n${events
    .map((e) => `- ${e}`)
    .join("\n")}`;
}
