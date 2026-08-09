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
//  - 対話(main): 応答速度が生命線 → Haiku固定 (平均3秒・品質は割り振り判断まで実用を確認済み)
//  - 要約の要素分解(archive): 品質が肝 + 非同期でレイテンシ許容 → ルーティングに委任
//  - 定型(cheap): タイトル生成など → コスト優先ルーティング
export const MODELS = {
  main: process.env.ORCA_MODEL_MAIN ?? "anthropic/claude-haiku-4.5",
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
  log(
    "llm",
    `<- ${purpose} routed=${res.model} finish=${res.choices[0]?.finish_reason} tokens=${res.usage?.prompt_tokens}/${res.usage?.completion_tokens} ${elapsedMs}ms`
  );
  recordLlmCall({
    purpose,
    model,
    routedModel: res.model ?? null,
    promptTokens: res.usage?.prompt_tokens ?? 0,
    completionTokens: res.usage?.completion_tokens ?? 0,
    elapsedMs,
  });
  return res;
}
