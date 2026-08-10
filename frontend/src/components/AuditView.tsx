import { apiFetch } from "../api";
import { useEffect, useState } from "react";

// #33: オーディットログ。会話・LLM呼び出し・割り振り履歴の時系列閲覧 (読み取り専用)
interface Audit {
  chat: { id: number; role: string; content: string; taskId: number | null; createdAt: string }[];
  llm: {
    id: number;
    purpose: string;
    routedModel: string | null;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    elapsedMs: number;
    createdAt: string;
  }[];
  assignments: { id: number; taskTitle: string; assignee: string; note: string | null; createdAt: string }[];
}

const TABS = [
  { key: "chat", label: "💬 会話" },
  { key: "assignments", label: "👥 割り振り履歴" },
  { key: "llm", label: "🤖 LLM呼び出し" },
] as const;

export default function AuditView() {
  const [data, setData] = useState<Audit | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("chat");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/audit")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="p-6 text-sm text-red-600">読み込み失敗: {error}</p>;
  if (!data) return <p className="p-6 text-sm text-slate-400">読み込み中…</p>;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-full px-3 py-1 text-sm ${tab === t.key ? "bg-slate-900 text-white" : "bg-slate-200 hover:bg-slate-300"}`}
          >
            {t.label}
          </button>
        ))}
        {/* #83: 全テーブルのフルダンプ (検証利用)。表示は直近だけだがExportはもれなく全件 */}
        <a
          href="/api/audit/export"
          download
          className="ml-auto rounded-full border border-slate-300 bg-white px-3 py-1 text-sm text-slate-600 hover:bg-slate-100"
        >
          ⬇ 全ログExport (JSON)
        </a>
      </div>

      {tab === "chat" && (
        <ul className="space-y-1.5">
          {data.chat.map((c) => (
            <li key={c.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
              <span className="mr-2 text-slate-400">{c.createdAt}</span>
              <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${c.role === "user" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500"}`}>
                {c.role}
              </span>
              {c.taskId != null && <span className="mr-2 text-[10px] text-amber-600">task#{c.taskId}</span>}
              <span className="text-slate-700">{c.content}</span>
            </li>
          ))}
        </ul>
      )}

      {tab === "assignments" && (
        <ul className="space-y-1.5">
          {data.assignments.map((a) => (
            <li key={a.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
              <span className="mr-2 text-slate-400">{a.createdAt}</span>
              <span className="font-medium">{a.taskTitle}</span>
              <span className="mx-1.5 text-slate-400">→</span>
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">{a.assignee}</span>
              {a.note && <p className="mt-1 text-slate-500">💡 {a.note}</p>}
            </li>
          ))}
        </ul>
      )}

      {tab === "llm" && (
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
              {data.llm.map((r) => (
                <tr key={r.id} className="border-b border-slate-50">
                  <td className="px-3 py-2 text-slate-400">{r.createdAt}</td>
                  <td className="px-3 py-2">{r.purpose}</td>
                  <td className="px-3 py-2 font-mono">{r.routedModel ?? "-"}</td>
                  <td className="px-3 py-2 text-right">
                    {r.promptTokens}/{r.completionTokens}
                  </td>
                  <td className="px-3 py-2 text-right">{r.cachedTokens}</td>
                  <td className="px-3 py-2 text-right">{(r.elapsedMs / 1000).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
