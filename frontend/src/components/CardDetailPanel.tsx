import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cardRefId, remarkCardLinks } from "../cardLinks";
import { api } from "../api";
import { useAttachments } from "../hooks/useAttachments";
import { useChatTurn } from "../hooks/useChatTurn";
import { useSplitter } from "../hooks/useSplitter";
import AttachmentTray from "./AttachmentTray";
import ThinkingIndicator from "./ThinkingIndicator";
import { DepChip, DueBadge } from "./Board";
import { statusLabel } from "../types";
import type { ChatEntry, CustomLane, Card } from "../types";

export default function CardDetailPanel({
  card,
  archived,
  onClose,
  onJumpToBoard,
  onRestored,
  cardById,
  onOpenCard,
  lanes = [],
  canAttach = true,
}: {
  card: Card;
  /** true: カードは完了→アーカイブ済み (表示は最後のスナップショット) */
  archived?: boolean;
  onClose: () => void;
  onJumpToBoard: (id: number) => void;
  /** #102: ゴミ箱から戻したあとの再読み込み */
  onRestored?: () => void;
  /** #111: 依存先の中身をチップから引く索引と、そこへ飛ぶための導線 */
  cardById?: Map<number, Card>;
  onOpenCard?: (id: number) => void;
  /** #19: 任意レーンの表示名。列バッジと依存チップに使う */
  lanes?: CustomLane[];
  /** 添付を受けられるか (板の配信が決める)。**チャット面は2つあるので両方に渡す** —
   * 以前はメインチャットにしか渡っておらず、カード専用チャットだけ
   * 「押せるのに断られる」状態だった (レビュー指摘 2026-08-21) */
  canAttach?: boolean;
}) {
  const status = statusLabel(card.status, lanes);
  // #111: このカードを待っている側 (被依存)。データは blocked_by にあるので逆引きで足りる。
  // 索引に載るのは未完了カードだけだが、完了したものはもう待っていないので実用上それでよい
  const dependents = [...(cardById?.values() ?? [])].filter((t) => t.blockedBy?.includes(card.id));
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

  // カード専用チャット (#24)。ライフサイクルは共有フック (#23/#28/#29/#30)
  const chat = useChatTurn({
    request: (m, h, signal, attachments) => api.cardChat(card.id, m, h, signal, attachments),
    progressCardId: card.id,
  });
  const { setLog } = chat;
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  // #273: チャット枠の**上限** (メインチャットの #271 と同じ規則)。実高さは min(内容, 上限)
  const [chatHeight, setChatHeight] = useState(() => {
    const saved = Number(localStorage.getItem("chatban.cardChatHeight"));
    return saved >= 120 ? saved : 240;
  });
  // #68: 添付 (貼り付け / +ボタン)。原本非保存の蒸留型
  const atts = useAttachments();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLog([]);
    api.chatLog(card.id).then((r) => setLog(r.messages as ChatEntry[])).catch(() => {});
  }, [card.id, setLog]);

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

  // 左端ドラッグで幅調整 (localStorageに保存)。ドラッグ処理は useSplitter (#246)
  const startResize = useSplitter({
    current: width,
    delta: (dx) => -dx, // 左へ動かすと幅が増える
    clamp: (w) => Math.min(Math.max(w, 320), Math.round(window.innerWidth * 0.7)),
    onChange: setWidth,
    onCommit: (w) => {
      setWidth(w);
      localStorage.setItem("chatban.panelWidth", String(w));
    },
  });

  // #273: チャット枠の上端ドラッグで上限を調整。手で動かすのは常に上限で、内容が少なければ縮む
  const startChatResize = useSplitter({
    current: chatHeight,
    delta: (_dx, dy) => -dy, // 上へ動かすと高さが増える
    clamp: (h) => Math.min(Math.max(h, 120), Math.round(window.innerHeight * 0.75)),
    onChange: setChatHeight,
    onCommit: (h) => {
      setChatHeight(h);
      localStorage.setItem("chatban.cardChatHeight", String(h));
    },
  });

  return (
    <aside
      data-testid="card-detail-panel"
      style={isWide ? { width } : undefined}
      className={
        isWide
          ? "relative flex h-full max-w-full shrink-0 flex-col border-l border-slate-200 bg-white"
          : "fixed inset-0 z-40 flex flex-col bg-white"
      }
    >
      {/* 幅スプリッター (スマホの全画面時は不要)。
          #246: touch-none が無いとタッチではブラウザがジェスチャをスクロールへ取り、
          ドラッグが効かない (FireTab 実機で報告)。掴み領域は w-2 (8px) では指に小さいので、
          -left-2 で外へ広げて 16px にする (見た目の線は今までどおり細いまま)。
          目印はタッチに hover が無いので、常時見える色を一段濃くした */}
      {isWide && (
        <div
          onPointerDown={startResize}
          title="ドラッグで幅を調整"
          className="group absolute inset-y-0 -left-2 z-10 flex w-4 cursor-col-resize touch-none items-center justify-center hover:bg-indigo-50/70"
        >
          <div className="h-10 w-1 rounded-full bg-slate-300 group-hover:bg-indigo-400" />
        </div>
      )}

      <header className="flex items-start justify-between gap-2 border-b border-slate-100 py-3 pl-4 pr-3">
        <div className="min-w-0">
          <p className="text-xs text-slate-500">#{card.id}</p>
          <h2 className="text-base font-bold leading-snug">{card.title}</h2>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100"
          title="閉じる"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {/* #102: ゴミ箱にあるカード。チャットの返答の #xx リンクからここに辿り着けるので、
            「元に戻せます」を毎回文章で説明する必要がない (くどくなる) */}
        {card.trashedAt && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span>🗑 このカードはゴミ箱にあります ({card.trashedAt})</span>
            <button
              data-testid="restore-from-panel"
              onClick={() => api.restoreCard(card.id).then(() => onRestored?.())}
              className="ml-auto rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700"
            >
              戻す
            </button>
          </div>
        )}
        {archived && !card.trashedAt && (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {card.rejected
              ? // #233: 「割り振り理由」を見に行かせていたが、その欄は #179 で列ごと落ちている。
                // 却下の理由は現況と経緯メモに書く (rejected の契約もそう案内している)
                "🚫 このカードは却下として確定し、アーカイブ済みです (理由は下の現況・経緯メモ参照)"
              : // #233: 「Doneの要約カード」も #200 で撤去済み。いまは 📦 畳んだ完了 に入る
                "✅ このカードは完了し、Done列の「📦 畳んだ完了」に畳まれています"}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {card.rejected && (
            <span className="rounded-full bg-rose-600 px-2.5 py-0.5 text-xs font-bold text-white">🚫 却下</span>
          )}
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.cls}`}>{status.label}</span>
          {/* #228: 以前はここだけ自前で整形しており、**期限切れでも普通の期限に見えていた** */}
          {card.due && <DueBadge due={card.due} long />}
          {card.blockedBy && card.blockedBy.length > 0 && (
            <span className="text-[10px] text-slate-500" title="このカードが待っている先">
              ⛓ 待ち{" "}
              {card.blockedBy.map((id) => (
                <DepChip
                  key={id}
                  id={id}
                  dep={cardById?.get(id)}
                  unresolved={(cardById?.get(id)?.status ?? "done") !== "done"}
                  onOpen={onOpenCard}
                  lanes={lanes}
                />
              ))}
            </span>
          )}
          {/* #111: 逆方向。依存は片方向にしか辿れないと行き止まりになる。
              「これを終わらせると何が動き出すか」は優先順位の判断材料そのもの */}
          {dependents.length > 0 && (
            <span className="text-[10px] text-slate-500" title="このカードの完了を待っているカード">
              🔓 これ待ち{" "}
              {dependents.map((d) => (
                <DepChip key={d.id} id={d.id} dep={d} unresolved tone="waiting" onOpen={onOpenCard} lanes={lanes} />
              ))}
            </span>
          )}
          <button
            onClick={() => onJumpToBoard(card.id)}
            className="ml-auto rounded-lg bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200"
          >
            📌 ボードで表示
          </button>
        </div>

        {card.summary && (
          <section>
            <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">現況</h3>
            <p className="text-sm text-slate-700">📝 {card.summary}</p>
          </section>
        )}

        <section>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">経緯メモ</h3>
          {card.context ? (
            <div className="chat-md rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              <Markdown remarkPlugins={[remarkGfm, remarkCardLinks]} components={cardLinkComponents(onOpenCard)}>
                {card.context}
              </Markdown>
            </div>
          ) : (
            <p className="text-sm text-slate-500">まだありません。下のチャットで話すと決定事項が記録されます</p>
          )}
        </section>

        <p className="text-xs text-slate-500">作成 {card.createdAt} / 更新 {card.updatedAt}</p>
      </div>

      {/* カード専用チャット (#24)。
          #273: 高さは h-1/2 固定をやめ、メインチャット (#271) と同じ「min(内容, 手で決めた上限)」。
          会話が空のときは帯もログ枠も出さず入力欄だけ (見出し「このカードのチャット」と例文は
          zio 判断で撤去 — 入力欄の placeholder が同じことを言っている) */}
      <section className="flex shrink-0 flex-col border-t border-slate-200 bg-slate-50/50">
        {chat.log.length > 0 && (
          <>
            <div
              onPointerDown={startChatResize}
              title="ドラッグでカードチャットの高さを調整"
              // #246: touch-none が無いとタッチでドラッグが効かない
              className="group flex h-6 cursor-row-resize touch-none items-center justify-center hover:bg-indigo-50"
            >
              <div className="h-1 w-10 rounded-full bg-slate-300 group-hover:bg-indigo-400" />
            </div>
            <div ref={logRef} className="space-y-2 overflow-y-auto px-3 py-2" style={{ maxHeight: chatHeight }}>
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
                      // 再送ボタンは置かない (レビュー指摘 2026-08-21)。メインチャットと同じ理由 —
                      // 失敗しても途中まで実行されていることがあり、押すと同じ操作が重複する
                      <span>{e.content}</span>
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
          </>
        )}
        <div className="px-3 py-3">
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
          {/* #213: 添付を閉じているときは入口ごと出さない (断るのはサーバー側 #123) */}
          {canAttach && (
            <button
              onClick={() => fileInputRef.current?.click()}
              title="画像/PDFを添付 (貼り付けも可)"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-200 text-lg text-slate-500 hover:bg-slate-300"
            >
              +
            </button>
          )}
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
            onPaste={(e) => canAttach && atts.addFromPaste(e)}
            placeholder={`#${card.id} について話す… (Shift+Enterで改行)`}
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

/** #248: 経緯メモの `#123` を押せるようにする。
 *
 * `remarkCardLinks` が `data-card-id` を付けた `<a>` を作るので、それだけを差し替える。
 * **普通のリンクはそのまま**通す (経緯メモにはPRやドキュメントのURLも書かれる)。
 *
 * 押しても**画面遷移はしない** — 開くのは親から渡された `onOpenCard` で、
 * 板に無いカードを引き直すのも、存在しないときにトーストを出すのも、そちらが既にやっている。 */
function cardLinkComponents(onOpenCard?: (id: number) => void) {
  return {
    a(props: any) {
      // **`node` は react-markdown がコンポーネントへ渡す内部の値**で、DOMへ流すと
      // `<a node="[object Object]">` になる。**先に落とす** — 以前はカード参照側だけで
      // 落としていて、普通のリンク全部に付いていた (Codexレビュー P3)
      const { node: _node, href, children, ...rest } = props;
      const id = cardRefId(props);
      if (id === null)
        return (
          <a {...rest} href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );

      // href は渡さない。**空文字のまま button へ渡すと React が警告する**
      // (リンクではなくボタンとして描くので、そもそも行き先を持たない)
      return (
        <button
          {...rest}
          type="button"
          data-testid={`card-ref-${id}`}
          onClick={() => onOpenCard?.(id)}
          className="rounded px-0.5 font-medium text-indigo-600 underline decoration-dotted underline-offset-2 hover:bg-indigo-50 hover:decoration-solid"
          title={`#${id} を開く`}
        >
          {children}
        </button>
      );
    },
  };
}
