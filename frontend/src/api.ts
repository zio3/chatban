import { currentProjectHeader } from "./project";
import type { ChatResponse, Member, Proposal, SummaryCard, Task, TaskStatus } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

/** #97: どのプロジェクトへの操作かをヘッダで明示する。
 * URLが持つ状態をそのままリクエストに載せるので、タブごとに違うプロジェクトを触っても混ざらない */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, headers: { ...currentProjectHeader(), ...(init.headers ?? {}) } });
}

// #86: プロジェクト。SQLiteファイルごと分かれており、切り替えるとボード・チャット・
// 前提情報・メンバーがまとめて入れ替わる
export interface Project {
  id: number;
  name: string;
  file: string;
  createdAt: string;
  active: boolean;
  /** #107: 無効。ドロップダウンには出さないが設定画面には出る */
  archived: boolean;
  openTasks: number;
  members: string[];
}

export const api = {
  projects: () => apiFetch("/api/projects").then((r) => json<{ projects: Project[] }>(r)),
  createProject: (name: string, members: string[]) =>
    apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, members }),
    }).then((r) => json<{ ok: boolean }>(r)),
  activateProject: (id: number) =>
    apiFetch(`/api/projects/${id}/activate`, { method: "POST" }).then((r) => json<{ projects: Project[] }>(r)),
  updateProject: (id: number, patch: { name?: string; members?: string[]; archived?: boolean }) =>
    apiFetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<{ projects: Project[] }>(r)),
  deleteProject: (id: number) =>
    apiFetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => json<{ projects: Project[] }>(r)),
  // #102: 削除はゴミ箱行き。実体を消せるのはゴミ箱からの purge だけ (人間のUI操作)
  trash: () => apiFetch("/api/trash").then((r) => json<{ tasks: Task[] }>(r)),
  restoreTask: (id: number) => apiFetch(`/api/tasks/${id}/restore`, { method: "POST" }).then((r) => json<Task>(r)),
  purgeTask: (id: number) => apiFetch(`/api/trash/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
  board: () =>
    apiFetch("/api/board").then((r) =>
      json<{ tasks: Task[]; members: Member[]; proposals: Proposal[]; summaryCards: SummaryCard[] }>(r)
    ),
  updateTask: (id: number, patch: Partial<Pick<Task, "title" | "assignee" | "assignReason" | "summary" | "sort">> & { status?: TaskStatus }) =>
    apiFetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Task>(r)),
  getTask: (id: number) => apiFetch(`/api/tasks/${id}`).then((r) => json<Task>(r)),
  approveTasks: (ids: number[]) =>
    apiFetch("/api/tasks/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => json<{ ok: boolean }>(r)),
  resolveProposal: (id: number, action: "approve" | "reject") =>
    apiFetch(`/api/proposals/${id}/${action}`, { method: "POST" }).then((r) => json<Proposal>(r)),
  chatLog: (taskId?: number) =>
    apiFetch(`/api/chat/log${taskId != null ? `?taskId=${taskId}` : ""}`).then((r) =>
      json<{ messages: { role: "user" | "assistant"; content: string; trace?: unknown; usage?: unknown }[] }>(r)
    ),
  taskChat: (
    taskId: number,
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    signal?: AbortSignal,
    speaker?: string,
    attachments?: { kind: "image" | "pdf"; name: string; dataUrl: string }[]
  ) =>
    apiFetch(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history, speaker, attachments }),
      signal,
    }).then((r) => json<ChatResponse>(r)),
  chat: (
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    signal?: AbortSignal,
    speaker?: string,
    attachments?: { kind: "image" | "pdf"; name: string; dataUrl: string }[],
    /** #93: いま見ている画面。曖昧な指示語をタブの文脈で解決するためのメタ情報 */
    view?: string
  ) =>
    apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history, speaker, attachments, view }),
      signal,
    }).then((r) => json<ChatResponse>(r)),
};
