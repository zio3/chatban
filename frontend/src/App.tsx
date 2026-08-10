import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Project } from "./api";
import AuditView from "./components/AuditView";
import Board, { type MovePayload } from "./components/Board";
import Chat, { type Suggestion } from "./components/Chat";
import ContextView from "./components/ContextView";
import MetricsView from "./components/MetricsView";
import SettingsView from "./components/SettingsView";
import TrashView from "./components/TrashView";
import TaskDetailPanel from "./components/TaskDetailPanel";
import { useChatTurn } from "./hooks/useChatTurn";
import { socket } from "./socket";
import type { ChatEntry, Member, Proposal, SummaryCard, Task } from "./types";

interface Toast {
  tone?: "error" | "info";
  action?: { label: string; run: () => void };
  message: string;
  retry?: () => void;
}

const UNASSIGNED = "__unassigned__"; // #90: 担当なしを表すフィルタキー (メンバー名と衝突しない値)

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [summaryCards, setSummaryCards] = useState<SummaryCard[]>([]);
  // #90: 複数トグル。空Set=全員表示。UNASSIGNEDは担当なしを表す擬似キー
  const [filter, setFilter] = useState<Set<string>>(new Set());
  const toggleFilter = useCallback((name: string) => {
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const [archiveWorking, setArchiveWorking] = useState(false);
  // #21/#33: ボード以外の閲覧ビューへの遷移 (簡易タブ)
  const [view, setView] = useState<"board" | "context" | "metrics" | "audit" | "settings" | "trash">("board");
  // #14 → #90: なりきりの切替UIは撤去。デモでは人フィルタが見えれば足りると判断した。
  // 発言者(speaker)の配線自体は残してあるので、localStorage の chatban.currentUser を
  // 書き換えれば別人として発言できる (音声入力#20と同じく「入口だけ外す」扱い)
  const currentUser = localStorage.getItem("chatban.currentUser") || "zio";
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;

  // メインチャット: ライフサイクル(送信/考え中/停止/タイムアウト/再送)は共有フックに集約 (#23/#28/#29/#30)
  const mainChat = useChatTurn({
    request: (m, h, signal, attachments) => api.chat(m, h, signal, currentUserRef.current, attachments),
    onResponse: (res) => {
      for (const a of res.uiActions) {
        // チャットからの絞り込みは単一指定。nullで解除 (#90でSetに変わったため詰め替える)
        if (a.type === "set_filter") setFilter(a.assignee ? new Set([a.assignee]) : new Set());
      }
    },
  });

  // #86: プロジェクト一覧。切り替えるとボード・チャット・前提情報・メンバーが総取っ替えになる
  const [projects, setProjects] = useState<Project[]>([]);
  const loadProjects = useCallback(() => {
    api.projects().then((d) => setProjects(d.projects)).catch(() => {});
  }, []);

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
    // #72: メインチャットはリロードで新規 (会話は作業記憶。重要事項はプロジェクト前提/タスク経緯メモに
    // 蒸留されて残り、生ログはDB保存済みで📜監査タブから見える)。タスクチャットは経緯ログなので復元維持
    const onBoard = (p: { tasks: Task[]; summaryCards?: SummaryCard[] }) => {
      setTasks(p.tasks);
      if (p.summaryCards) setSummaryCards(p.summaryCards);
    };
    const onProposals = (p: { proposals: Proposal[] }) => setProposals(p.proposals);
    // Done要約カードの非同期再生成中インジケータ (#56)
    const onArchive = (p: { count: number }) => setArchiveWorking(p.count > 0);
    // プロジェクトが切り替わったら全部読み直す (他のタブ/端末での切り替えにも追従する)
    const onProject = (p: { projects: Project[] }) => {
      setProjects(p.projects);
      reload();
    };
    socket.on("board:changed", onBoard);
    socket.on("proposals:changed", onProposals);
    socket.on("archive:working", onArchive);
    socket.on("project:changed", onProject);
    loadProjects();
    return () => {
      socket.off("board:changed", onBoard);
      socket.off("proposals:changed", onProposals);
      socket.off("archive:working", onArchive);
      socket.off("project:changed", onProject);
    };
  }, [reload, loadProjects]);

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
    setFilter(new Set());
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

  // ✨AI提案チップ (#75): ボードの文脈を読んだ提案を非同期で追加 (固定チップは即時表示の保険)
  const [aiSuggestions, setAiSuggestions] = useState<Suggestion[]>([]);
  const fetchAiSuggestions = useCallback(() => {
    fetch("/api/suggestions")
      .then((r) => r.json())
      .then((d) =>
        setAiSuggestions(
          ((d.suggestions ?? []) as { label: string; message: string }[]).map((s) => ({
            label: `✨ ${s.label}`,
            message: s.message,
          }))
        )
      )
      .catch(() => {});
  }, []);
  useEffect(() => {
    fetchAiSuggestions();
  }, [fetchAiSuggestions]);

  // 🆕 新しい会話: F5せずにチャットを初期状態(チップ+AI提案)へ戻す (#72追補)
  const resetChat = useCallback(() => {
    mainChat.stop();
    mainChat.setLog([]);
    setAiSuggestions([]);
    fetchAiSuggestions();
  }, [mainChat.stop, mainChat.setLog, fetchAiSuggestions]);

  // 「何を話しかければいいか分からない人」向けのユースケース導線。ボード状態で出し分ける
  const suggestions: Suggestion[] = [];
  const unassigned = tasks.filter((t) => t.status !== "done" && !t.assignee);
  // 新規プロジェクト(まだ何も無い)では、レポートも割り振りも中身が無い。
  // 最初にやるべきは方針を伝えること — 前提情報はAIの振る舞いを決める介入チャネル (#81) なので、
  // ここを埋めるところから始まるのが自然。チップは1つに絞る
  const isEmptyBoard = tasks.length === 0 && summaryCards.length === 0;
  if (isEmptyBoard) {
    suggestions.push({
      label: "🧭 このプロジェクトの方針を伝える",
      message: "このプロジェクトの前提や方針を登録したい。何を教えればいい?",
    });
  } else {
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
    suggestions.push(...aiSuggestions);
  }

  const sortedTasks = [...tasks].sort((a, b) => a.sort - b.sort || a.id - b.id);
  // #90: トグルはメンバー表だけでなく「実際にボードに居る担当者」の和集合から作る。
  // Claudeのようにメンバー未登録の担当者がいると、全部オンにしても出せないタスクが生まれるため
  const filterNames = [
    ...members.map((m) => m.name),
    ...[...new Set(tasks.map((t) => t.assignee).filter((a): a is string => !!a))].filter(
      (a) => !members.some((m) => m.name === a)
    ),
  ];
  // #90: 選択ゼロなら素通し。複数選択はOR (Aさん「と」Bさんを並べて見る)
  const visibleTasks =
    filter.size === 0
      ? sortedTasks
      : sortedTasks.filter((t) => filter.has(t.assignee ?? UNASSIGNED));
  const hiddenCount = sortedTasks.length - visibleTasks.length;

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

  // #86: プロジェクトが切り替わったら画面の持ち越しを全部落とす。
  // 詳細パネルは「タスクが消えても最後のスナップショットで開き続ける」設計 (#53) なので、
  // 明示的に閉じないと別プロジェクトのタスクを開いたまま操作できてしまう (危険)。
  // 切替はヘッダー・設定タブ・他タブからの通知と入口が複数あるので、
  // アクティブIDの変化を1箇所で監視する (どの入口から来ても必ず通る)
  const activeProjectId = projects.find((p) => p.active)?.id;
  const prevProjectRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (activeProjectId === undefined) return;
    if (prevProjectRef.current !== undefined && prevProjectRef.current !== activeProjectId) {
      mainChat.stop();
      mainChat.setLog([]);
      setDetailTaskId(null);
      lastDetailTaskRef.current = undefined;
      setArchivedTask(null);
      setApprovedIds(new Set());
      setFilter(new Set());
      fetchAiSuggestions();
    }
    prevProjectRef.current = activeProjectId;
    // mainChatは毎レンダで作り直されるため依存に入れない (IDの変化だけを引き金にする)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  return (
    <div className="flex h-full bg-slate-100 text-slate-900">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-y-1.5 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-bold tracking-tight">ChatBan</h1>
          {/* #86: プロジェクト切替。SQLiteファイルごと分かれているので、選び直すと
              ボード・チャット・前提情報・メンバーがまとめて入れ替わる */}
          <select
            data-testid="project-select"
            value={projects.find((p) => p.active)?.id ?? ""}
            onChange={(e) => api.activateProject(Number(e.target.value)).then((d) => setProjects(d.projects))}
            className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-slate-900 outline-none"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="flex gap-1 text-xs">
            {(
              [
                { key: "board", label: "ボード" },
                { key: "context", label: "📋 前提" },
                { key: "metrics", label: "📊 コスト" },
                { key: "audit", label: "📜 監査" },
                { key: "trash", label: "🗑 ゴミ箱" },
                { key: "settings", label: "⚙ 設定" },
              ] as const
            ).map((v) => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`rounded-full px-2.5 py-1 ${view === v.key ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"}`}
              >
                {v.label}
              </button>
            ))}
          </span>
        </div>
        {/* #90: 担当フィルタは複数トグル (AさんBさんを並べて見る)。選択ゼロ=全員表示。
            なりきりの入口は撤去 (デモでは人フィルタが見えれば足りる)。speakerの配線は温存 */}
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {filterNames.map((name) => (
            <button
              key={name}
              onClick={() => toggleFilter(name)}
              className={`rounded-full px-3 py-1 ${filter.has(name) ? "bg-slate-900 text-white" : "bg-slate-200 hover:bg-slate-300"}`}
            >
              {name}
            </button>
          ))}
          {/* 未割り当ては「拾い手がいない」を見つける導線。担当なしのタスクが埋もれるのを防ぐ */}
          <button
            onClick={() => toggleFilter(UNASSIGNED)}
            className={`rounded-full px-3 py-1 ${filter.has(UNASSIGNED) ? "bg-slate-900 text-white" : "bg-slate-200 hover:bg-slate-300"}`}
          >
            未割り当て
          </button>
          {/* フィルタが効いていることをチップの色だけに頼らない。何件隠れているかを数で出す
              (#87/#88が「消えた」と誤解された事故の再発防止) */}
          {filter.size > 0 && (
            <span className="ml-2 flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800">
              フィルタで{hiddenCount}件が非表示
              <button onClick={() => setFilter(new Set())} className="font-bold hover:text-amber-950" title="フィルタ解除">
                ✕
              </button>
            </span>
          )}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto p-3">
        {view === "context" && <ContextView />}
        {view === "metrics" && <MetricsView />}
        {view === "audit" && <AuditView />}
        {view === "settings" && <SettingsView />}
        {view === "trash" && <TrashView />}
        {view === "board" && loading && (
          <div data-testid="board-loading" className="flex h-40 items-center justify-center text-sm text-slate-400">
            読み込み中…
          </div>
        )}
        {view === "board" && !loading && loadError && (
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
        {view === "board" && !loading && !loadError && (
          <Board
            tasks={visibleTasks}
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
        onReset={resetChat}
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
          onRestored={() => {
            setArchivedTask(null);
            reload();
          }}
        />
      )}
      {toast && (
        <div
          data-testid="toast"
          className={`fixed bottom-20 right-4 z-50 flex items-center gap-3 rounded-xl border bg-white px-4 py-3 text-sm shadow-lg ${
            toast.tone === "info" ? "border-slate-300" : "border-red-200"
          }`}
        >
          <span className={toast.tone === "info" ? "text-slate-700" : "text-red-600"}>{toast.message}</span>
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
          {toast.action && (
            <button
              onClick={() => {
                const a = toast.action!;
                setToast(null);
                a.run();
              }}
              className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700"
            >
              {toast.action.label}
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
