import type { ChatResponse, Member, Proposal, SummaryCard, Task, TaskStatus } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export const api = {
  board: () =>
    fetch("/api/board").then((r) =>
      json<{ tasks: Task[]; members: Member[]; proposals: Proposal[]; summaryCards: SummaryCard[] }>(r)
    ),
  updateTask: (id: number, patch: Partial<Pick<Task, "title" | "assignee" | "reason" | "sort">> & { status?: TaskStatus }) =>
    fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Task>(r)),
  approveTasks: (ids: number[]) =>
    fetch("/api/tasks/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => json<{ ok: boolean }>(r)),
  resolveProposal: (id: number, action: "approve" | "reject") =>
    fetch(`/api/proposals/${id}/${action}`, { method: "POST" }).then((r) => json<Proposal>(r)),
  chatLog: (taskId?: number) =>
    fetch(`/api/chat/log${taskId != null ? `?taskId=${taskId}` : ""}`).then((r) =>
      json<{ messages: { role: "user" | "assistant"; content: string; trace?: unknown; usage?: unknown }[] }>(r)
    ),
  taskChat: (
    taskId: number,
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    signal?: AbortSignal,
    speaker?: string
  ) =>
    fetch(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history, speaker }),
      signal,
    }).then((r) => json<ChatResponse>(r)),
  chat: (
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    signal?: AbortSignal,
    speaker?: string
  ) =>
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history, speaker }),
      signal,
    }).then((r) => json<ChatResponse>(r)),
};
