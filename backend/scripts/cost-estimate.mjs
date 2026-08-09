// llm_calls の実測トークン × /v1/models の単価 で自前概算を出し、公式の累計請求額と突き合わせる。
// 使い方: node scripts/cost-estimate.mjs
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const key = process.env.ORCAROUTER_API_KEY ?? readFileSync(join(homedir(), ".orcarouter", "apikey.txt"), "utf8").trim();
const base = process.env.ORCA_BASE_URL ?? "https://www.orcarouter.ai/v1";

const catalog = (await (await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })).json()).data;
// routed_model は provider 接頭辞なしで返ることがある ("gpt-5.4-mini-2026-03-17")。両方の綴りで引けるようにする
const price = new Map();
for (const m of catalog) {
  const p = m.pricing;
  if (!p) continue;
  const v = { in: Number(p.prompt_per_million), out: Number(p.completion_per_million) };
  price.set(m.id, v);
  price.set(m.id.split("/").pop(), v);
}

// キャッシュ入力の割引率。OpenAI系は概ね定価の10%。カタログに欄がないので仮定値として明示する
const CACHE_RATE = Number(process.env.CACHE_RATE ?? 0.1);

const db = new Database(process.env.DB_PATH ?? "chatban.db", { readonly: true });
const rows = db
  .prepare("SELECT purpose, model, routed_model, prompt_tokens, completion_tokens, cached_tokens FROM llm_calls")
  .all();

const byPurpose = new Map();
const byModel = new Map();
let total = 0;
let unmatchedCalls = 0;
const unmatchedModels = new Map();

for (const r of rows) {
  const p = price.get(r.routed_model) ?? price.get(r.model);
  if (!p) {
    unmatchedCalls++;
    unmatchedModels.set(r.routed_model ?? r.model, (unmatchedModels.get(r.routed_model ?? r.model) ?? 0) + 1);
    continue;
  }
  const cached = r.cached_tokens ?? 0;
  const fresh = Math.max(0, r.prompt_tokens - cached);
  const cost = (fresh * p.in + cached * p.in * CACHE_RATE + r.completion_tokens * p.out) / 1e6;
  total += cost;
  const e = byPurpose.get(r.purpose) ?? { calls: 0, cost: 0 };
  e.calls++;
  e.cost += cost;
  byPurpose.set(r.purpose, e);

  const key2 = r.routed_model ?? r.model;
  const m = byModel.get(key2) ?? { calls: 0, cost: 0, in: 0, out: 0 };
  m.calls++;
  m.cost += cost;
  m.in += r.prompt_tokens;
  m.out += r.completion_tokens;
  byModel.set(key2, m);
}

const billing = await (async () => {
  try {
    const res = await fetch("https://api.orcarouter.ai/v1/dashboard/billing/usage", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const d = await res.json();
    return typeof d.total_usage === "number" ? d.total_usage / 100 : null;
  } catch {
    return null;
  }
})();

console.log(`対象: ${rows.length}呼び出し (単価不明で除外: ${unmatchedCalls})  キャッシュ割引率の仮定: ${CACHE_RATE}`);
console.log("");
console.log("purpose別の概算:");
for (const [purpose, e] of [...byPurpose].sort((a, b) => b[1].cost - a[1].cost)) {
  console.log(`  ${purpose.padEnd(20)} ${String(e.calls).padStart(4)}回  $${e.cost.toFixed(4)}  (1回 $${(e.cost / e.calls).toFixed(5)})`);
}
console.log("");
console.log("モデル別の概算 (上位12):");
for (const [m, e] of [...byModel].sort((a, b) => b[1].cost - a[1].cost).slice(0, 12)) {
  console.log(`  ${m.padEnd(34)} ${String(e.calls).padStart(4)}回  $${e.cost.toFixed(4)}  in=${e.in} out=${e.out}`);
}
console.log("");
console.log(`自前概算 合計 : $${total.toFixed(4)}`);
if (billing != null) {
  console.log(`公式 累計請求 : $${billing.toFixed(4)}`);
  console.log(`差分          : $${(billing - total).toFixed(4)}  (概算/実額 = ${((total / billing) * 100).toFixed(1)}%)`);
}
if (unmatchedModels.size) {
  console.log("");
  console.log("単価が引けなかったモデル:");
  for (const [m, c] of [...unmatchedModels].sort((a, b) => b[1] - a[1])) console.log(`  ${m} (${c}回)`);
}
