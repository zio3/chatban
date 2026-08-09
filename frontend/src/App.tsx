import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import Board, { type MovePayload } from "./components/Board";
import Chat, { type Suggestion } from "./components/Chat";
import TaskDetailPanel from "./components/TaskDetailPanel";
import { useChatTurn } from "./hooks/useChatTurn";
import { socket } from "./socket";
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const [archiveWorking, setArchiveWorking] = useState(false);
  // #14: なりすまし切替 (デモモード)。認証なしで「いま自分は誰か」を選び、チャット発言に記名される
  const [currentUser, setCurrentUser] = useState(() => localStorage.getItem("chatban.currentUser") || "zio");
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;
  const switchUser = (name: string) => {
    setCurrentUser(name);
    localStorage.setItem("chatban.currentUser", name);
  };

  // メインチャット: ライフサイクル(送信/考え中/停止/タイムアウト/再送)は共有フックに集約 (#23/#28/#29/#30)
  const mainChat = useChatTurn({
    request: (m, h, signal) => api.chat(m, h, signal, currentUserRef.current),
    onResponse: (res) => {
      for (const a of res.uiActions) {
        if (a.type === "set_filter") setFilter(a.assignee);
      }
    },
  });
  const setMainLog = mainChat.setLog;

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
    api.chatLog().then((r) => setMainLog(r.messages as ChatEntry[])).catch(() => {});
    const onBoard = (p: { tasks: Task[]; summaryCards?: SummaryCard[] }) => {
      setTasks(p.tasks);
      if (p.summaryCards) setSummaryCards(p.summaryCards);
    };
    const onProposals = (p: { proposals: Proposal[] }) => setProposals(p.proposals);
    // Done要約カードの非同期再生成中インジケータ (#56)
    const onArchive = (p: { count: number }) => setArchiveWorking(p.count > 0);
    socket.on("board:changed", onBoard);
    socket.on("proposals:changed", onProposals);
    socket.on("archive:working", onArchive);
    return () => {
      socket.off("board:changed", onBoard);
      socket.off("proposals:changed", onProposals);
      socket.off("archive:working", onArchive);
    };
  }, [reload, setMainLog]);

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

  // アーカイブ済みタスクの詳細表示用 (#59: 要約カードの#xxリンクから開く)
  const [archivedTask, setArchivedTask] = useState<Task | null>(null);
  const openTask = useCallback(
    (id: number) => {
      if (tasks.some((t) => t.id === id)) {
        setDetailTaskId(id);
        return;
      }
      api
        .getTask(id)
        .then((t) => {
          setArchivedTask(t);
          setDetailTaskId(id);
        })
        .catch(() => setToast({ message: `#${id} は存在しません` }));
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

  // Review→Doneの検収 (#57)。カードの検収OKチェックはマーキングのみで、
  // 「検収済みN件をDoneへ」ボタンで初めて確定する (Doneへの唯一のUI経路。D&Dは禁止)
  const [approvedIds, setApprovedIds] = useState<Set<number>>(new Set());
  const toggleApproved = useCallback((id: number) => {
    setApprovedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const commitApproved = useCallback(() => {
    const ids = tasks.filter((t) => t.status === "review" && approvedIds.has(t.id)).map((t) => t.id);
    if (ids.length === 0) return;
    // 複数前提の一括確定API (#60): N件でも要約再生成は1回
    api.approveTasks(ids).catch((e) => {
      setToast({ message: `検収に失敗しました: ${e?.message ?? e}` });
    });
    setApprovedIds(new Set());
  }, [tasks, approvedIds]);

  const resolveProposal = useCallback((id: number, action: "approve" | "reject") => {
    setProposals((prev) => prev.filter((p) => p.id !== id));
    api.resolveProposal(id, action).catch(() => api.board().then((b) => setProposals(b.proposals)));
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
  if (summaryCards.length >= 2) {
    suggestions.push({ label: `🧹 要約カード${summaryCards.length}枚を整頓`, message: "過去ログを整頓して" });
  }

  const sortedTasks = [...tasks].sort((a, b) => a.sort - b.sort || a.id - b.id);

  // パネルで開いているタスクが完了→アーカイブでtasksから消えても、パネルは最後のスナップショットで
  // 開き続ける (#53: AIの「完了にしました」返答が見えないまま消えるのを防ぐ)。閉じるのは✕のみ
  const foundDetailTask = detailTaskId !== null ? tasks.find((t) => t.id === detailTaskId) : undefined;
  const lastDetailTaskRef = useRef<Task | undefined>(undefined);
  if (foundDetailTask) lastDetailTaskRef.current = foundDetailTask;
  const detailTask =
    detailTaskId !== null
      ? foundDetailTask ?? (archivedTask?.id === detailTaskId ? archivedTask : undefined) ?? lastDetailTaskRef.current
      : undefined;
  const detailArchived = detailTaskId !== null && !foundDetailTask && !!detailTask;

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
          {/* #11: なりすまし中のユーザーでワンクリック自分フィルタ */}
          <button
            onClick={() => setFilter(currentUser)}
            className={`rounded-full px-3 py-1 ${filter === currentUser ? "bg-slate-900 text-white" : "bg-indigo-100 text-indigo-700 hover:bg-indigo-200"}`}
          >
            👤 自分の
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
          {/* #14: なりすまし切替 (デモモード)。選んだ人としてチャットに記名される */}
          <label className="ml-3 flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600">
            なりきり
            <select
              data-testid="impersonate-select"
              value={currentUser}
              onChange={(e) => switchUser(e.target.value)}
              className="bg-transparent font-bold text-slate-900 outline-none"
            >
              {members.map((m) => (
                <option key={m.id} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
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
            archiveWorking={archiveWorking}
            onMove={moveTask}
            onOpenTask={openTask}
            approvedIds={approvedIds}
            onToggleApproved={toggleApproved}
            onCommitApproved={commitApproved}
          />
        )}
      </main>
      <Chat
        log={mainChat.log}
        sending={mainChat.sending}
        elapsedSec={mainChat.elapsedSec}
        suggestions={suggestions}
        proposals={proposals}
        onResolveProposal={resolveProposal}
        onOpenTask={openTask}
        onSend={mainChat.send}
        onStop={mainChat.stop}
      />
      </div>
      {detailTask && (
        <TaskDetailPanel
          task={detailTask}
          archived={detailArchived}
          currentUser={currentUser}
          onClose={() => {
            setDetailTaskId(null);
            lastDetailTaskRef.current = undefined;
          }}
          onJumpToBoard={jumpToBoard}
        />
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
