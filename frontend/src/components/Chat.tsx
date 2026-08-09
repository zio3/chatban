import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatEntry, Proposal } from "../types";

const TOOL_LABELS: Record<string, string> = {
  create_tasks: "タスク追加",
  update_tasks: "タスク更新",
  delete_tasks: "タスク削除",
  propose_assignments: "割り振り提案",
  set_view: "ビュー切替",
  update_project_context: "前提情報更新",
  compact_archive: "ログ整頓",
  get_task_details: "詳細取得",
  update_task_context: "経緯メモ更新",
  resolve_proposals: "提案を承認/却下",
};

export interface Suggestion {
  label: string;
  message: string;
}

export default function Chat({
  log,
  sending,
  suggestions,
  proposals,
  onResolveProposal,
  onSend,
}: {
  log: ChatEntry[];
  sending: boolean;
  suggestions: Suggestion[];
  proposals: Proposal[];
  onResolveProposal: (id: number, action: "approve" | "reject") => void;
  onSend: (message: string) => void;
}) {
  const [input, setInput] = useState("");
  const [opened, setOpened] = useState(false);
  const [logHeight, setLogHeight] = useState(() => {
    const saved = Number(localStorage.getItem("chatban.logHeight"));
    return saved >= 120 ? saved : 240;
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // スプリッター: 上端をドラッグしてログ欄の高さを調整 (localStorageに保存)
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = logHeight;
    function onMove(ev: PointerEvent) {
      const next = Math.min(Math.max(startHeight + (startY - ev.clientY), 120), Math.round(window.innerHeight * 0.75));
      setLogHeight(next);
    }
    function onUp(ev: PointerEvent) {
      const finalHeight = Math.min(Math.max(startHeight + (startY - ev.clientY), 120), Math.round(window.innerHeight * 0.75));
      localStorage.setItem("chatban.logHeight", String(finalHeight));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // 開閉は明示的な状態で持つ(入力フォーカスと連動させない)。新しいやり取り・提案が来たら自動で開く
  const expanded = opened;

  useEffect(() => {
    if (log.length > 0 || proposals.length > 0) setOpened(true);
  }, [log.length, proposals.length]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [log, expanded, proposals.length]);

  function submit() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    onSend(text);
  }

  return (
    <section className="shrink-0 border-t border-slate-200 bg-white">
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            onPointerDown={startResize}
            title="ドラッグでチャット欄の高さを調整"
            className="group flex h-3 cursor-row-resize items-center justify-center bg-slate-50 hover:bg-indigo-50"
          >
            <div className="h-1 w-10 rounded-full bg-slate-300 group-hover:bg-indigo-400" />
          </div>
          <div className="relative" style={{ height: logHeight }}>
            <div ref={scrollRef} className="h-full space-y-2 overflow-y-auto px-4 py-3">
              {log.map((e, i) => (
                <div key={i} className={`flex ${e.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                      e.role === "user" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-900"
                    } ${e.pending ? "animate-pulse" : ""}`}
                  >
                    {e.role === "assistant" ? (
                      <div className="chat-md">
                        <Markdown remarkPlugins={[remarkGfm]}>{e.content}</Markdown>
                      </div>
                    ) : (
                      e.content
                    )}
                    {e.trace && e.trace.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {e.trace.map((t, j) => (
                          <span key={j} className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600">
                            🔧 {TOOL_LABELS[t.tool] ?? t.tool}
                          </span>
                        ))}
                      </div>
                    )}
                    {e.usage && (
                      <p className="mt-1 text-[10px] text-slate-400">
                        {(e.usage.elapsedMs / 1000).toFixed(1)}s · {e.usage.promptTokens + e.usage.completionTokens}tk ·{" "}
                        {e.usage.rounds}round
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {/* 承認待ちの割り振り提案はチャットの流れの中に出す。調整・理由の会話がここで続けられる */}
              {proposals.length > 0 && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
                    <p className="mb-1.5 text-xs font-bold text-amber-700">🤖 割り振り提案 — 承認で確定。修正はそのまま返信でOK</p>
                    <div className="space-y-1.5">
                      {proposals.map((p) => (
                        <div key={p.id} className="rounded-lg border border-amber-100 bg-white px-3 py-2 text-sm">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              #{p.taskId} {p.taskTitle}
                            </span>
                            <span className="text-slate-400">→</span>
                            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                              {p.assignee}
                            </span>
                            <span className="ml-auto flex gap-1.5">
                              <button
                                onClick={() => onResolveProposal(p.id, "approve")}
                                className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                              >
                                承認
                              </button>
                              <button
                                onClick={() => onResolveProposal(p.id, "reject")}
                                className="rounded-md bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-300"
                              >
                                却下
                              </button>
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-slate-500">💡 {p.reason}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={() => setOpened(false)}
              title="チャット欄を畳む"
              className="absolute right-3 top-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-200"
            >
              ▼ 畳む
            </button>
          </div>
          <div className="flex gap-2 border-t border-slate-100 px-4 py-3">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
              }}
              placeholder="ボードに話しかける…（例: 候補挙げて / いい感じに振っといて）"
              className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
            />
            <button
              onClick={submit}
              disabled={sending || !input.trim()}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              送信
            </button>
          </div>
        </div>
      </div>
      {/* 畳んだ状態: 話しかけるボタン + リコメンド置き場 */}
      {!expanded && (
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            onClick={() => {
              setOpened(true);
              setTimeout(() => inputRef.current?.focus(), 320); // 開くアニメーション後にフォーカス
            }}
            className="flex shrink-0 items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-indigo-700"
          >
            💬 ボードに話しかける
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
            {suggestions.map((s, i) => (
              <button
                key={i}
                disabled={sending}
                onClick={() => onSend(s.message)}
                className="shrink-0 rounded-full border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-sm text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
              >
                {s.label}
              </button>
            ))}
            {log.length > 0 && (
              <button
                onClick={() => setOpened(true)}
                className="shrink-0 rounded-full bg-slate-100 px-3 py-2 text-xs text-slate-500 hover:bg-slate-200"
              >
                ▲ ログ {log.length}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
