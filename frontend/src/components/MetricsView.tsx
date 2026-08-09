import { useEffect, useState } from "react";

// #21 (zio方針 8/9): コスト表示は「こんだけやったけど、いくらでした」だけ。
// トークン量はモデル単価が数百倍散らばるため金額の代理にならない — 金額は請求APIの実費のみを正とする。
// 用途別/モデル別/リクエスト毎の内訳テーブルは意図的に持たない (必要ならOrcaRouterコンソールへ)
interface Metrics {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  billing: { totalUsageUsd: number } | null;
}

export default function MetricsView() {
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/metrics")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="p-6 text-sm text-red-600">読み込み失敗: {error}</p>;
  if (!data) return <p className="p-6 text-sm text-slate-400">読み込み中…</p>;

  const totalTokens = data.promptTokens + data.completionTokens;
  const tokenLabel = totalTokens >= 1_000_000 ? `${(totalTokens / 1_000_000).toFixed(1)}M` : `${Math.round(totalTokens / 1000)}k`;

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 p-10">
      <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-sm text-slate-500">ここまでのAI利用</p>
        <p className="mt-2 text-3xl font-bold tracking-tight">
          {data.totalCalls}回 <span className="text-lg font-normal text-slate-400">/ {tokenLabel} tokens</span>
        </p>
        <p className="mt-6 text-sm text-slate-500">かかったお金</p>
        <p className="mt-2 text-5xl font-bold tracking-tight text-emerald-700">
          {data.billing ? `$${data.billing.totalUsageUsd.toFixed(2)}` : "—"}
        </p>
        {data.billing && (
          <p className="mt-1 text-sm text-slate-400">約{Math.round(data.billing.totalUsageUsd * 150)}円 (OrcaRouter請求実額・マークアップなし)</p>
        )}
      </div>
      <p className="text-xs text-slate-400">内訳が必要なときは OrcaRouter コンソール (orcarouter.ai/console) へ</p>
    </div>
  );
}
