import { useEffect, useState } from "react";

// #21: OrcaRouter利用状況の簡易ダッシュボード。/api/metrics の集計をそのまま表示する
interface Metrics {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  avgElapsedMs: number;
  byModel: { model: string; calls: number; pt: number; ct: number; cached: number; avgMs: number }[];
  byPurpose: { purpose: string; calls: number; pt: number; ct: number; cached: number; avgMs: number; models: number }[];
  recent: {
    id: number;
    purpose: string;
    model: string;
    routed_model: string | null;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    elapsed_ms: number;
    created_at: string;
  }[];
}

function kt(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
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

  const cacheRate = data.promptTokens > 0 ? Math.round((data.cachedTokens / data.promptTokens) * 100) : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "総呼び出し", value: String(data.totalCalls) },
          { label: "入力トークン", value: kt(data.promptTokens) },
          { label: "キャッシュヒット率", value: `${cacheRate}%` },
          { label: "平均レイテンシ", value: `${(data.avgElapsedMs / 1000).toFixed(1)}s` },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs text-slate-400">{c.label}</p>
            <p className="mt-1 text-2xl font-bold">{c.value}</p>
          </div>
        ))}
      </div>

      <section>
        <h2 className="mb-2 text-sm font-bold text-slate-600">用途別 (対話=固定 / 要約=品質ルーティング / 定型=コスト優先)</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-100 text-slate-400">
              <tr>
                <th className="px-3 py-2">purpose</th>
                <th className="px-3 py-2 text-right">calls</th>
                <th className="px-3 py-2 text-right">入力tk</th>
                <th className="px-3 py-2 text-right">出力tk</th>
                <th className="px-3 py-2 text-right">cache</th>
                <th className="px-3 py-2 text-right">平均秒</th>
                <th className="px-3 py-2 text-right">経由モデル数</th>
              </tr>
            </thead>
            <tbody>
              {data.byPurpose.map((p) => (
                <tr key={p.purpose} className="border-b border-slate-50">
                  <td className="px-3 py-2 font-medium">{p.purpose}</td>
                  <td className="px-3 py-2 text-right">{p.calls}</td>
                  <td className="px-3 py-2 text-right">{kt(p.pt)}</td>
                  <td className="px-3 py-2 text-right">{kt(p.ct)}</td>
                  <td className="px-3 py-2 text-right">{kt(p.cached)}</td>
                  <td className="px-3 py-2 text-right">{(p.avgMs / 1000).toFixed(1)}</td>
                  <td className="px-3 py-2 text-right">{p.models}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold text-slate-600">指定モデル別</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-100 text-slate-400">
              <tr>
                <th className="px-3 py-2">model</th>
                <th className="px-3 py-2 text-right">calls</th>
                <th className="px-3 py-2 text-right">入力tk</th>
                <th className="px-3 py-2 text-right">出力tk</th>
                <th className="px-3 py-2 text-right">cache</th>
                <th className="px-3 py-2 text-right">平均秒</th>
              </tr>
            </thead>
            <tbody>
              {data.byModel.map((m) => (
                <tr key={m.model} className="border-b border-slate-50">
                  <td className="px-3 py-2 font-mono">{m.model}</td>
                  <td className="px-3 py-2 text-right">{m.calls}</td>
                  <td className="px-3 py-2 text-right">{kt(m.pt)}</td>
                  <td className="px-3 py-2 text-right">{kt(m.ct)}</td>
                  <td className="px-3 py-2 text-right">{kt(m.cached)}</td>
                  <td className="px-3 py-2 text-right">{(m.avgMs / 1000).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold text-slate-600">直近の呼び出し (ルーティング先つき)</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-100 text-slate-400">
              <tr>
                <th className="px-3 py-2">時刻</th>
                <th className="px-3 py-2">purpose</th>
                <th className="px-3 py-2">routed</th>
                <th className="px-3 py-2 text-right">in/out tk</th>
                <th className="px-3 py-2 text-right">cache</th>
                <th className="px-3 py-2 text-right">秒</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r) => (
                <tr key={r.id} className="border-b border-slate-50">
                  <td className="px-3 py-2 text-slate-400">{r.created_at.slice(11)}</td>
                  <td className="px-3 py-2">{r.purpose}</td>
                  <td className="px-3 py-2 font-mono">{r.routed_model ?? "-"}</td>
                  <td className="px-3 py-2 text-right">
                    {kt(r.prompt_tokens)}/{kt(r.completion_tokens)}
                  </td>
                  <td className="px-3 py-2 text-right">{kt(r.cached_tokens)}</td>
                  <td className="px-3 py-2 text-right">{(r.elapsed_ms / 1000).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
