// 課金の答え合わせ: 請求残高を測る → 既知のモデルで1回呼ぶ → 残高を測り直す。
// カタログ単価から計算した額と、実際に増えた額を比べる。
// 使い方: node scripts/billing-probe.mjs <model> [待ち秒数]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const key = process.env.ORCAROUTER_API_KEY ?? readFileSync(join(homedir(), ".orcarouter", "apikey.txt"), "utf8").trim();
const model = process.argv[2] ?? "openai/gpt-5.4-mini-2026-03-17";
const waitSec = Number(process.argv[3] ?? 20);
const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const billing = async () => {
  const d = await (await fetch("https://api.orcarouter.ai/v1/dashboard/billing/usage", { headers: H })).json();
  return d.total_usage / 100;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cat = (await (await fetch("https://www.orcarouter.ai/v1/models", { headers: H })).json()).data;
const priceOf = (id) => {
  const e = cat.find((m) => m.id === id || m.id.split("/").pop() === id);
  return e?.pricing ? { in: Number(e.pricing.prompt_per_million), out: Number(e.pricing.completion_per_million) } : null;
};
const price = priceOf(model);

const before = await billing();
// キャッシュを踏まないよう、毎回違う内容を投げる (時刻を混ぜる)
const res = await (
  await fetch("https://www.orcarouter.ai/v1/chat/completions", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `次の数を漢数字で書いて: ${Date.now() % 100000}。答えだけ。` }],
    }),
  })
).json();

const u = res.usage;
const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
// orcarouter/auto 等はカタログに単価が無い (実体のモデル側にある)
const calc = (p) =>
  p ? ((u.prompt_tokens - cached) * p.in + cached * p.in * 0.1 + u.completion_tokens * p.out) / 1e6 : null;
const expected = calc(price) ?? 0;

await sleep(waitSec * 1000);
const after = await billing();

// orcarouter/auto 等は実際に使われたモデルが res.model に入る。その単価でも計算して比べる
const routedPrice = res.model && res.model !== model ? priceOf(res.model) : null;
const expectedRouted = calc(routedPrice);

console.log(`model      : ${model}  (単価 in $${price?.in ?? "?"} / out $${price?.out ?? "?"} per 1M)`);
if (routedPrice) {
  console.log(`routed     : ${res.model}  (単価 in $${routedPrice.in} / out $${routedPrice.out} per 1M)`);
  console.log(`  routed単価での計算値: $${expectedRouted.toFixed(6)}`);
}
console.log(`usage      : prompt=${u.prompt_tokens} (cached=${cached}) completion=${u.completion_tokens}`);
console.log(`  内訳     : reasoning=${u.completion_tokens_details?.reasoning_tokens ?? "-"}`);
console.log(`計算値     : $${expected.toFixed(6)}`);
console.log(`請求増分   : $${(after - before).toFixed(6)}   (${before.toFixed(6)} -> ${after.toFixed(6)}, ${waitSec}秒待ち)`);
console.log(`比         : ${expected > 0 ? (((after - before) / expected) * 100).toFixed(1) : "-"}% (実額/計算値)`);
