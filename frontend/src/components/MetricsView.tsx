import { apiFetch } from "../api";
import { useEffect, useState } from "react";

// #21 (zio方針 8/9): 上部は「こんだけやったけど、いくらでした」の2数字だけ。金額の正は請求APIの実費。
// その下に直近50件のリストを置き、各行にコスト概算を添える (8/10)。
// 概算は routed_model の公式単価 × 実測トークン。実測では主力モデルは請求と100%一致したが、
// カタログ単価が実態とずれるモデルもあるため「概算」と明記し、確定額は上部を見てもらう。
interface Call {
  id: number;
  purpose: string;
  routed_model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  elapsed_ms: number;
  created_at: string;
  estimatedUsd: number | null;
}
interface Metrics {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  billing: { totalUsageUsd: number } | null;
  recent: Call[];
}

const PURPOSE_LABEL: Record<string, string> = {
  chat: "対話",
  suggest: "提案チップ",
  "archive-decompose": "要約分解",
  "archive-title": "要約タイトル",
};

function fmtUsd(v: number | null) {
  if (v == null) return "-";
  return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`;
}

export default function MetricsView() {
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/metrics")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="p-6 text-sm text-red-600">読み込み失敗: {error}</p>;
  if (!data) return <p className="p-6 text-sm text-slate-400">読み込み中…</p>;

  const totalTokens = data.promptTokens + data.completionTokens;
  const tokenLabel = totalTokens >= 1_000_000 ? `${(totalTokens / 1_000_000).toFixed(1)}M` : `${Math.round(totalTokens / 1000)}k`;

  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-8 p-10">
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
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

      <div className="w-full">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-bold">直近の呼び出し (最新50件)</h3>
          <p className="text-[11px] text-slate-400">
            コストは公式の利用料金表から計算した概算です。実際の請求額とは異なる場合があります —
            <strong className="text-slate-500">確定額は上の金額</strong>をご覧ください
          </p>
        </div>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-100 text-slate-400">
              <tr>
                <th className="px-3 py-2">時刻</th>
                <th className="px-3 py-2">用途</th>
                <th className="px-3 py-2">モデル</th>
                <th className="px-3 py-2 text-right">in/out tk</th>
                <th className="px-3 py-2 text-right">cache</th>
                <th className="px-3 py-2 text-right">秒</th>
                <th className="px-3 py-2 text-right">コスト概算</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r) => (
                <tr key={r.id} className="border-b border-slate-50">
                  <td className="px-3 py-2 text-slate-400">{r.created_at}</td>
                  <td className="px-3 py-2">{PURPOSE_LABEL[r.purpose] ?? r.purpose}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{r.routed_model ?? "-"}</td>
                  <td className="px-3 py-2 text-right">
                    {r.prompt_tokens.toLocaleString()}/{r.completion_tokens.toLocaleString()}
                  </td>
                  {/* キャッシュヒットは入力の何割かが定価の1割で済むので、コストの効き方が一番大きい列 */}
                  <td className="px-3 py-2 text-right text-emerald-600">
                    {r.cached_tokens ? r.cached_tokens.toLocaleString() : "-"}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-400">{(r.elapsed_ms / 1000).toFixed(1)}</td>
                  <td className="px-3 py-2 text-right font-medium">{fmtUsd(r.estimatedUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          単価は OrcaRouter の /v1/models から取得。キャッシュ入力は定価の10%として計算しています (カタログに単価欄がないための仮定値)。
          全件は 📜監査タブの「全ログExport」から取得できます。
        </p>
      </div>
    </div>
  );
}
