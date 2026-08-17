export type TaskStatus = "todo" | "inprogress" | "review" | "done";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  context: string | null;
  /** 期限 YYYY-MM-DD (#44) */
  due: string | null;
  /** 依存先タスクID (#41)。全完了まで着手不可の想定 */
  blockedBy: number[] | null;
  /** 却下=やらない決定 (#65) */
  /** #92: 現況の一言。カードに出る。Reviewでは検収の要点を書く (詳細はcontextへ) */
  summary?: string | null;
  rejected: boolean;
  /** #102: ゴミ箱に入れた日時。nullなら通常のタスク */
  trashedAt?: string | null;
  checkedAt?: string | null;
  doneAt?: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
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
  frozen: boolean;
  createdAt: string;
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
