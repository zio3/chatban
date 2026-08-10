export type TaskStatus = "todo" | "inprogress" | "review" | "done";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  /** #92: なぜこの担当か。進捗は summary へ (名前で用途が分かるよう reason から改名) */
  assignReason: string | null;
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
  sort: number;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  id: number;
  name: string;
  skills: string | null;
}

export interface Proposal {
  id: number;
  taskId: number;
  taskTitle: string;
  assignee: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
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
  settled: boolean;
  createdAt: string;
}

export interface ToolTrace {
  tool: string;
  input: unknown;
  result: unknown;
}

export interface UiAction {
  type: "set_filter";
  assignee: string | null;
}

export interface ChatResponse {
  reply: string;
  trace: ToolTrace[];
  uiActions: UiAction[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    rounds: number;
    elapsedMs: number;
    /** LLM往復ごとのルーティング詳細 (#31)。過去ログには無い場合がある */
    calls?: { model: string; promptTokens: number; completionTokens: number; cachedTokens: number; elapsedMs: number }[];
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
