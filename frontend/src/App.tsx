import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { api } from "./api";
import Board, { type MovePayload } from "./components/Board";
import Chat, { type Suggestion } from "./components/Chat";
import TaskDetailPanel from "./components/TaskDetailPanel";
import type { ChatEntry, Member, Proposal, SummaryCard, Task } from "./types";

interface Toast {
  message: string;
  retry?: () => void;
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [summaryCards, setSummaryCards] = useState<SummaryCard[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const chatLogRef = useRef(chatLog);
  chatLogRef.current = chatLog;

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const b = await api.board();
      setTasks(b.tasks);
      setMembers(b.members);
      setProposals(b.proposals);
      setSummaryCards(b.summaryCards ?? []);
    } catch (e: any) {
      setLoadError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    // サーバー保存された会話履歴を復元 (リロードで消えない)
    api.chatLog().then((r) => setChatLog(r.messages as ChatEntry[])).catch(() => {});
    const socket = io();
    socket.on("board:changed", (p: { tasks: Task[]; summaryCards?: SummaryCard[] }) => {
      setTasks(p.tasks);
      if (p.summaryCards) setSummaryCards(p.summaryCards);
    });
    socket.on("proposals:changed", (p: { proposals: Proposal[] }) => setProposals(p.proposals));
    // ツール実行の逐次フィードバック: 応答待ちの吹き出しに実行中の操作を表示
    socket.on("chat:progress", (p: { label: string }) => {
      setChatLog((prev) =>
        prev.map((e) => (e.pending ? { ...e, content: `🔧 ${p.label}中…` } : e))
      );
    });
    return () => {
      socket.disconnect();
    };
  }, [reload]);

  // 列内挿入位置から新しいsort値を計算 (前後の中間値。端は±1)
  const moveTask = useCallback((move: MovePayload) => {
    setTasks((prev) => {
      const snapshot = prev;
      const task = prev.find((t) => t.id === move.id);
      if (!task) return prev;
      const colWithout = prev
        .filter((t) => t.status === move.status && t.id !== move.id)
        .sort((a, b) => a.sort - b.sort || a.id - b.id);
      const idx = Math.min(move.index, colWithout.length);
      const before = colWithout[idx - 1];
      const after = colWithout[idx];
      let sort: number;
      if (!before && !after) sort = task.sort;
      else if (!before) sort = after!.sort - 1;
      else if (!after) sort = before.sort + 1;
      else sort = (before.sort + after.sort) / 2;

      const doPatch = () =>
        api.updateTask(move.id, { status: move.status, sort }).catch((e) => {
          setTasks(snapshot); // ロールバック
          setToast({ message: `移動に失敗しました: ${e?.message ?? e}`, retry: doPatch });
        });
      doPatch();
      return prev.map((t) => (t.id === move.id ? { ...t, status: move.status, sort } : t));
    });
  }, []);

  const openTask = useCallback(
    (id: number) => {
      if (tasks.some((t) => t.id === id)) setDetailTaskId(id);
      else setToast({ message: `#${id} はアーカイブ済みか存在しません` });
    },
    [tasks]
  );

  // 詳細パネルの「ボードで表示」: パネルは開いたまま、フィルタ解除→スクロール→フラッシュ (Slackスレッド風の常駐)
  const jumpToBoard = useCallback((id: number) => {
    setFilter(null);
    setTimeout(() => {
      const el = document.querySelector(`[data-testid="task-card-${id}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("task-flash");
      setTimeout(() => el.classList.remove("task-flash"), 1700);
    }, 60);
  }, []);

  const toggleSummaryElement = useCallback((cardId: number, index: number, checked: boolean) => {
    setSummaryCards((prev) =>
      prev.map((c) =>
        c.id === cardId ? { ...c, elements: c.elements.map((e, i) => (i === index ? { ...e, checked } : e)) } : c
      )
    );
    api.checkSummaryElement(cardId, index, checked).catch(() => api.board().then((b) => setSummaryCards(b.summaryCards)));
  }, []);

  const resolveProposal = useCallback((id: number, action: "approve" | "reject") => {
    setProposals((prev) => prev.filter((p) => p.id !== id));
    api.resolveProposal(id, action).catch(() => api.board().then((b) => setProposals(b.proposals)));
  }, []);

  const sendChat = useCallback(async (message: string) => {
    setSending(true);
    const history = chatLogRef.current
      .filter((e) => !e.pending)
      .map((e) => ({ role: e.role, content: e.content }));
    setChatLog((prev) => [...prev, { role: "user", content: message }, { role: "assistant", content: "…", pending: true }]);
    try {
      const res = await api.chat(message, history);
      for (const a of res.uiActions) {
        if (a.type === "set_filter") setFilter(a.assignee);
      }
      setChatLog((prev) => [
        ...prev.filter((e) => !e.pending),
        { role: "assistant", content: res.reply || "(操作を実行しました)", trace: res.trace, usage: res.usage },
      ]);
    } catch (e: any) {
      setChatLog((prev) => [
        ...prev.filter((en) => !en.pending),
        { role: "assistant", content: `エラー: ${e?.message ?? e}` },
      ]);
    } finally {
      setSending(false);
    }
  }, []);

  // 「何を話しかければいいか分からない人」向けのユースケース導線。ボード状態で出し分ける
  const suggestions: Suggestion[] = [];
  const unassigned = tasks.filter((t) => t.status !== "done" && !t.assignee);
  suggestions.push({ label: "📋 現状をレポートして", message: "ボードの現状を簡潔にレポートして" });
  if (unassigned.length > 0) {
    suggestions.push({
      label: `🎯 未割り当て${unassigned.length}件をいい感じに振る`,
      message: "未割り当てのタスクをいい感じに振っといて",
    });
  }
  if (tasks.filter((t) => t.status === "review").length > 0) {
    suggestions.push({ label: "👀 レビュー待ちをまとめて", message: "レビュー中のタスクの状況をまとめて" });
  }
  if (tasks.filter((t) => t.status === "todo").length === 0) {
    suggestions.push({ label: "💡 次のタスク候補を挙げて", message: "次にやるべきタスクの候補を挙げて" });
  }
  const settledCandidates = summaryCards.filter((c) => c.elements.length > 0 && c.elements.every((e) => e.checked));
  if (settledCandidates.length >= 2) {
    suggestions.push({ label: `🧹 確認済みログ${settledCandidates.length}枚を整頓`, message: "過去ログを整頓して" });
  }

  const sortedTasks = [...tasks].sort((a, b) => a.sort - b.sort || a.id - b.id);

  const detailTask = detailTaskId !== null ? tasks.find((t) => t.id === detailTaskId) : undefined;

  return (
    <div className="flex h-full bg-slate-100 text-slate-900">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-bold tracking-tight">ChatBan</h1>
          <span className="text-xs text-slate-500">会話がそのままタスク管理になる</span>
        </div>
        <div className="flex items-center gap-1 text-sm">
          <button
            onClick={() => setFilter(null)}
            className={`rounded-full px-3 py-1 ${filter === null ? "bg-slate-900 text-white" : "bg-slate-200 hover:bg-slate-300"}`}
          >
            全員
          </button>
          {members.map((m) => (
            <button
              key={m.id}
              onClick={() => setFilter(m.name)}
              className={`rounded-full px-3 py-1 ${filter === m.name ? "bg-slate-900 text-white" : "bg-slate-200 hover:bg-slate-300"}`}
            >
              {m.name}
            </button>
          ))}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto p-3">
        {loading && (
          <div data-testid="board-loading" className="flex h-40 items-center justify-center text-sm text-slate-400">
            読み込み中…
          </div>
        )}
        {!loading && loadError && (
          <div data-testid="board-error" className="flex h-40 flex-col items-center justify-center gap-3">
            <p className="text-sm text-red-600">読み込みに失敗しました: {loadError}</p>
            <button
              onClick={reload}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              再読込
            </button>
          </div>
        )}
        {!loading && !loadError && (
          <Board
            tasks={filter ? sortedTasks.filter((t) => t.assignee === filter) : sortedTasks}
            summaryCards={summaryCards}
            onMove={moveTask}
            onToggleSummaryElement={toggleSummaryElement}
            onOpenTask={openTask}
          />
        )}
      </main>
      <Chat
        log={chatLog}
        sending={sending}
        suggestions={suggestions}
        proposals={proposals}
        onResolveProposal={resolveProposal}
        onOpenTask={openTask}
        onSend={sendChat}
      />
      </div>
      {detailTask && (
        <TaskDetailPanel task={detailTask} onClose={() => setDetailTaskId(null)} onJumpToBoard={jumpToBoard} />
      )}
      {toast && (
        <div
          data-testid="toast"
          className="fixed bottom-20 right-4 z-50 flex items-center gap-3 rounded-xl border border-red-200 bg-white px-4 py-3 text-sm shadow-lg"
        >
          <span className="text-red-600">{toast.message}</span>
          {toast.retry && (
            <button
              onClick={() => {
                const r = toast.retry!;
                setToast(null);
                r();
              }}
              className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700"
            >
              リトライ
            </button>
          )}
          <button onClick={() => setToast(null)} className="text-xs text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
