/** 設定 (backend/config.json) が実際に通るかを確かめる。
 *
 *   npx tsx scripts/check-config.ts
 *
 * 用途別の3スロットすべてに**小さなリクエストを1回ずつ**投げて、宛先・キー・モデルIDが
 * 揃っているかを見る。セットアップ直後に「動くかどうか」を、チャット画面を開く前に確かめられる。
 *
 * **設定を1つ間違えただけでも、症状は同じ「チャットが動かない」になる。**
 * キーが無効なのか、モデルIDが存在しないのか、宛先が違うのかを分けて出す。
 *
 * 実際にLLMを呼ぶので、わずかに課金される (入力20トークン程度 × 3回)。 */
import { llmConfig, type ModelSlot } from "../src/config.js";
import { chatCompletion } from "../src/llm.js";

const SLOTS: { slot: ModelSlot; what: string }[] = [
  { slot: "main", what: "対話 (チャット)" },
  { slot: "archive", what: "Done要約の要素分解" },
  { slot: "cheap", what: "タイトル生成などの定型処理" },
];

let cfg;
try {
  cfg = llmConfig();
} catch (e: any) {
  console.error(`設定を読めませんでした:\n${e?.message ?? e}`);
  process.exit(1);
}

console.log(`宛先   : ${cfg.baseURL}`);
console.log(`形式   : ${cfg.apiStyle}`);
console.log(`キー   : ${cfg.apiKey ? `あり (${cfg.apiKey.length}文字)` : "なし"}`); // 値そのものは出さない
console.log("");

let ng = 0;
for (const { slot, what } of SLOTS) {
  const model = cfg.models[slot];
  const t0 = Date.now();
  try {
    // **max_tokens を渡さない。**OpenAI直の新しめのモデルは `max_tokens` を拒否し
    // (`Unsupported parameter: use 'max_completion_tokens' instead`)、Anthropic Messages API は
    // 逆に `max_tokens` が必須。**同じ名前のパラメータが宛先ごとに扱いが違う**ので、
    // 疎通確認では渡さずに済ませる (OrcaRouter経由では素通りしていたので気づけなかった差分)
    const res: any = await chatCompletion(
      `check-${slot}`,
      model,
      { messages: [{ role: "user", content: "ping とだけ返してください" }] },
      { timeoutMs: 60_000 }
    );
    const text = String(res.choices?.[0]?.message?.content ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    console.log(`o ${slot.padEnd(8)} ${model}  ${Date.now() - t0}ms  "${text}"  (${what})`);
  } catch (e: any) {
    ng++;
    // 上流のエラーは原因ごとに文言が違うので、切り詰めずに要点を出す
    const status = e?.status ? `HTTP ${e.status} ` : "";
    console.log(`x ${slot.padEnd(8)} ${model}  ${status}${String(e?.message ?? e).slice(0, 200)}  (${what})`);
  }
}

if (ng > 0) {
  console.log(
    `\n${ng}件が通りませんでした。よくある原因:\n` +
      `  - 401 / invalid_api_key : キーが違う・失効している (apiKey / apiKeyFile を確認)\n` +
      `  - 404 / model_not_found : そのモデルIDがこの宛先に無い (プロバイダごとに書き方が違う。\n` +
      `                            OrcaRouter は provider/model 形式、直接APIは接頭辞なし)\n` +
      `  - ECONNREFUSED          : 宛先に届いていない (ローカルLLMなら起動しているか)\n`
  );
  process.exit(1);
}
console.log("\n3スロットとも通りました。");
