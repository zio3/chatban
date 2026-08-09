import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type { ChatEntry, Task } from "../types";

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
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("chatban.panelWidth"));
    return saved >= 320 ? saved : 400;
  });

  // タスク専用チャット (#24)
  const [log, setLog] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const logStateRef = useRef(log);
  logStateRef.current = log;

  useEffect(() => {
    setLog([]);
    api.chatLog(task.id).then((r) => setLog(r.messages as ChatEntry[])).catch(() => {});
  }, [task.id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    const history = logStateRef.current.filter((e) => !e.pending).map((e) => ({ role: e.role, content: e.content }));
    setLog((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "…", pending: true }]);
    try {
      const res = await api.taskChat(task.id, text, history);
      setLog((prev) => [
        ...prev.filter((e) => !e.pending),
        { role: "assistant", content: res.reply || "(操作を実行しました)", trace: res.trace, usage: res.usage },
      ]);
    } catch (e: any) {
      setLog((prev) => [...prev.filter((en) => !en.pending), { role: "assistant", content: `エラー: ${e?.message ?? e}` }]);
    } finally {
      setSending(false);
    }
  }, [input, sending, task.id]);

  // 左端ドラッグで幅調整 (localStorageに保存)
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const clamp = (w: number) => Math.min(Math.max(w, 320), Math.round(window.innerWidth * 0.7));
    function onMove(ev: PointerEvent) {
      setWidth(clamp(startWidth + (startX - ev.clientX)));
    }
    function onUp(ev: PointerEvent) {
      localStorage.setItem("chatban.panelWidth", String(clamp(startWidth + (startX - ev.clientX))));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <aside
      data-testid="task-detail-panel"
      style={{ width }}
      className="relative flex h-full max-w-full shrink-0 flex-col border-l border-slate-200 bg-white"
    >
      {/* 幅スプリッター */}
      <div
        onPointerDown={startResize}
        title="ドラッグで幅を調整"
        className="group absolute inset-y-0 left-0 z-10 flex w-2 cursor-col-resize items-center justify-center hover:bg-indigo-50"
      >
        <div className="h-10 w-1 rounded-full bg-slate-200 group-hover:bg-indigo-400" />
      </div>

      <header className="flex items-start justify-between gap-2 border-b border-slate-100 py-3 pl-4 pr-3">
        <div className="min-w-0">
          <p className="text-xs text-slate-400">#{task.id}</p>
          <h2 className="text-base font-bold leading-snug">{task.title}</h2>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100"
          title="閉じる"
        >
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
          <button
            onClick={() => onJumpToBoard(task.id)}
            className="ml-auto rounded-lg bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200"
          >
            📌 ボードで表示
          </button>
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
            <p className="text-sm text-slate-400">まだありません。下のチャットで話すと決定事項が記録されます</p>
          )}
        </section>

        <p className="text-xs text-slate-400">作成 {task.createdAt} / 更新 {task.updatedAt}</p>
      </div>

      {/* タスク専用チャット (#24) */}
      <section className="flex h-1/2 shrink-0 flex-col border-t border-slate-200 bg-slate-50/50">
        <p className="px-4 pt-2 text-xs font-bold text-slate-400">💬 このタスクのチャット</p>
        <div ref={logRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
          {log.length === 0 && (
            <p className="text-xs text-slate-400">
              例:「これどう進めるのがいい？」「◯◯方式でいくことにした」→ 決定は経緯メモに残ります
            </p>
          )}
          {log.map((e, i) => (
            <div key={i} className={`flex ${e.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-xl px-3 py-1.5 text-sm whitespace-pre-wrap ${
                  e.role === "user" ? "bg-indigo-600 text-white" : "bg-white text-slate-900 shadow-sm"
                } ${e.pending ? "animate-pulse" : ""}`}
              >
                {e.role === "assistant" ? (
                  <div className="chat-md">
                    <Markdown remarkPlugins={[remarkGfm]}>{e.content}</Markdown>
                  </div>
                ) : (
                  e.content
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2 px-3 pb-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
            }}
            placeholder={`#${task.id} について話す…`}
            className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="rounded-xl bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            送信
          </button>
        </div>
      </section>
    </aside>
  );
}
