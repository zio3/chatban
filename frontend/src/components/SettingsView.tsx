import { apiFetch } from "../api";
import { useEffect, useMemo, useState } from "react";
import AuthSettings from "./AuthSettings";
import ProjectSettings from "./ProjectSettings";

// #88: 管理画面。用途別モデルを実行時に切り替える (再起動不要)。
// 「モデルID1行で差し替えられる」というルーターの利点を、UIとして触れる形にしたもの。
interface SlotRow {
  slot: "main" | "archive" | "cheap";
  model: string;
  default: string;
  source: "settings" | "default";
}
interface ModelEntry {
  id: string;
  name: string | null;
  inputPerM: number | null;
  outputPerM: number | null;
  contextLength: number | null;
  inputModalities: string[];
}

const SLOT_INFO: Record<SlotRow["slot"], { label: string; hint: string }> = {
  main: {
    label: "対話 (チャット・提案チップ)",
    hint: "応答速度が生命線。プロンプトキャッシュを効かせるため、日付つきのスナップショットIDで固定するのが安全",
  },
  archive: {
    label: "要約の要素分解 (Doneアーカイブ)",
    hint: "品質が肝で非同期。30秒かかっても許容できるのでルーティングに委任できる",
  },
  cheap: { label: "定型処理 (要約タイトル生成)", hint: "短文の生成だけ。コスト優先でよい" },
};

function fmtPrice(v: number | null) {
  return v == null ? "-" : `$${v.toFixed(2)}`;
}

export default function SettingsView() {
  const [slots, setSlots] = useState<SlotRow[] | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const s = await apiFetch("/api/settings/models").then((r) => r.json());
    setSlots(s.slots);
    setDraft(Object.fromEntries(s.slots.map((x: SlotRow) => [x.slot, x.model])));
  }

  useEffect(() => {
    load().catch((e) => setError(String(e)));
    apiFetch("/api/models")
      .then((r) => r.json())
      .then((d) => setModels(d.models ?? []))
      .catch(() => setModels([]));
  }, []);

  // テキスト系のみ (画像生成・TTS・埋め込みは対話に使えないので候補から外す)
  const candidates = useMemo(
    () =>
      models
        .filter((m) => !/tts|embedding|image|imagen|kling|dub|video/i.test(m.id))
        .sort((a, b) => (a.inputPerM ?? 999) - (b.inputPerM ?? 999)),
    [models]
  );
  const byId = useMemo(() => new Map(candidates.map((m) => [m.id, m])), [candidates]);

  async function save(slot: string, value: string | null) {
    setSaving(slot);
    setError(null);
    try {
      const res = await apiFetch("/api/settings/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [slot]: value }),
      });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSaving(null);
    }
  }

  if (error && !slots) return <p className="p-6 text-sm text-red-600">読み込み失敗: {error}</p>;
  if (!slots) return <p className="p-6 text-sm text-slate-400">読み込み中…</p>;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <ProjectSettings />
      <AuthSettings />

      <div>
        <h2 className="text-base font-bold">モデル設定</h2>
        <p className="mt-1 text-xs text-slate-500">
          用途ごとに使うモデルを切り替えます。<strong>保存した瞬間から次の呼び出しに反映</strong>されます (再起動不要)。
          切り替えるとプロンプトキャッシュは一度失われます — キャッシュはモデルごとに別物のためです。
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {slots.map((s) => {
        const cur = byId.get(draft[s.slot] ?? "");
        const dirty = draft[s.slot] !== s.model;
        return (
          <div key={s.slot} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-bold">{SLOT_INFO[s.slot].label}</h3>
              {s.source === "default" ? (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">既定値</span>
              ) : (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700">上書き中</span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">{SLOT_INFO[s.slot].hint}</p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                list={`models-${s.slot}`}
                value={draft[s.slot] ?? ""}
                onChange={(e) => setDraft({ ...draft, [s.slot]: e.target.value })}
                spellCheck={false}
                className="min-w-[320px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 font-mono text-xs"
                placeholder="provider/model"
              />
              {/* 候補は出すが手入力も許す — 新モデルが一覧に載る前でも試せるように */}
              <datalist id={`models-${s.slot}`}>
                {candidates.map((m) => (
                  <option key={m.id} value={m.id}>
                    {fmtPrice(m.inputPerM)}/{fmtPrice(m.outputPerM)} per 1M
                  </option>
                ))}
              </datalist>
              <button
                disabled={!dirty || saving === s.slot}
                onClick={() => save(s.slot, draft[s.slot])}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs text-white disabled:opacity-30"
              >
                {saving === s.slot ? "保存中…" : "保存"}
              </button>
              {s.source === "settings" && (
                <button
                  onClick={() => save(s.slot, null)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
                >
                  既定に戻す
                </button>
              )}
            </div>

            <p className="mt-2 text-[11px] text-slate-400">
              既定: <span className="font-mono">{s.default}</span>
              {cur && (
                <>
                  {" / "}選択中の単価: 入力 {fmtPrice(cur.inputPerM)} ・ 出力 {fmtPrice(cur.outputPerM)} (per 1M tokens)
                  {cur.contextLength ? ` / context ${(cur.contextLength / 1000).toFixed(0)}K` : ""}
                  {cur.inputModalities.length ? ` / ${cur.inputModalities.join("・")}` : ""}
                </>
              )}
            </p>
          </div>
        );
      })}

      <p className="text-[11px] text-slate-400">
        候補一覧と単価は OrcaRouter の <span className="font-mono">/v1/models</span> から取得しています (
        {candidates.length}件)。一覧にないIDも手入力で試せます。
      </p>
    </div>
  );
}
