import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { useAttachments } from "../hooks/useAttachments";
import { useChatTurn } from "../hooks/useChatTurn";
import AttachmentTray from "./AttachmentTray";
import ThinkingIndicator from "./ThinkingIndicator";
import { DepChip } from "./Board";
import { statusLabel } from "../types";
import type { ChatEntry, CustomLane, Task } from "../types";

export default function TaskDetailPanel({
  task,
  archived,
  onClose,
  onJumpToBoard,
  onRestored,
  taskById,
  onOpenTask,
  lanes = [],
}: {
  task: Task;
  /** true: タスクは完了→アーカイブ済み (表示は最後のスナップショット) */
  archived?: boolean;
  onClose: () => void;
  onJumpToBoard: (id: number) => void;
  /** #102: ゴミ箱から戻したあとの再読み込み */
  onRestored?: () => void;
  /** #111: 依存先の中身をチップから引く索引と、そこへ飛ぶための導線 */
  taskById?: Map<number, Task>;
  onOpenTask?: (id: number) => void;
  /** #19: 任意レーンの表示名。列バッジと依存チップに使う */
  lanes?: CustomLane[];
}) {
  const status = statusLabel(task.status, lanes);
  // #111: このタスクを待っている側 (被依存)。データは blocked_by にあるので逆引きで足りる。
  // 索引に載るのは未完了タスクだけだが、完了したものはもう待っていないので実用上それでよい
  const dependents = [...(taskById?.values() ?? [])].filter((t) => t.blockedBy?.includes(task.id));
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("chatban.panelWidth"));
    return saved >= 320 ? saved : 400;
  });
  // #64: スマホでは幅指定をやめて全画面オーバーレイにする
  const [isWide, setIsWide] = useState(() => window.matchMedia("(min-width: 640px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const onChange = () => setIsWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // タスク専用チャット (#24)。ライフサイクルは共有フック (#23/#28/#29/#30)
  const chat = useChatTurn({
    request: (m, h, signal, attachments) => api.taskChat(task.id, m, h, signal, attachments),
    progressTaskId: task.id,
  });
  const { setLog } = chat;
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  // #68: 添付 (貼り付け / +ボタン)。原本非保存の蒸留型
  const atts = useAttachments();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLog([]);
    api.chatLog(task.id).then((r) => setLog(r.messages as ChatEntry[])).catch(() => {});
  }, [task.id, setLog]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [chat.log]);

  function submit() {
    const text = input.trim();
    if (!text || chat.sending) return;
    setInput("");
    chat.send(text, atts.attachments.length > 0 ? atts.attachments : undefined);
    atts.clear();
  }

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
      style={isWide ? { width } : undefined}
      className={
        isWide
          ? "relative flex h-full max-w-full shrink-0 flex-col border-l border-slate-200 bg-white"
          : "fixed inset-0 z-40 flex flex-col bg-white"
      }
    >
      {/* 幅スプリッター (スマホの全画面時は不要) */}
      {isWide && (
        <div
          onPointerDown={startResize}
          title="ドラッグで幅を調整"
          className="group absolute inset-y-0 left-0 z-10 flex w-2 cursor-col-resize items-center justify-center hover:bg-indigo-50"
        >
          <div className="h-10 w-1 rounded-full bg-slate-200 group-hover:bg-indigo-400" />
        </div>
      )}

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
        {/* #102: ゴミ箱にあるタスク。チャットの返答の #xx リンクからここに辿り着けるので、
            「元に戻せます」を毎回文章で説明する必要がない (くどくなる) */}
        {task.trashedAt && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span>🗑 このタスクはゴミ箱にあります ({task.trashedAt})</span>
            <button
              data-testid="restore-from-panel"
              onClick={() => api.restoreTask(task.id).then(() => onRestored?.())}
              className="ml-auto rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700"
            >
              戻す
            </button>
          </div>
        )}
        {archived && !task.trashedAt && (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {task.rejected
              ? "🚫 このタスクは却下として確定し、アーカイブ済みです (理由は下の割り振り理由・経緯メモ参照)"
              : "✅ このタスクは完了し、Doneの要約カードにアーカイブされました"}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {task.rejected && (
            <span className="rounded-full bg-rose-600 px-2.5 py-0.5 text-xs font-bold text-white">🚫 却下</span>
          )}
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.cls}`}>{status.label}</span>
          {task.due && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">⏰ 期限 {task.due}</span>
          )}
          {task.blockedBy && task.blockedBy.length > 0 && (
            <span className="text-[10px] text-slate-400" title="このタスクが待っている先">
              ⛓ 待ち{" "}
              {task.blockedBy.map((id) => (
                <DepChip
                  key={id}
                  id={id}
                  dep={taskById?.get(id)}
                  unresolved={(taskById?.get(id)?.status ?? "done") !== "done"}
                  onOpen={onOpenTask}
                  lanes={lanes}
                />
              ))}
            </span>
          )}
          {/* #111: 逆方向。依存は片方向にしか辿れないと行き止まりになる。
              「これを終わらせると何が動き出すか」は優先順位の判断材料そのもの */}
          {dependents.length > 0 && (
            <span className="text-[10px] text-slate-400" title="このタスクの完了を待っているタスク">
              🔓 これ待ち{" "}
              {dependents.map((d) => (
                <DepChip key={d.id} id={d.id} dep={d} unresolved tone="waiting" onOpen={onOpenTask} lanes={lanes} />
              ))}
            </span>
          )}
          <button
            onClick={() => onJumpToBoard(task.id)}
            className="ml-auto rounded-lg bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200"
          >
            📌 ボードで表示
          </button>
        </div>

        {task.summary && (
          <section>
            <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">現況</h3>
            <p className="text-sm text-slate-700">📝 {task.summary}</p>
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
          {chat.log.length === 0 && (
            <p className="text-xs text-slate-400">
              例:「これどう進めるのがいい？」「◯◯方式でいくことにした」→ 決定は経緯メモに残ります
            </p>
          )}
          {chat.log.map((e, i) => (
            <div key={i} className={`flex ${e.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-xl px-3 py-1.5 text-sm whitespace-pre-wrap ${
                  e.role === "user"
                    ? "bg-indigo-600 text-white"
                    : e.error
                      ? "border border-red-200 bg-red-50 text-red-700"
                      : "bg-white text-slate-900 shadow-sm"
                }`}
              >
                {e.pending ? (
                  <ThinkingIndicator label={e.content} elapsedSec={chat.elapsedSec} onStop={chat.stop} />
                ) : e.error ? (
                  <div className="flex items-center gap-2">
                    <span>{e.content}</span>
                    {e.retryText && (
                      <button
                        onClick={() => chat.send(e.retryText!)}
                        disabled={chat.sending}
                        className="shrink-0 rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                      >
                        🔄 再送
                      </button>
                    )}
                  </div>
                ) : e.role === "assistant" ? (
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
        <div className="px-3 pb-3">
          <AttachmentTray attachments={atts.attachments} error={atts.error} onRemove={atts.remove} />
          <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) atts.addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            title="画像/PDFを添付 (貼り付けも可)"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-200 text-lg text-slate-500 hover:bg-slate-300"
          >
            +
          </button>
          {/* #76: Enter=送信 / Shift+Enter=改行 */}
          <textarea
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
                (e.target as HTMLTextAreaElement).style.height = "auto";
              }
            }}
            onPaste={(e) => atts.addFromPaste(e)}
            placeholder={`#${task.id} について話す… (Shift+Enterで改行)`}
            className="min-w-0 flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button
            onClick={submit}
            disabled={chat.sending || !input.trim()}
            className="rounded-xl bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            送信
          </button>
          </div>
        </div>
      </section>
    </aside>
  );
}
