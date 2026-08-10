import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";
import { getSetting, recordLlmCall } from "./db.js";
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

// #21: OrcaRouterの課金サマリーAPI (docs/operations/billing-and-usage)。
// total_usageはセント表記。60秒キャッシュ (毎回外部に問い合わせない)
let billingCache: { totalUsageUsd: number; fetchedAt: number } | null = null;
export async function fetchBillingUsage(): Promise<{ totalUsageUsd: number } | null> {
  if (billingCache && Date.now() - billingCache.fetchedAt < 60_000) {
    return { totalUsageUsd: billingCache.totalUsageUsd };
  }
  try {
    const res = await fetch("https://api.orcarouter.ai/v1/dashboard/billing/usage", {
      headers: { Authorization: `Bearer ${loadApiKey()}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { total_usage?: number };
    if (typeof data.total_usage !== "number") return null;
    const totalUsageUsd = data.total_usage / 100;
    billingCache = { totalUsageUsd, fetchedAt: Date.now() };
    return { totalUsageUsd };
  } catch (e: any) {
    log("billing", `usage fetch failed: ${e?.message ?? e}`);
    return null;
  }
}

// 用途別モデル戦略 (Day2の実測比較で決定。切り替えはモデルID1行 — ルーターの利点):
//  - 対話(main): OpenAI系は自動プロンプトキャッシュがOrcaRouter経由でも効く(実測: 2回目以降の入力85-95%が0.1x課金)。
//    Anthropicはcache_control明示方式でOpenAI互換経由では現状不発 → キャッシュの取れるgpt-5.4-mini固定
//  - 要約の要素分解(archive): 品質が肝 + 非同期でレイテンシ許容 → ルーティングに委任
//  - 定型(cheap): タイトル生成など → コスト優先ルーティング
// #88: 管理画面のモデル選択肢。OrcaRouterの /v1/models は単価・コンテキスト長・入力モダリティを返す。
// 182件と多く内容もほぼ不変なので10分キャッシュする
export interface ModelCatalogEntry {
  id: string;
  name: string | null;
  inputPerM: number | null;
  outputPerM: number | null;
  contextLength: number | null;
  inputModalities: string[];
}
let catalogCache: { entries: ModelCatalogEntry[]; fetchedAt: number } | null = null;
export async function fetchModelCatalog(): Promise<ModelCatalogEntry[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < 600_000) return catalogCache.entries;
  const res = await client.models.list();
  const entries = (res.data as any[]).map((m) => ({
    id: m.id as string,
    name: (m.name as string) ?? null,
    inputPerM: m.pricing?.prompt_per_million != null ? Number(m.pricing.prompt_per_million) : null,
    outputPerM: m.pricing?.completion_per_million != null ? Number(m.pricing.completion_per_million) : null,
    contextLength: (m.context_length as number) ?? null,
    inputModalities: (m.architecture?.input_modalities as string[]) ?? [],
  }));
  catalogCache = { entries, fetchedAt: Date.now() };
  return entries;
}

/** キャッシュ入力の割引率。カタログに欄がないので仮定値 (OpenAI系は概ね定価の10%) */
export const CACHE_DISCOUNT = 0.1;

/** 1呼び出しのコスト概算。routed_model の実単価 × 実測トークン。
 * 実測(2026-08-10)では主力モデルは請求と100%一致するが、gpt-5.4-pro のように
 * カタログ単価が実態とずれるモデルもあるため、あくまで概算として扱う (UIにも明記) */
export async function estimateCallCost(
  routedModel: string | null,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number
): Promise<number | null> {
  const catalog = await fetchModelCatalog();
  // routed_model は provider 接頭辞なしで返ることがある ("gpt-5.4-mini-2026-03-17")
  const find = (id: string | null) =>
    id ? catalog.find((m) => m.id === id || m.id.split("/").pop() === id) : undefined;
  const e = find(routedModel) ?? find(model);
  if (!e || e.inputPerM == null || e.outputPerM == null) return null;
  const fresh = Math.max(0, promptTokens - cachedTokens);
  return (fresh * e.inputPerM + cachedTokens * e.inputPerM * CACHE_DISCOUNT + completionTokens * e.outputPerM) / 1e6;
}

export type ModelSlot = "main" | "archive" | "cheap";

/** 出荷時の既定値。管理画面(#88)で上書きされていない場合はこれが使われる */
export const MODEL_DEFAULTS: Record<ModelSlot, string> = {
  main: process.env.ORCA_MODEL_MAIN ?? "openai/gpt-5.4-mini-2026-03-17",
  archive: process.env.ORCA_MODEL_ARCHIVE ?? "orcarouter/auto",
  cheap: process.env.ORCA_MODEL_CHEAP ?? "orcarouter/fusion-mini",
};

/** 実効モデルID。優先順位: 管理画面の設定 > env > 既定値。
 * 呼び出しのたびにDBを引くので、再起動なしで切り替えが効く (#88) */
export function getModel(slot: ModelSlot): string {
  return getSetting(`model.${slot}`) ?? MODEL_DEFAULTS[slot];
}

/** gpt-5.6-luna は function tools と reasoning_effort を併用できず400を返す
 * ("use /v1/responses or set reasoning_effort to 'none'")。ツール併用時のみ 'none' を明示する。
 * 同世代でも terra は明示なしで通ることを実測済み (2026-08-10) なので、対象はlunaに限定する */
const NEEDS_REASONING_NONE = /gpt-5\.6-luna/;

export async function chatCompletion(
  purpose: string,
  model: string,
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "model">,
  /** 応答が返らないまま詰まるのを防ぐ。省略時はSDK既定 (実際にタイトル生成が数分返らない事例があった) */
  opts?: { timeoutMs?: number }
) {
  const t0 = Date.now();
  log("llm", `-> ${purpose} model=${model} messages=${params.messages.length}`);
  // SDKのReasoningEffort型に 'none' が無いためキャストして通す (OrcaRouter/OpenAI側は受け付ける)
  const extra = params.tools?.length && NEEDS_REASONING_NONE.test(model) ? ({ reasoning_effort: "none" } as any) : {};
  let res;
  try {
    res = await client.chat.completions.create(
      { ...params, ...extra, model },
      opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined
    );
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
