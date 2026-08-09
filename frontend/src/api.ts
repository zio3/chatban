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
  checkSummaryElement: (cardId: number, index: number, checked: boolean) =>
    fetch(`/api/summary-cards/${cardId}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index, checked }),
    }).then((r) => json<SummaryCard>(r)),
  updateTask: (id: number, patch: Partial<Pick<Task, "title" | "assignee" | "reason" | "sort">> & { status?: TaskStatus }) =>
    fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Task>(r)),
  resolveProposal: (id: number, action: "approve" | "reject") =>
    fetch(`/api/proposals/${id}/${action}`, { method: "POST" }).then((r) => json<Proposal>(r)),
  chatLog: () =>
    fetch("/api/chat/log").then((r) =>
      json<{ messages: { role: "user" | "assistant"; content: string; trace?: unknown; usage?: unknown }[] }>(r)
    ),
  chat: (message: string, history: { role: "user" | "assistant"; content: string }[]) =>
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    }).then((r) => json<ChatResponse>(r)),
};
