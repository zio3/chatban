import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ThinkingIndicator from "./ThinkingIndicator";
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

/** #NN メンションをMarkdownリンクに変換 (リンク先は #task-NN、レンダラ側でクリックを拾う) */
function linkifyMentions(text: string): string {
  return text.replace(/#(\d+)/g, "[#$1](#task-$1)");
}

/** ユーザー発話(プレーンテキスト)用: #NN をクリック可能なspanに分解 */
function renderUserText(text: string, onOpenTask: (id: number) => void) {
  const parts = text.split(/(#\d+)/g);
  return parts.map((p, i) => {
    const m = p.match(/^#(\d+)$/);
    if (!m) return <span key={i}>{p}</span>;
    return (
      <button key={i} onClick={() => onOpenTask(Number(m[1]))} className="font-bold underline decoration-dotted underline-offset-2">
        {p}
      </button>
    );
  });
}

export default function Chat({
  log,
  sending,
  elapsedSec,
  suggestions,
  proposals,
  onResolveProposal,
  onOpenTask,
  onSend,
  onStop,
}: {
  log: ChatEntry[];
  sending: boolean;
  elapsedSec: number;
  suggestions: Suggestion[];
  proposals: Proposal[];
  onResolveProposal: (id: number, action: "approve" | "reject") => void;
  onOpenTask: (id: number) => void;
  onSend: (message: string) => void;
  onStop: () => void;
}) {
  const [input, setInput] = useState("");
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

  // チャットはこのシステムのアイデンティティなので常設 (畳みUIは廃止 zio判断 8/9)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [log, proposals.length]);

  function submit() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    onSend(text);
  }

  return (
    <section className="shrink-0 border-t border-slate-200 bg-white">
      <div>
        <div className="min-h-0">
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
                      e.role === "user"
                        ? "bg-indigo-600 text-white"
                        : e.error
                          ? "border border-red-200 bg-red-50 text-red-700"
                          : "bg-slate-100 text-slate-900"
                    }`}
                  >
                    {e.pending ? (
                      <ThinkingIndicator label={e.content} elapsedSec={elapsedSec} onStop={onStop} />
                    ) : e.error ? (
                      <div className="flex items-center gap-2">
                        <span>{e.content}</span>
                        {e.retryText && (
                          <button
                            onClick={() => onSend(e.retryText!)}
                            disabled={sending}
                            className="shrink-0 rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                          >
                            🔄 再送
                          </button>
                        )}
                      </div>
                    ) : e.role === "assistant" ? (
                      <div className="chat-md">
                        <Markdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => {
                              const m = href?.match(/^#task-(\d+)$/);
                              if (m) {
                                return (
                                  <button
                                    onClick={() => onOpenTask(Number(m[1]))}
                                    className="font-bold text-indigo-600 underline decoration-dotted underline-offset-2 hover:text-indigo-800"
                                  >
                                    {children}
                                  </button>
                                );
                              }
                              return (
                                <a href={href} target="_blank" rel="noreferrer" className="underline">
                                  {children}
                                </a>
                              );
                            },
                          }}
                        >
                          {linkifyMentions(e.content)}
                        </Markdown>
                      </div>
                    ) : (
                      renderUserText(e.content, onOpenTask)
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
                    {e.usage &&
                      (e.usage.calls?.length ? (
                        // クリックでルーティング詳細 (実際に使われたモデル・キャッシュヒット) を展開 (#31)
                        <details className="mt-1 text-[10px] text-slate-400">
                          <summary className="cursor-pointer select-none hover:text-slate-600">
                            {(e.usage.elapsedMs / 1000).toFixed(1)}s · {e.usage.promptTokens + e.usage.completionTokens}
                            tk · {e.usage.rounds}round
                          </summary>
                          <div className="mt-1 space-y-0.5 rounded bg-slate-200/60 px-1.5 py-1 font-mono">
                            {e.usage.calls.map((c, j) => (
                              <p key={j}>
                                {j + 1}. {c.model} · in {c.promptTokens}tk
                                {c.cachedTokens > 0 && ` (cache ${c.cachedTokens})`} · out {c.completionTokens}tk ·{" "}
                                {(c.elapsedMs / 1000).toFixed(1)}s
                              </p>
                            ))}
                          </div>
                        </details>
                      ) : (
                        <p className="mt-1 text-[10px] text-slate-400">
                          {(e.usage.elapsedMs / 1000).toFixed(1)}s · {e.usage.promptTokens + e.usage.completionTokens}tk ·{" "}
                          {e.usage.rounds}round
                        </p>
                      ))}
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
                            <button onClick={() => onOpenTask(p.taskId)} className="text-left font-medium hover:underline">
                              #{p.taskId} {p.taskTitle}
                            </button>
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
              {/* リコメンドチップはログの流れの中に置く (会話の次の一手として提示) */}
              {suggestions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      disabled={sending}
                      onClick={() => onSend(s.message)}
                      className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* #20却下: アプリ内音声入力の入口は撤去 (OSの音声入力で足りる)。useVoiceInputフックは温存 */}
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
    </section>
  );
}
