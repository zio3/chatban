/** #19: custom1 / custom2 はプロジェクトが表示名を付けたときだけ現れる任意レーン。
 * 位置は Review と Done の間。値は固定で、意味は表示名 (lanes) が与える */
export type TaskStatus = "todo" | "inprogress" | "review" | "custom1" | "custom2" | "done";
export interface CustomLane {
  key: "custom1" | "custom2";
  /** 画面に出るのはこちら。custom1 という値そのものは人に見せない */
  label: string;
}

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  /** #226: 経緯メモの本文。**板の配信 (GET /api/board / board:changed) には載っていない** —
   * ペイロードの96%を占めていたので外した。入るのは GET /api/cards/:id で取り直したときだけ。
   * 「本文があるか」は contextChars、「変わったか」は contextVersion で分かる */
  context?: string | null;
  /** 経緯メモの文字数 (板の配信に載る)。本文の代わりに「あるか・どれくらいか」を伝える */
  contextChars?: number;
  /** #112: 経緯メモの版。本文が変わるたびに +1。パネルはこれを見て取り直す */
  contextVersion?: number;
  /** 期限 YYYY-MM-DD (#44) */
  due: string | null;
  /** 依存先カードID (#41)。**関係の覚え書きで、着手やDoneを止めるものではない** (#152) */
  blockedBy: number[] | null;
  /** 却下=やらない決定 (#65) */
  /** #92: 現況の一言。カードに出る。Reviewでは検収の要点を書く (詳細はcontextへ) */
  summary?: string | null;
  rejected: boolean;
  /** #102: ゴミ箱に入れた日時。nullなら通常のカード */
  trashedAt?: string | null;
  checkedAt?: string | null;
  doneAt?: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

/** #200: Done列の2段目。直近24時間に畳んだカードを1つにまとめた箱。
 * サーバーのメモリ上にしか無いので、再起動すると消える (中身は archived=1 でDBに残る) */
export interface FoldedTask {
  id: number;
  title: string;
  foldedAt: number;
}

export interface ToolTrace {
  tool: string;
  input: unknown;
  result: unknown;
}

/** 直前の返答に添える簡易返信ボタン。押すとその文字列がそのまま発言として送られ、次の発言で消える。
 * #179 で set_filter (担当者での絞り込み) が消え、いまはこれだけ */
export type UiAction = { type: "ask"; options: string[] };

export interface ChatResponse {
  reply: string;
  trace: ToolTrace[];
  uiActions: UiAction[];
  /** #181: 1ターンの体感 (速いか遅いか) だけ。トークン数・キャッシュヒット・ルーティング先は
   * 計測系ごと撤去した。**過去ログにはトークン等が入った古い形が残っている** —
   * 表示は rounds と elapsedMs しか読まないので、余分な項目は無視される */
  usage: {
    rounds: number;
    elapsedMs: number;
  };
}

export interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  trace?: ToolTrace[];
  usage?: ChatResponse["usage"];
  pending?: boolean;
  /** エラー・停止・タイムアウトの通知行 (履歴としてLLMには送らない) */
  error?: boolean;
  // 再送ボタン用の retryText はここに置かない (レビュー指摘 2026-08-21)。
  // **クライアントからは副作用の有無を判定できない** — ツールの往復は1ターンに何ラウンドもあり、
  // 1ラウンド目で書き込みが成功したあと2ラウンド目が失敗すると 500 が返る。
  // ワンボタンで送り直せる形にすると、そこで操作が重複する。
  // 安全に再送するにはサーバー側の冪等化 (リクエストIDを覚える) が要る
  /** 添付の表示用メタ (#68)。原本は保持しない */
  attachments?: { kind: "image" | "pdf"; name: string }[];
}

/** 期限バッジ: 超過=赤 / 今日・明日=琥珀 / それ以降=グレー (#44)。
 *
 * #228: **カードと詳細パネルで別々に整形していた。**見た目が違うだけならまだしも、
 * 超過しているかどうかの判定がカードにしか無く、**パネルでは期限切れが普通の期限に見えていた**
 * (情報量が違う)。すぐ下の statusLabel に「別々に持つとズレる」と書いてあるのに、
 * 期限には適用されていなかった。
 *
 * cls は**色だけ**を返す。大きさと余白は置く場所ごとに違うので、呼ぶ側が付ける。
 * long=true は詳細パネル用の「期限 2026-08-25」形式 (幅に余裕があるので年まで出す) */
export function dueBadge(due: string, opts: { long?: boolean } = {}): { text: string; cls: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${due}T00:00:00`);
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
  const label = opts.long ? `期限 ${due}` : `${d.getMonth() + 1}/${d.getDate()}`;
  if (diffDays < 0) return { text: `⏰ ${label} 超過`, cls: "bg-red-100 font-bold text-red-700" };
  if (diffDays <= 1) return { text: `⏰ ${label}`, cls: "bg-amber-100 font-bold text-amber-700" };
  return { text: `⏰ ${label}`, cls: "bg-slate-100 text-slate-500" };
}

/** 列の表示名。パネルとカードで別々に持つとズレるので1箇所に置く */
export const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  todo: { label: "Todo", cls: "bg-slate-200 text-slate-700" },
  inprogress: { label: "In Progress", cls: "bg-blue-100 text-blue-700" },
  review: { label: "Review", cls: "bg-amber-100 text-amber-700" },
  done: { label: "Done", cls: "bg-emerald-100 text-emerald-700" },
};

/** #19: 任意レーンの見た目。表示名だけがプロジェクトごとに変わり、色は固定。
 * **2本を色で区別しない** — 意味を持つのは名前のほうなので、色に意味があるように見せない */
const CUSTOM_LANE_CLS = "bg-violet-100 text-violet-700";

/** 列の表示名を引く。任意レーンはプロジェクトの表示名を使う。
 * lanes を渡し忘れても `custom1` という生の値が出るだけで、画面は落ちない
 * (STATUS_LABELS を直接引くと undefined で落ちていた — TASK_STATUSES の注記と同じ事故) */
export function statusLabel(status: string, lanes: CustomLane[] = []): { label: string; cls: string } {
  const lane = lanes.find((l) => l.key === status);
  if (lane) return { label: lane.label, cls: CUSTOM_LANE_CLS };
  return STATUS_LABELS[status] ?? { label: status, cls: "bg-slate-200 text-slate-700" };
}
