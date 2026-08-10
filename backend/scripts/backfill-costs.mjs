// #106: estimated_usd を持たない既存行を、現在の料金表で埋める。
// 打刻の仕組みが入る前の行が対象なので「当時の単価」ではない — その旨はタスクの経緯に記録する。
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_DISCOUNT = 0.1;
const key = process.env.ORCAROUTER_API_KEY ?? readFileSync(join(homedir(), ".orcarouter", "apikey.txt"), "utf8").trim();
const base = process.env.ORCA_BASE_URL ?? "https://www.orcarouter.ai/v1";
const db = new Database(process.env.ADMIN_DB ?? "data/chatban-admin.db");

// 料金表をDBへ保存 (以後はこれが正)
const catalog = (await (await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })).json()).data;
const ins = db.prepare(
  `INSERT INTO model_prices (id, input_per_m, output_per_m, context_length, input_modalities, fetched_at)
   VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
   ON CONFLICT(id) DO UPDATE SET input_per_m=excluded.input_per_m, output_per_m=excluded.output_per_m,
     context_length=excluded.context_length, input_modalities=excluded.input_modalities, fetched_at=excluded.fetched_at`
);
db.transaction(() => {
  for (const m of catalog) {
    ins.run(m.id, m.pricing ? Number(m.pricing.prompt_per_million) : null,
      m.pricing ? Number(m.pricing.completion_per_million) : null,
      m.context_length ?? null, JSON.stringify(m.architecture?.input_modalities ?? []));
  }
})();
console.log(`料金表を保存: ${catalog.length}件`);

const price = new Map();
for (const m of catalog) {
  if (!m.pricing) continue;
  const v = { i: Number(m.pricing.prompt_per_million), o: Number(m.pricing.completion_per_million) };
  price.set(m.id, v);
  price.set(m.id.split("/").pop(), v);
}

const rows = db.prepare("SELECT * FROM llm_calls WHERE estimated_usd IS NULL").all();
const upd = db.prepare("UPDATE llm_calls SET price_in_per_m=?, price_out_per_m=?, estimated_usd=? WHERE id=?");
let filled = 0, missing = new Map();
db.transaction(() => {
  for (const r of rows) {
    const p = price.get(r.routed_model) ?? price.get(r.model);
    if (!p) { missing.set(r.routed_model ?? r.model, (missing.get(r.routed_model ?? r.model) ?? 0) + 1); continue; }
    const cached = r.cached_tokens ?? 0;
    const fresh = Math.max(0, r.prompt_tokens - cached);
    upd.run(p.i, p.o, (fresh * p.i + cached * p.i * CACHE_DISCOUNT + r.completion_tokens * p.o) / 1e6, r.id);
    filled++;
  }
})();
console.log(`概算を埋めた: ${filled} / ${rows.length}件`);
if (missing.size) console.log("単価が引けず未記入:", [...missing].map(([m, c]) => `${m}(${c})`).join(", "));
console.log("合計:", db.prepare("SELECT ROUND(SUM(estimated_usd),4) s FROM llm_calls").get().s);
