import { apiFetch } from "../api";
import { socket } from "../socket";
import { useCallback, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// #73: プロジェクト前提情報の閲覧ビュー。編集UIは意図的に無い —
// 変更はチャットで伝える (新規カード作成をチャット専用にしたのと同じ「会話が構造の代わり」原則)
export default function ContextView() {
  const [data, setData] = useState<{ text: string; updatedAt: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch("/api/project-context")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        // 取れたらエラー表示から戻る。消さないと、一度切れた画面が
        // 繋ぎ直しても「読み込み失敗」のままになる (レビュー指摘 2026-08-21、2周目)
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // **開いたまま古い本文を読み続けない** (レビュー指摘 2026-08-21)。
  // この画面は編集UIを持たず、変更経路はチャット (と外部エージェント) だけなので、
  // 取得がマウント時の1回だけだと**設計上の唯一の使い方で必ず古くなる**。
  // 本文は配信に載せず「変わった」とだけ受けて取り直す (板の配信を太らせない / #226 と同じ線)
  useEffect(() => {
    load();
    // **繋ぎ直したら読み直す。**Socket.IO は切れていた間のイベントを再送しないので、
    // 通知を受ける形だけだと「スリープ中に書き換えられた」を取りこぼす。
    // App.tsx が board:changed に対して同じことをしている (#97 の繋ぎ直し処理と同じ形)
    let everConnected = socket.connected;
    const onConnect = () => {
      if (everConnected) load();
      everConnected = true;
    };
    socket.on("context:changed", load);
    socket.on("connect", onConnect);
    return () => {
      socket.off("context:changed", load);
      socket.off("connect", onConnect);
    };
  }, [load]);

  if (error) return <p className="p-6 text-sm text-red-600">読み込み失敗: {error}</p>;
  if (!data) return <p className="p-6 text-sm text-slate-500">読み込み中…</p>;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-bold text-slate-600">📋 プロジェクトの前提情報 (全員共有・AIのプロンプトに常駐)</h2>
        {data.updatedAt && <span className="text-xs text-slate-500">最終更新 {data.updatedAt}</span>}
      </div>
      {data.text ? (
        <div className="chat-md rounded-xl border border-slate-200 bg-white p-5 text-sm leading-relaxed text-slate-700">
          <Markdown remarkPlugins={[remarkGfm]}>{data.text}</Markdown>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-500">
          まだ前提情報はありません
        </p>
      )}
      <p className="text-xs text-slate-500">
        変更したいときはチャットで伝えてください (例:「締切が8/16に延びたよ」) — AIが前提情報に反映します
      </p>
    </div>
  );
}
