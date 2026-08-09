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

// 全面的にOrcaRouterのルーティングに任せる実験中 (2026-08-09〜)。
// ルーティングLLM自体は無料で、プロンプトの粒度分類→コスト最適なモデル選択はOrcaRouter側が行う。
// 固定に戻す場合は env で ORCA_MODEL_MAIN=anthropic/claude-haiku-4.5 等を指定。
export const MODELS = {
  main: process.env.ORCA_MODEL_MAIN ?? "orcarouter/auto",
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
