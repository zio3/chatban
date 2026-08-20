import { getProjectContext, listTasks } from "./db.js";
import type { Task } from "./types.js";
import { currentProjectId, customLanes } from "./store.js";
import { log } from "./log.js";

// #50: イベントログ型プロンプト + TTL意識の再ベースライン (docs/cost-engineering-log.md)
// プロンプトキャッシュはプレフィックス一致なので、ボード状態を「基準スナップショット(不変) + 変更イベントの追記」で
// 表現し、連続リクエスト間でプレフィックスをバイト単位で安定させる。
// キャッシュTTL(OpenAI公称5〜10分)を過ぎたら次のリクエストはどうせコールドなので、その瞬間に再ベースライン(圧縮)する。
// 「生データは保持し、文脈に載せるものは蒸留し、蒸留のタイミングはコスト境界で決める」原則の3回目の適用。

const TTL_MS = 5 * 60 * 1000; // これを超えて間が空いたら再ベースライン
const MAX_EVENTS = 40; // イベントが溜まりすぎたら再ベースライン (差分適用の負担が基準の鮮度を上回る前に畳む)

interface Snapshot {
  cards: Map<number, string>; // id -> 索引JSON
  projectContext: string;
  // #19: 任意レーンの表示名。**基準スナップショットの一部**にしてある —
  // 名前を変えたら索引の説明文も変わるので、変えた瞬間に再ベースラインが要る
  lanes: string;
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

/** 索引に載せる summary の上限。**書き込み側には制限が無い**ので、ここで持つ (Codexレビュー指摘)。
 *
 * 守っているのは「プロンプトが無制限に太らないこと」であって、データの妥当性ではない。
 * 長い summary をDBに持つこと自体は害ではない (画面には全文が出るし、query_log でも読める) —
 * 困るのは**それが毎リクエストのプロンプトに入り、変更のたびに `~` イベントにも載る**こと。
 * だから境界はプロンプト側に置く。書き込みで拒否すると、既に長い summary を持つDBが
 * 更新できなくなり移行が要る (守りたいものに対して代償が大きい)。
 *
 * 120字の根拠: 実測 (2026-08-21) で18枚の最長が60字、平均40字。**通常運用では発火しない**大きさに置き、
 * 異常な入力だけを止める。切ったことは「…」で分かるようにする — 索引の説明が
 * 「詳細が必要なら query_log で取る」と案内しているので、全文が要るなら取りに行ける */
const SUMMARY_MAX = 120;
export function clampSummary(s: string): string {
  return s.length <= SUMMARY_MAX ? s : `${s.slice(0, SUMMARY_MAX)}…`;
}

/** 索引1件ぶん。**DBに触らない純粋関数**にしてあるのはテストのため
 * (ここに何が載るかは契約そのもので、載り忘れても画面もテストも落ちない)。
 *
 * #221: **summary を載せていなかった。**ツール契約 (SUMMARY_DESCRIPTION) は
 * 「カードに出るだけでなく、**ボードのチャットが常時これを読んで受け答えする**」と
 * 約束しているのに、索引に無いのでチャットは query_log を叩かない限り現況を知らなかった。
 * MCP側 (boardState.ts の TaskFacts) には入っていたので、**外部エージェントには見えていて
 * ボードのチャットだけ見えていない**という非対称になっていた。
 *
 * 実測して載せると決めた (2026-08-21): 18枚で725字・平均40字・最長60字、
 * JSONのキー込みで約940字 (プロンプト全体の+13%)。
 *
 * **上限は clampSummary で持つ (先頭120字 + 「…」)。**当初は「契約が『極力短く』なので
 * 設計上暴れない」と考えて上限を置かなかったが、**書き込み側に長さ制限が無い**ので
 * それは保証にならなかった (Codexレビュー指摘)。切られた場合、確認先 (「(commit abc123)」) は
 * 末尾なので失われる — その分は経緯メモと query_log 側で取る前提にしてある。
 *
 * 値が空のものは載せない (due / dep / rejected と同じ扱い)。キーが増えるほど
 * 索引は太るので、「無い」ことは書かずに黙っている */
export function cardIndexJson(
  t: Pick<Task, "id" | "title" | "status" | "summary" | "due" | "blockedBy" | "rejected" | "context">
): string {
  return JSON.stringify({
    id: t.id,
    title: t.title,
    status: t.status,
    ...(t.summary ? { summary: clampSummary(t.summary) } : {}),
    ...(t.due ? { due: t.due } : {}),
    ...(t.blockedBy?.length ? { dep: t.blockedBy } : {}),
    ...(t.rejected ? { rejected: true } : {}),
    ...(t.context ? { hasContext: true } : {}),
  });
}

function capture(): Snapshot {
  const cards = new Map(listTasks().map((t) => [t.id, cardIndexJson(t)]));
  return {
    cards,
    projectContext: getProjectContext() ?? "",
    date: todayLabel(),
    lanes: customLanes()
      .map((l) => `${l.key}=${l.label}`)
      .join(","),
  };
}

function buildBaselineText(s: Snapshot): string {
  return [
    `## 今日: ${s.date}`,
    s.projectContext ? `## プロジェクトの前提情報 (全員共有)\n${s.projectContext}\n` : "",
    `## ボードの索引 — 基準スナップショット (status: todo=未着手, inprogress=作業中, review=レビュー中${s.lanes
      ? `, ${s.lanes
          .split(",")
          .map((x) => x.replace("=", "=「") + "」")
          .join(", ")}`
      : ""}, done=完了)`,
    "タイトルは要約品質。詳細(経緯メモ)が必要なら query_log で取る (SELECT context FROM cards WHERE id=...)。完了カードは自動アーカイブされここには載らない。",
    "後続に「変更イベント」がある場合、この索引にそれを適用した状態が現在のボードである。",
    `[${[...s.cards.values()].join(",")}]`,
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
    !st.lastSeen ||
    now - st.lastRequestAt > TTL_MS ||
    st.events.length > MAX_EVENTS ||
    st.lastSeen.date !== todayLabel() ||
    // #19: レーン構成が変わったら差分イベントでは表現できない (説明文そのものが変わる)
    st.lastSeen.lanes !== customLanes().map((l) => `${l.key}=${l.label}`).join(",");
  st.lastRequestAt = now;

  if (needRebase) {
    st.lastSeen = capture();
    st.baselineText = buildBaselineText(st.lastSeen);
    st.events = [];
    log("prompt", `rebaseline (project #${currentProjectId()}): tasks=${st.lastSeen.cards.size}`);
    return st.baselineText;
  }

  // 前回反映済み状態との差分をイベントとして追記 (チャット外のREST/MCP起因の変更もここで拾える)
  const seen = st.lastSeen!; // needRebase=false の分岐なので非null
  const cur = capture();
  const fresh: string[] = [];
  for (const [id, json] of cur.cards) {
    const prev = seen.cards.get(id);
    if (prev === undefined) fresh.push(`+ ${json}`);
    else if (prev !== json) fresh.push(`~ ${json}`);
  }
  for (const id of seen.cards.keys()) {
    if (!cur.cards.has(id)) fresh.push(`- #${id} (完了アーカイブまたは削除)`);
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
