import fs, { readFileSync } from "node:fs";
import path, { join } from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";
import { getSetting, loadModelPrices, recordLlmCall, saveModelPrices } from "./db.js";
import { currentProjectId } from "./store.js";
import { log } from "./log.js";
import { messagesCompletion, usesMessagesApi } from "./messagesRoute.js";

function loadApiKey(): string {
  if (process.env.ORCAROUTER_API_KEY) return process.env.ORCAROUTER_API_KEY;
  try {
    return readFileSync(join(homedir(), ".orcarouter", "apikey.txt"), "utf8").trim();
  } catch {
    throw new Error("ORCAROUTER_API_KEY 未設定 (env または ~/.orcarouter/apikey.txt)");
  }
}

/** 問い合わせ先。OpenAI互換 (/chat/completions) と Messages API (/messages) で共有する —
 * OrcaRouter は同じ baseURL に両方を持っている (#172) */
const BASE_URL = process.env.ORCA_BASE_URL ?? "https://www.orcarouter.ai/v1";

export const client = new OpenAI({ apiKey: loadApiKey(), baseURL: BASE_URL });

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
//    Anthropicは cache_control 明示方式で、OpenAI互換経由では指定する場所が無い。
//    #172 で Messages API (/v1/messages) 経由なら効くと分かった (cache_read 25,083 を実測) ので、
//    anthropic/ のモデルはそちらへ流す。既定は実績のある gpt-5.4-mini のまま
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

/** #106: 料金表はDBに保存したものを正とする。外部APIは補充役。
 * 呼び出しごとの単価打刻に使うので、APIが落ちている・起動直後という理由で
 * 単価NULLの行ができるのを避けたい。取得できたらDBを更新して次回以降に備える */
export async function fetchModelCatalog(): Promise<ModelCatalogEntry[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < 600_000) return catalogCache.entries;
  try {
    const res = await client.models.list();
    const entries = (res.data as any[]).map((m) => ({
      id: m.id as string,
      name: (m.name as string) ?? null,
      inputPerM: m.pricing?.prompt_per_million != null ? Number(m.pricing.prompt_per_million) : null,
      outputPerM: m.pricing?.completion_per_million != null ? Number(m.pricing.completion_per_million) : null,
      contextLength: (m.context_length as number) ?? null,
      inputModalities: (m.architecture?.input_modalities as string[]) ?? [],
    }));
    saveModelPrices(entries);
    catalogCache = { entries, fetchedAt: Date.now() };
    return entries;
  } catch (e: any) {
    // 外部が落ちていてもDBの料金表で動き続ける (単価が古いだけで機能は止まらない)
    const stored = loadModelPrices();
    log("llm", `model catalog fetch failed, DBの料金表 ${stored.length}件で継続: ${e?.message ?? e}`);
    if (stored.length === 0) throw e;
    catalogCache = { entries: stored, fetchedAt: Date.now() };
    return stored;
  }
}

/** モデルIDから単価を引く。routed_model は provider 接頭辞なしで返ることがある */
export function priceOf(catalog: ModelCatalogEntry[], id: string | null): ModelCatalogEntry | undefined {
  if (!id) return undefined;
  return catalog.find((m) => m.id === id || m.id.split("/").pop() === id);
}

/** キャッシュ入力の割引率。カタログに欄がないので仮定値 (OpenAI系は概ね定価の10%) */
export const CACHE_DISCOUNT = 0.1;

/** キャッシュに**書く**ときの割増率。Anthropic の5分キャッシュは標準入力の1.25倍。
 * 読みと同じ扱いにすると、初回に払う25,000トークン分の概算が25%安く出る (外部レビュー指摘)。
 * OpenAI系は自動キャッシュで書き込みの追加料金が無いため、この係数は
 * cache_creation_tokens を返す経路 (Anthropic Messages API) でしか効かない */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** 1呼び出しのコスト概算。routed_model の実単価 × 実測トークン。
 * 実測(2026-08-10)では主力モデルは請求と100%一致するが、gpt-5.4-pro のように
 * カタログ単価が実態とずれるモデルもあるため、あくまで概算として扱う (UIにも明記) */
export async function estimateCallCost(
  routedModel: string | null,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  /** キャッシュに書いたぶん。読みより高いので別に受ける (省略時は0=書き込み無し) */
  cacheCreationTokens = 0
): Promise<number | null> {
  const catalog = await fetchModelCatalog();
  // routed_model は provider 接頭辞なしで返ることがある ("gpt-5.4-mini-2026-03-17")
  const find = (id: string | null) =>
    id ? catalog.find((m) => m.id === id || m.id.split("/").pop() === id) : undefined;
  const e = find(routedModel) ?? find(model);
  if (!e || e.inputPerM == null || e.outputPerM == null) return null;
  return costOf(e.inputPerM, e.outputPerM, promptTokens, completionTokens, cachedTokens, cacheCreationTokens);
}

/** 入力を「新規 / キャッシュ読み / キャッシュ書き」の3つに割って単価を掛ける。
 * 記録時 (llm.ts) と再計算時 (/api/metrics) で同じ式を使う — 片方だけ直すとズレる */
export function costOf(
  inputPerM: number,
  outputPerM: number,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  cacheCreationTokens = 0
): number {
  const fresh = Math.max(0, promptTokens - cachedTokens - cacheCreationTokens);
  return (
    (fresh * inputPerM +
      cachedTokens * inputPerM * CACHE_DISCOUNT +
      cacheCreationTokens * inputPerM * CACHE_WRITE_MULTIPLIER +
      completionTokens * outputPerM) /
    1e6
  );
}

export type ModelSlot = "main" | "archive" | "cheap";

/** 出荷時の既定値。管理画面(#88)で上書きされていない場合はこれが使われる */
export const MODEL_DEFAULTS: Record<ModelSlot, string> = {
  main: process.env.ORCA_MODEL_MAIN ?? "openai/gpt-5.4-mini-2026-03-17",
  // 2026-08-11: orcarouter/auto から gpt-5.6-luna へ。実測40〜80秒(最大110秒)が4〜12秒になった。
  // auto を外した理由は「品質が要らない」ではなく、行き先が毎回変わって体験が安定しないこと。
  // 遅さの正体は思考トークンで、要素5個を書くのに qwen3.7-plus が3,000〜4,600tk、
  // deepseek-v4-flash は14,153tk 使っていた (luna は831〜981tk)。
  // 質は3パターン(2/9/15件)で比較して luna がいちばん安定していた —
  // 要素数の上限を守り、却下の扱いを間違えず、経緯メモの未検証項目まで拾う。
  // 詳細は scripts/compare-archive-models.ts で再現できる
  archive: process.env.ORCA_MODEL_ARCHIVE ?? "openai/gpt-5.6-luna",
  // 2026-08-11: archive を直したら、今度はタイトル生成が本体より遅くなった。
  // fusion-mini(コスト優先ルーティング)が qwen3.7-flash を引き、入力215字で
  // 「20字のラベルを1つ」返すのに 29.7秒・出力3,446tk 使っていた。
  // ラベル生成に思考は要らないので、ここも行き先の決まったモデルにする
  cheap: process.env.ORCA_MODEL_CHEAP ?? "openai/gpt-5.6-luna",
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

/** LLMへ実際に送った中身をそのままファイルに出す。
 *
 * 「入力トークンが多い」はメトリクスで分かるが、何が入っているかは実物を見ないと分からない。
 * scripts/prompt-breakdown.ts は組み立て直した近似なので、こちらは本物。
 * purpose ごとに最新1回を上書きし、round ごとに追記する (1ターンの中で messages が
 * どう伸びるかが、ツール呼び出しのコストそのもの)。
 *
 * 既定でON。1回20〜60KB程度の書き込みで、logs/ は gitignore 済み。
 * 止めたいときは CHATBAN_DUMP_PROMPT=0 */
function dumpRequest(
  purpose: string,
  model: string,
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "model">
) {
  if (process.env.CHATBAN_DUMP_PROMPT === "0") return;
  try {
    const dir = path.join(process.cwd(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    // プロジェクトごとに分ける。以前は purpose だけで1ファイルだったので、
    // 別プロジェクトの操作に上書きされ、どのボードの話か分からなくなった (実際に混乱した)
    const pid = (() => {
      try {
        return currentProjectId();
      } catch {
        return 0; // プロジェクト文脈の外から呼ばれることもある
      }
    })();
    const file = path.join(dir, `last-request-p${pid}-${purpose}.json`);

    // 同じターンの2round目以降は、前のroundを消さずに足す。
    // 1ターンの中で何がどれだけ積まれたかを、あとから1ファイルで追える
    let prev: any = null;
    try {
      prev = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      /* 初回・壊れていたら作り直す */
    }
    const isNewTurn = !prev || prev.model !== model || params.messages.length <= (prev.rounds?.[0]?.messageCount ?? 0);

    const toolsJson = params.tools ? JSON.stringify(params.tools) : "";
    const messagesJson = JSON.stringify(params.messages);
    const round = {
      at: new Date().toISOString(),
      messageCount: params.messages.length,
      chars: { messages: messagesJson.length, tools: toolsJson.length, total: messagesJson.length + toolsJson.length },
      // 1メッセージずつの内訳。どのツール結果が重いかがここで分かる
      messages: params.messages.map((m: any) => ({
        role: m.role,
        chars: typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length,
        ...(m.tool_calls ? { toolCalls: m.tool_calls.map((c: any) => c.function?.name) } : {}),
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
    };

    const out = isNewTurn
      ? {
          purpose,
          projectId: pid,
          model,
          startedAt: round.at,
          // ツール定義は毎round同じものが送られる。1回だけ載せて、内訳を先に出す
          toolChars: toolsJson.length,
          toolBreakdown: (params.tools ?? []).map((t: any) => ({
            name: t.function?.name,
            chars: JSON.stringify(t.function).length,
          })).sort((a: any, b: any) => b.chars - a.chars),
          tools: params.tools,
          rounds: [round],
        }
      : { ...prev, rounds: [...(prev.rounds ?? []), round] };

    fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf-8");
    log("llm", `dump ${purpose} round=${out.rounds.length} messages=${round.chars.messages}字 tools=${toolsJson.length}字`);
  } catch (e: any) {
    log("llm", `dump失敗: ${e?.message ?? e}`); // 記録に失敗しても本処理は止めない
  }
}

export async function chatCompletion(
  purpose: string,
  model: string,
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "model">,
  /** 応答が返らないまま詰まるのを防ぐ。省略時はSDK既定 (実際にタイトル生成が数分返らない事例があった)。
   * signal: 呼び出しを途中でやめる (#162: チャットが始まったら提案の生成は捨てる。
   * 結果を無視するだけでは上流の応答を待ち続けるので、TTFTの奪い合いが解消しない) */
  opts?: { timeoutMs?: number; signal?: AbortSignal }
) {
  const t0 = Date.now();
  log("llm", `-> ${purpose} model=${model} messages=${params.messages.length}`);
  dumpRequest(purpose, model, params);
  // SDKのReasoningEffort型に 'none' が無いためキャストして通す (OrcaRouter/OpenAI側は受け付ける)
  const extra = params.tools?.length && NEEDS_REASONING_NONE.test(model) ? ({ reasoning_effort: "none" } as any) : {};
  let res;
  try {
    if (usesMessagesApi(model)) {
      // #172: Anthropic系は Messages API 形式で投げる。OpenAI互換だと cache_control を
      // 置く場所が無く、25,000トークンの前置きを毎回フルで払うことになる
      res = (await messagesCompletion(BASE_URL, loadApiKey(), model, params, opts)) as any;
    } else {
      const reqOpts = {
        ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      };
      res = await client.chat.completions.create(
        { ...params, ...extra, model },
        Object.keys(reqOpts).length > 0 ? reqOpts : undefined
      );
    }
  } catch (e: any) {
    // 中断は失敗ではない (#162: チャットが始まったので提案の生成を譲っただけ)。
    // FAILED として残すと、監査ログ上は上流のエラーと見分けが付かなくなる
    if (opts?.signal?.aborted) {
      log("llm", `-- ${purpose} model=${model} ABORTED after ${Date.now() - t0}ms (呼び出し側が中断)`);
    } else {
      log("llm", `!! ${purpose} model=${model} FAILED after ${Date.now() - t0}ms: ${e?.status ?? ""} ${e?.message ?? e}`);
    }
    throw e;
  }
  const elapsedMs = Date.now() - t0;
  const cachedTokens = (res.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0;
  // キャッシュに書いたぶん。Messages API 経路だけが返す (OpenAI互換は自動キャッシュで書き込み料金が無い)
  const cacheCreationTokens = (res.usage as any)?.prompt_tokens_details?.cache_creation_tokens ?? 0;
  log(
    "llm",
    `<- ${purpose} routed=${res.model} finish=${res.choices[0]?.finish_reason} tokens=${res.usage?.prompt_tokens}/${res.usage?.completion_tokens} cached=${cachedTokens} ${elapsedMs}ms`
  );
  // #106: 呼び出し時点の単価と概算額を打刻する。DBの料金表を使うので外部APIが落ちていても欠けない
  const promptTokens = res.usage?.prompt_tokens ?? 0;
  const completionTokens = res.usage?.completion_tokens ?? 0;
  let priceInPerM: number | null = null;
  let priceOutPerM: number | null = null;
  let estimatedUsd: number | null = null;
  try {
    const e = priceOf(await fetchModelCatalog(), res.model ?? null) ?? priceOf(await fetchModelCatalog(), model);
    if (e?.inputPerM != null && e.outputPerM != null) {
      priceInPerM = e.inputPerM;
      priceOutPerM = e.outputPerM;
      estimatedUsd = costOf(e.inputPerM, e.outputPerM, promptTokens, completionTokens, cachedTokens, cacheCreationTokens);
    } else {
      log("llm", `単価が引けなかったので概算を記録できない: ${res.model ?? model}`);
    }
  } catch {
    /* 単価が引けなくても記録自体は残す */
  }
  recordLlmCall({
    purpose,
    model,
    routedModel: res.model ?? null,
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheCreationTokens,
    elapsedMs,
    priceInPerM,
    priceOutPerM,
    estimatedUsd,
  });
  return res;
}
