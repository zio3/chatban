import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAttachments, type Attachment } from "../hooks/useAttachments";
import AttachmentTray from "./AttachmentTray";
import ThinkingIndicator from "./ThinkingIndicator";
import type { ChatEntry } from "../types";

/** trace のチップに出す道具の名前 (「🔧 カード追加」)。進捗表示 (backend の TOOL_LABELS) は
 * 動詞形で、こちらは名詞形。**用途が違うので表は分けたまま**、揃っているかは
 * backend の toolLabels.test.ts が buildTools() と突き合わせて見張る (#229)。
 * 道具を増減したら、backend と合わせてここも直すこと */
const TOOL_LABELS: Record<string, string> = {
  create_cards: "カード追加",
  update_cards: "カード更新",
  // #102: 削除ではなくゴミ箱行き。画面に「削除」と出すと取り返しがつかないものに見える
  delete_cards: "ゴミ箱へ移動",
  restore_cards: "ゴミ箱から復元",
  reorder_cards: "並び順変更",
  search_cards: "経緯検索",
  query_log: "記録集計",
  update_project_context: "前提情報更新",
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
  askOptions,
  onOpenTask,
  onSend,
  onStop,
  onReset,
  canAttach = true,
}: {
  log: ChatEntry[];
  sending: boolean;
  elapsedSec: number;
  suggestions: Suggestion[];
  /** #213: 添付の入口が開いているか (公開デモでは閉じる)。押せないボタンを出さないため */
  canAttach?: boolean;
  /** AIが直前の返答に添えた簡易返信。押すとその文字列がそのまま発言として送られ、次の発言で消える */
  askOptions: string[];
  onOpenTask: (id: number) => void;
  onSend: (message: string, attachments?: Attachment[]) => void;
  onStop: () => void;
  onReset: () => void;
}) {
  const [input, setInput] = useState("");
  // #68: 添付 (D&D / クリップボード貼り付け / +ボタン)。原本非保存の蒸留型
  const atts = useAttachments();
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [logHeight, setLogHeight] = useState(() => {
    const saved = Number(localStorage.getItem("chatban.logHeight"));
    return saved >= 120 ? saved : 240;
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // #76: 複数行入力。textareaを内容に合わせて伸ばす (最大~6行)
  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }

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
  }, [log]);

  function submit() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    onSend(text, atts.attachments.length > 0 ? atts.attachments : undefined);
    atts.clear();
  }

  return (
    <section
      className={`relative shrink-0 border-t border-slate-200 bg-white ${dragOver ? "ring-2 ring-inset ring-indigo-400" : ""}`}
      onDragOver={(e) => {
        // preventDefault は**受けないときも必要**。外すとブラウザがファイルを開いて
        // ページから離脱する (入力中の下書きごと消える)
        e.preventDefault();
        // レビュー指摘 (2026-08-21): 受けないのに枠が光っていた。中央の案内だけ隠しても、
        // **枠とカーソルが「置ける」と言っている**ので誘っていることに変わりがない
        if (!canAttach) {
          e.dataTransfer.dropEffect = "none";
          return;
        }
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        // #213: ボタンを隠すだけでは、ドロップと貼り付けの経路が残る
        if (canAttach) atts.addFiles(e.dataTransfer.files);
      }}
    >
      {/* #213 + レビュー指摘 (2026-08-21): 受けないときは**誘わない**。
          dragOver が立たないので枠・カーソル・この案内がまとめて出ない
          (判定を1か所にしておけば、表示を足したときに片方だけ光る形にならない) */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-indigo-50/80 text-sm font-bold text-indigo-600">
          ここにドロップ (画像 / PDF)
        </div>
      )}
      <div>
        <div className="min-h-0">
          {/* #131: スプリッター行を「本文の外の帯」として使い、🆕 をここに置く。
              以前はログ領域に absolute で浮かせていたため、右寄せのユーザー吹き出しと
              重なって読めなくなっていた (スクロールするたびに別の行が当たるので、
              余白を足すだけでは解決しない) */}
          <div
            onPointerDown={startResize}
            title="ドラッグでチャット欄の高さを調整"
            className="group relative flex h-6 cursor-row-resize items-center justify-center bg-slate-50 hover:bg-indigo-50"
          >
            <div className="h-1 w-10 rounded-full bg-slate-300 group-hover:bg-indigo-400" />
            {/* 🆕 F5せずに初期状態(チップ+AI提案)へ戻す。表示とLLM文脈のリセットでDBの記録は残る。
                この行はドラッグ領域なので、ボタンの上ではリサイズを始めない */}
            {log.length > 0 && (
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onReset}
                title="会話をリセットして最初の提案に戻る (会話ログはDBに残ります)"
                className="absolute right-3 cursor-pointer rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-500 shadow-sm hover:bg-slate-100 hover:text-slate-700"
              >
                🆕 新しい会話
              </button>
            )}
          </div>
          <div className="relative" style={{ height: logHeight }}>
            <div ref={scrollRef} className="h-full space-y-2 overflow-y-auto px-4 py-3">
              {log.map((e, i) => (
                <div key={i} className={`flex ${e.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    // #122: whitespace-pre-wrap は「改行をそのまま見せたい」ユーザー発言と
                    // エラー文のためのもの。Markdownを組み立てるアシスタント側に効かせると、
                    // ソースの空行がそのまま空行として描画され、段落マージンと二重にかかる
                    className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${
                      e.role === "assistant" && !e.error ? "" : "whitespace-pre-wrap"
                    } ${
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
                      // 再送ボタンは置かない (レビュー指摘 2026-08-21)。
                      // 失敗しても**途中まで実行されている**ことがあり、押すと同じ操作が重複する
                      <span>{e.content}</span>
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
                      <>
                        {e.attachments && e.attachments.length > 0 && (
                          <div className="mb-1 flex flex-wrap gap-1">
                            {e.attachments.map((a, j) => (
                              <span key={j} className="rounded bg-indigo-500/60 px-1.5 py-0.5 text-[10px]">
                                {a.kind === "image" ? "🖼" : "📄"} {a.name}
                              </span>
                            ))}
                          </div>
                        )}
                        {renderUserText(e.content, onOpenTask)}
                      </>
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
                    {/* #31 → #181: ここはクリックでルーティング詳細 (使われたモデル・トークン・
                        キャッシュヒット) を展開できた。計測系ごと撤去したので、残すのは
                        「速いか遅いか」だけ。内訳が要るときは backend/logs/ を読む */}
                    {e.usage && (
                      <p className="mt-1 text-[10px] text-slate-500">
                        {(e.usage.elapsedMs / 1000).toFixed(1)}s · {e.usage.rounds}round
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {/* リコメンドチップは会話が始まる前だけ表示 (押した瞬間チャットが始まり消える #75)。
                  固定チップ=即時 / ✨AI提案=非同期でちょい後に合流 */}
              {/* AIが添えた簡易返信ボタン。承認UIではなく入力の近道なので、
                  押さずに自由に打ち返してよいし、無視して別の話をしてもよい */}
              {askOptions.length > 0 && !sending && (
                <div className="flex flex-wrap items-center gap-2 pt-1.5">
                  {askOptions.map((o, i) => (
                    <button
                      key={i}
                      data-testid={`ask-option-${i}`}
                      onClick={() => onSend(o)}
                      className="rounded-full border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 shadow-sm hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-700"
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
              {log.length === 0 && suggestions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2.5 pt-2">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      disabled={sending}
                      onClick={() => onSend(s.message)}
                      // 会話前の画面に4〜6個並ぶので、青一色にしない (B/C案の判断)。
                      // 押せることはホバーで示す
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 shadow-sm hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:opacity-40"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* 入力欄はClaude/ChatGPT作法: 角丸ピル+先頭の「+」=ファイル添付 (#68)。新規会話はログ右上の🆕 */}
          <div className="border-t border-slate-100 px-4 py-3">
            <AttachmentTray attachments={atts.attachments} error={atts.error} onRemove={atts.remove} />
            <div className="flex items-center gap-1.5 rounded-2xl border border-slate-300 bg-white px-2 py-1.5 focus-within:border-indigo-500">
              {/* #213: 添付を閉じているときは入口ごと出さない (断るのはサーバー側 #123) */}
              {canAttach && (
                <>
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
                  title="画像/PDFを添付 (貼り付け・ドロップも可)。原本は保存されず、AIが読んだ内容だけが残ります"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg text-slate-500 hover:bg-slate-100"
                >
                  +
                </button>
                </>
              )}
              {/* #76: Enter=送信 / Shift+Enter・Ctrl+Enter=改行 (AIチャット作法)。初期2段 */}
              <textarea
                ref={inputRef}
                value={input}
                rows={2}
                onChange={(e) => {
                  setInput(e.target.value);
                  autoResize(e.target);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  if (e.shiftKey) return; // 既定の改行に任せる
                  e.preventDefault();
                  if (e.ctrlKey) {
                    // Ctrl+Enterでも改行 (カーソル位置に挿入)
                    const el = e.currentTarget;
                    const { selectionStart: s, selectionEnd: en } = el;
                    setInput((v) => v.slice(0, s) + "\n" + v.slice(en));
                    requestAnimationFrame(() => {
                      el.selectionStart = el.selectionEnd = s + 1;
                      autoResize(el);
                    });
                  } else {
                    submit();
                  }
                }}
                onPaste={(e) => canAttach && atts.addFromPaste(e)}
                placeholder={
                  canAttach
                    ? "ボードに話しかける… (Shift+Enterで改行 / スクショやPDFも貼れます)"
                    : "ボードに話しかける… (Shift+Enterで改行)"
                }
                className="min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none"
              />
              <button
                onClick={submit}
                disabled={sending || !input.trim()}
                title="送信"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white disabled:opacity-30"
              >
                ↑
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
