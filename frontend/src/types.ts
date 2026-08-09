export type TaskStatus = "todo" | "inprogress" | "review" | "done";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  reason: string | null;
  context: string | null;
  lane: "demo" | "later" | null;
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
  usage: { promptTokens: number; completionTokens: number; rounds: number; elapsedMs: number };
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
}
