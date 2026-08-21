import { useCallback, useEffect, useRef, useState } from "react";
import { socket } from "../socket";
import type { ChatEntry, ChatResponse } from "../types";

const TIMEOUT_MS = 90_000;

/**
 * チャット1リクエストのライフサイクル管理 (#23/#28/#29/#30)。
 * 送信 → 考え中 → ツール実行中(chat:progress) → 完了 / エラー / タイムアウト / 手動停止 を
 * 1つの状態機械としてまとめ、メインチャットとカードチャットで共用する。
 * 停止はクライアント側破棄のみ (サーバーのLLMループは走り切り、結果はボードに反映される)。
 */
export interface TurnAttachment {
  kind: "image" | "pdf";
  name: string;
  dataUrl: string;
}

export function useChatTurn(opts: {
  request: (
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    signal: AbortSignal,
    attachments?: TurnAttachment[]
  ) => Promise<ChatResponse>;
  /** chat:progress を拾う対象。null=メインチャット / number=そのカードのチャット */
  progressTaskId?: number | null;
  onResponse?: (res: ChatResponse) => void;
}) {
  const { progressTaskId = null } = opts;
  const [log, setLog] = useState<ChatEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const logRef = useRef(log);
  logRef.current = log;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const abortRef = useRef<AbortController | null>(null);
  const stopReasonRef = useRef<"stopped" | "timeout" | null>(null);

  // ツール実行の逐次フィードバック: 応答待ちの吹き出しに実行中の操作を表示
  useEffect(() => {
    function onProgress(p: { label: string; cardId?: number }) {
      if ((p.cardId ?? null) !== progressTaskId) return;
      setLog((prev) => prev.map((e) => (e.pending ? { ...e, content: `${p.label}中…` } : e)));
    }
    socket.on("chat:progress", onProgress);
    return () => {
      socket.off("chat:progress", onProgress);
    };
  }, [progressTaskId]);

  // 応答待ちの経過秒 (無応答不安の可視化)
  useEffect(() => {
    if (!sending) return;
    setElapsedSec(0);
    const t0 = Date.now();
    const id = window.setInterval(() => setElapsedSec(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [sending]);

  const send = useCallback(async (message: string, attachments?: TurnAttachment[]) => {
    const text = message.trim();
    if (!text || abortRef.current) return;
    const history = logRef.current
      .filter((e) => !e.pending && !e.error)
      .map((e) => ({ role: e.role, content: e.content }));
    setSending(true);
    setLog((prev) => [
      ...prev,
      {
        role: "user",
        content: text,
        ...(attachments?.length ? { attachments: attachments.map((a) => ({ kind: a.kind, name: a.name })) } : {}),
      },
      { role: "assistant", content: "考え中…", pending: true },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    stopReasonRef.current = null;
    const timeout = window.setTimeout(() => {
      stopReasonRef.current = "timeout";
      controller.abort();
    }, TIMEOUT_MS);
    try {
      const res = await optsRef.current.request(text, history, controller.signal, attachments);
      setLog((prev) => [
        ...prev.filter((e) => !e.pending),
        { role: "assistant", content: res.reply || "(操作を実行しました)", trace: res.trace, usage: res.usage },
      ]);
      optsRef.current.onResponse?.(res);
    } catch (e: any) {
      const reason = stopReasonRef.current;
      const content =
        reason === "stopped"
          ? "⏹ 応答の受信を停止しました (実行済みの操作はボードに反映されます)"
          : reason === "timeout"
            ? `⏱ ${TIMEOUT_MS / 1000}秒応答がないため打ち切りました`
            : `エラー: ${e?.message ?? e}`;
      // **再送を出してよい失敗と、出してはいけない失敗がある** (レビュー指摘 2026-08-21)。
      //
      // 停止・タイムアウトは**クライアント側で受信を捨てただけ**で、サーバーのLLM処理は続いている
      // (エラー文自身が「実行済みの操作はボードに反映されます」と言っている)。
      // ここで再送すると元の処理と並走し、**同じ操作が二重に走る** —
      // 「カードを追加して」で停止 → 再送 → カードが2枚できる。表示ではなくデータが増える。
      //
      // 添付付きは別の理由で出さない。原本を保持しない方針 (#68) なので、
      // 再送すると**テキストだけの別のリクエストになる** — 「送ったのに読まれていない」(#123) の再来。
      // 添付し直してもらうほうが速いし、嘘がない
      const interrupted = reason === "stopped" || reason === "timeout";
      const hadAttachments = !!attachments?.length;
      // 中断は文面が既に事情を説明しているので足さない。添付ありのときだけ「どうすればよいか」を添える
      const detail = !interrupted && hadAttachments ? " — 添付をもう一度付けて送り直してください" : "";
      const canRetry = !interrupted && !hadAttachments;
      setLog((prev) => [
        ...prev.filter((en) => !en.pending),
        { role: "assistant", content: content + detail, error: true, ...(canRetry ? { retryText: text } : {}) },
      ]);
    } finally {
      window.clearTimeout(timeout);
      abortRef.current = null;
      setSending(false);
    }
  }, []);

  const stop = useCallback(() => {
    if (!abortRef.current) return;
    stopReasonRef.current = "stopped";
    abortRef.current.abort();
  }, []);

  return { log, setLog, sending, elapsedSec, send, stop };
}
