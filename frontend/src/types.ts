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
  context: string | null;
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
  /** 失敗した元メッセージ (再送ボタン用) */
  retryText?: string;
  /** 添付の表示用メタ (#68)。原本は保持しない */
  attachments?: { kind: "image" | "pdf"; name: string }[];
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
