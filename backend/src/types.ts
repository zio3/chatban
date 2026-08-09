export type TaskStatus = "todo" | "inprogress" | "review" | "done";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  reason: string | null;
  /** 詳細・決定事項・ブリーフィングの置き場 (フリーテキスト、遅延読み込み) */
  context: string | null;
  /** demo=90秒台本に必要 / later=機能凍結後 / null=未分類 */
  lane: "demo" | "later" | null;
  /** 期限 YYYY-MM-DD (#44)。相対表現はチャットが今日の日付から解決して格納する */
  due: string | null;
  /** 依存先タスクID (#41)。このタスクは blocked_by の全タスクが完了するまで着手できない想定 */
  blockedBy: number[] | null;
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

export interface UiAction {
  type: "set_filter";
  assignee: string | null;
}
