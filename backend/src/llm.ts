import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";
import { recordLlmCall } from "./db.js";
import { log } from "./log.js";

function loadApiKey(): string {
  if (process.env.ORCAROUTER_API_KEY) return process.env.ORCAROUTER_API_KEY;
  try {
    return readFileSync(join(homedir(), ".orcarouter", "apikey.txt"), "utf8").trim();
  } catch {
    throw new Error("ORCAROUTER_API_KEY 未設定 (env または ~/.orcarouter/apikey.txt)");
  }
}

export const client = new OpenAI({
  apiKey: loadApiKey(),
  baseURL: process.env.ORCA_BASE_URL ?? "https://www.orcarouter.ai/v1",
});

// 用途別モデル戦略 (Day2の実測比較で決定。切り替えはモデルID1行 — ルーターの利点):
//  - 対話(main): OpenAI系は自動プロンプトキャッシュがOrcaRouter経由でも効く(実測: 2回目以降の入力85-95%が0.1x課金)。
//    Anthropicはcache_control明示方式でOpenAI互換経由では現状不発 → キャッシュの取れるgpt-5.4-mini固定
//  - 要約の要素分解(archive): 品質が肝 + 非同期でレイテンシ許容 → ルーティングに委任
//  - 定型(cheap): タイトル生成など → コスト優先ルーティング
export const MODELS = {
  main: process.env.ORCA_MODEL_MAIN ?? "openai/gpt-5.4-mini-2026-03-17",
  archive: process.env.ORCA_MODEL_ARCHIVE ?? "orcarouter/auto",
  cheap: process.env.ORCA_MODEL_CHEAP ?? "orcarouter/fusion-mini",
};

export async function chatCompletion(
  purpose: string,
  model: string,
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "model">
) {
  const t0 = Date.now();
  log("llm", `-> ${purpose} model=${model} messages=${params.messages.length}`);
  let res;
  try {
    res = await client.chat.completions.create({ ...params, model });
  } catch (e: any) {
    log("llm", `!! ${purpose} model=${model} FAILED after ${Date.now() - t0}ms: ${e?.status ?? ""} ${e?.message ?? e}`);
    throw e;
  }
  const elapsedMs = Date.now() - t0;
  const cachedTokens = (res.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0;
  log(
    "llm",
    `<- ${purpose} routed=${res.model} finish=${res.choices[0]?.finish_reason} tokens=${res.usage?.prompt_tokens}/${res.usage?.completion_tokens} cached=${cachedTokens} ${elapsedMs}ms`
  );
  recordLlmCall({
    purpose,
    model,
    routedModel: res.model ?? null,
    promptTokens: res.usage?.prompt_tokens ?? 0,
    completionTokens: res.usage?.completion_tokens ?? 0,
    cachedTokens,
    elapsedMs,
  });
  return res;
}
