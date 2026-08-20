import { apiFetch } from "../api";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// #73: プロジェクト前提情報の閲覧ビュー。編集UIは意図的に無い —
// 変更はチャットで伝える (新規カード作成をチャット専用にしたのと同じ「会話が構造の代わり」原則)
export default function ContextView() {
  const [data, setData] = useState<{ text: string; updatedAt: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/project-context")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

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
