import { useCallback, useEffect, useRef, useState } from "react";
import { socket } from "../socket";
import type { ChatEntry, ChatResponse } from "../types";

const TIMEOUT_MS = 90_000;

/**
 * チャット1リクエストのライフサイクル管理 (#23/#28/#29/#30)。
 * 送信 → 考え中 → ツール実行中(chat:progress) → 完了 / エラー / タイムアウト / 手動停止 を
 * 1つの状態機械としてまとめ、メインチャットとタスクチャットで共用する。
 * 停止はクライアント側破棄のみ (サーバーのLLMループは走り切り、結果はボードに反映される)。
 */
export function useChatTurn(opts: {
  request: (
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    signal: AbortSignal
  ) => Promise<ChatResponse>;
  /** chat:progress を拾う対象。null=メインチャット / number=そのタスクのチャット */
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
    function onProgress(p: { label: string; taskId?: number }) {
      if ((p.taskId ?? null) !== progressTaskId) return;
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

  const send = useCallback(async (message: string) => {
    const text = message.trim();
    if (!text || abortRef.current) return;
    const history = logRef.current
      .filter((e) => !e.pending && !e.error)
      .map((e) => ({ role: e.role, content: e.content }));
    setSending(true);
    setLog((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "考え中…", pending: true }]);
    const controller = new AbortController();
    abortRef.current = controller;
    stopReasonRef.current = null;
    const timeout = window.setTimeout(() => {
      stopReasonRef.current = "timeout";
      controller.abort();
    }, TIMEOUT_MS);
    try {
      const res = await optsRef.current.request(text, history, controller.signal);
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
      setLog((prev) => [...prev.filter((en) => !en.pending), { role: "assistant", content, error: true, retryText: text }]);
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
