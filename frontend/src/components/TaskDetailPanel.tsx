import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task } from "../types";

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  todo: { label: "Todo", cls: "bg-slate-200 text-slate-700" },
  inprogress: { label: "In Progress", cls: "bg-blue-100 text-blue-700" },
  review: { label: "Review", cls: "bg-amber-100 text-amber-700" },
  done: { label: "Done", cls: "bg-emerald-100 text-emerald-700" },
};

export default function TaskDetailPanel({
  task,
  onClose,
  onJumpToBoard,
}: {
  task: Task;
  onClose: () => void;
  onJumpToBoard: (id: number) => void;
}) {
  const status = STATUS_LABELS[task.status];
  return (
    <aside
      data-testid="task-detail-panel"
      className="fixed inset-y-0 right-0 z-40 flex w-96 max-w-full flex-col border-l border-slate-200 bg-white shadow-xl"
    >
      <header className="flex items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div>
          <p className="text-xs text-slate-400">#{task.id}</p>
          <h2 className="text-base font-bold leading-snug">{task.title}</h2>
        </div>
        <button onClick={onClose} className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100" title="閉じる">
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.cls}`}>{status.label}</span>
          {task.assignee && (
            <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
              {task.assignee}
            </span>
          )}
          {task.lane === "demo" && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">🎬 DEMO</span>
          )}
          {task.lane === "later" && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400">⏸ 凍結後</span>
          )}
        </div>

        {task.reason && (
          <section>
            <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">割り振り理由</h3>
            <p className="text-sm text-slate-600">💡 {task.reason}</p>
          </section>
        )}

        <section>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">経緯メモ</h3>
          {task.context ? (
            <div className="chat-md rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              <Markdown remarkPlugins={[remarkGfm]}>{task.context}</Markdown>
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              まだありません。チャットで「#{task.id}の補足: …」と話すと記録されます
            </p>
          )}
        </section>

        <section className="text-xs text-slate-400">
          <p>作成: {task.createdAt}</p>
          <p>更新: {task.updatedAt}</p>
        </section>
      </div>

      <footer className="space-y-2 border-t border-slate-100 px-4 py-3">
        <button
          onClick={() => onJumpToBoard(task.id)}
          className="w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          📌 ボードで表示
        </button>
        {/* #24: ここにタスク単位のAIチャットが展開される予定 */}
        <div className="rounded-xl border border-dashed border-slate-200 px-4 py-2 text-center text-xs text-slate-400">
          💬 このタスク専用チャット (#24 で実装予定)
        </div>
      </footer>
    </aside>
  );
}
