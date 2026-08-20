import { currentProjectHeader } from "./project";
import type { ChatResponse, CustomLane, FoldedTask, Task, TaskStatus } from "./types";

async function json<T>(res: Response): Promise<T> {
  // サーバーは断る理由を {error} で返すので、それをそのまま人に見せる。
  // ステータスと生のJSONを並べても、読む人には何が起きたか分からない
  if (!res.ok) {
    const body = await res.text();
    let message = body;
    try {
      message = JSON.parse(body)?.error ?? body;
    } catch {
      /* JSONでなければ本文をそのまま */
    }
    throw new Error(message || `${res.status}`);
  }
  return res.json();
}

/** #97: どのプロジェクトへの操作かをヘッダで明示する。
 * URLが持つ状態をそのままリクエストに載せるので、タブごとに違うプロジェクトを触っても混ざらない */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  // #180: 認証を廃止したのでCookieは載せない (credentials も要らない)
  return fetch(input, { ...init, headers: { ...currentProjectHeader(), ...(init.headers ?? {}) } });
}

// #86: プロジェクト。SQLiteファイルごと分かれており、切り替えるとボード・チャット・
// 前提情報がまとめて入れ替わる
export interface Project {
  id: number;
  name: string;
  file: string;
  createdAt: string;
  active: boolean;
  /** #107: 無効。ドロップダウンには出さないが設定画面には出る */
  archived: boolean;
  openTasks: number;
  /** #117: このプロジェクト用のMCP接続先 */
  mcpUrl: string;
  /** #19: 有効な任意レーン (0〜2本)。**空配列がふつう** */
  lanes: CustomLane[];
}

export const api = {
  projects: () => apiFetch("/api/projects").then((r) => json<{ projects: Project[] }>(r)),
  createProject: (name: string) =>
    apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => json<{ ok: boolean }>(r)),
  activateProject: (id: number) =>
    apiFetch(`/api/projects/${id}/activate`, { method: "POST" }).then((r) => json<{ projects: Project[] }>(r)),
  updateProject: (
    id: number,
    // #19: custom1Label / custom2Label は**空文字を送るとそのレーンを畳む**
    // (サーバー側でそこに居たカードを todo へ戻してから畳む)。undefined は「触らない」
    patch: { name?: string; archived?: boolean; custom1Label?: string; custom2Label?: string }
  ) =>
    apiFetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<{ projects: Project[] }>(r)),
  deleteProject: (id: number) =>
    apiFetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => json<{ projects: Project[] }>(r)),
  // #102: 削除はゴミ箱行き。実体を消せるのはゴミ箱からの purge だけ (人間のUI操作)
  trash: () => apiFetch("/api/trash").then((r) => json<{ cards: Task[] }>(r)),
  restoreTask: (id: number) => apiFetch(`/api/cards/${id}/restore`, { method: "POST" }).then((r) => json<Task>(r)),
  purgeTask: (id: number) => apiFetch(`/api/trash/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
  board: () =>
    apiFetch("/api/board").then((r) =>
      json<{ cards: Task[]; folded: FoldedTask[]; lanes: CustomLane[]; llmRefused?: boolean; attachments?: boolean }>(r)
    ),
  updateTask: (id: number, patch: Partial<Pick<Task, "title" | "summary" | "sort">> & { status?: TaskStatus }) =>
    apiFetch(`/api/cards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Task>(r)),
  getTask: (id: number) => apiFetch(`/api/cards/${id}`).then((r) => json<Task>(r)),
  // #108: 検収の印。この口はRESTにしか無い (エージェントは読めるが書けない)
  // fetch はHTTPエラーでは reject しないので、json() を通さないと呼び出し側の
  // .catch (楽観更新のロールバック) が永久に発火しない。サーバーが409で断っても
  // 画面はチェック済みのまま、という食い違いになる
  setChecked: (id: number, checked: boolean) =>
    apiFetch(`/api/cards/${id}/checked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checked }),
    }).then((r) => json<Task>(r)),
  approveTasks: (ids: number[]) =>
    apiFetch("/api/cards/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => json<{ ok: boolean; note?: string }>(r)),
  chatLog: (taskId?: number) =>
    apiFetch(`/api/chat/log${taskId != null ? `?taskId=${taskId}` : ""}`).then((r) =>
      json<{ messages: { role: "user" | "assistant"; content: string; trace?: unknown; usage?: unknown }[] }>(r)
    ),
  taskChat: (
    taskId: number,
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    signal?: AbortSignal,
    attachments?: { kind: "image" | "pdf"; name: string; dataUrl: string }[]
  ) =>
    apiFetch(`/api/cards/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history, attachments }),
      signal,
    }).then((r) => json<ChatResponse>(r)),
  chat: (
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    signal?: AbortSignal,
    attachments?: { kind: "image" | "pdf"; name: string; dataUrl: string }[],
    /** #93: いま見ている画面。曖昧な指示語をタブの文脈で解決するためのメタ情報 */
    view?: string
  ) =>
    apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history, attachments, view }),
      signal,
    }).then((r) => json<ChatResponse>(r)),
};
