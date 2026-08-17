import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { currentProjectId } from "./store.js";
import { log } from "./log.js";
import { llmConfig, redactSecrets } from "./config.js";
import { messagesCompletion } from "./messagesRoute.js";

// #181: 計測系を撤去した。ここにあったもの:
//  - fetchBillingUsage() — OrcaRouter専用の課金サマリーAPI (残高表示)
//  - fetchModelCatalog() — 182件の単価つきカタログ (10分キャッシュ)。**単価を返すのは
//    OrcaRouterの独自拡張**で、OpenAI/Anthropic の /v1/models は返さない
//  - priceOf / costOf / estimateCallCost / キャッシュ割引率の仮定値
//
// **副産物: LLM呼び出しごとのカタログ依存が消えた。**単価を打刻するために毎回
// fetchModelCatalog() を触っていたので、起動直後の呼び出しは外部APIを待っていた。
// トークン・キャッシュ・レイテンシは backend/logs/ に残る (`tokens=8208/23 cached=3200 1555ms`) ので、
// 速度やキャッシュ効きの確認はログでできる。個人利用に requestごとの単価計算は要らない

// #182: 宛先・キー・用途別モデルは config.json へ移した (config.ts)。ここには残らない。
//
// **どのモデルを選ぶかの実測記録は、設定が外に出ても価値があるので残す** (2026-08-11、OrcaRouter経由):
//  - 対話(main): OpenAI系は自動プロンプトキャッシュが効く (2回目以降の入力85-95%が0.1x課金)。
//    Anthropicは cache_control 明示方式で、OpenAI互換経由では指定する場所が無い。
//    #172 で Messages API 経由なら効くと分かった (cache_read 25,083 を実測) → apiStyle: "messages"
//  - 要約の要素分解(archive): `orcarouter/auto` から `gpt-5.6-luna` へ変えて 40〜80秒(最大110秒) が
//    4〜12秒になった。auto を外した理由は「品質が要らない」ではなく行き先が毎回変わって体験が安定しないこと。
//    遅さの正体は思考トークンで、要素5個に qwen3.7-plus が3,000〜4,600tk、deepseek-v4-flash が
//    14,153tk 使っていた (luna は831〜981tk)。質は3パターン(2/9/15件)で比較して luna が最も安定 —
//    要素数の上限を守り、却下の扱いを間違えず、経緯メモの未検証項目まで拾う
//  - 定型(cheap): fusion-mini(コスト優先ルーティング)が qwen3.7-flash を引き、入力215字で
//    「20字のラベルを1つ」返すのに 29.7秒・出力3,446tk 使っていた。ラベル生成に思考は要らない
//
// **共通する教訓: 思考トークンを吐くモデルを定型処理に使わない。**行き先が変わる方式 (auto/fusion) は、
// 遅いモデルを引いた回だけ極端に待たされるので、体験が安定しない

let client: OpenAI | null = null;
/** OpenAI互換クライアント。**遅延生成** — 設定が無い環境でも起動だけはできるようにする
 * (E2EはLLMを呼ばないし、cloneした直後にまず画面を見たい人もいる) */
function openai(): OpenAI {
  if (!client) {
    const c = llmConfig();
    client = new OpenAI({
      apiKey: c.apiKey,
      baseURL: c.baseURL,
      // #191: **リトライしないことを明示する。**既定は2回で、401は対象外だが
      // 429 / 5xx / 接続エラーには効く = 混雑しているときに1操作で3回叩く。
      // 明示する理由は3つ:
      //   1. **もう一方の経路 (messagesCompletion) は素の fetch なのでリトライしない。**
      //      同じ操作の挙動が宛先の形式で変わるのを、既定値まかせで放置しない
      //   2. #183 (期間限定デモ) で「リトライは入れない — 失敗を叩き直すと残高を早く食う」と
      //      決めている。残高が上限そのものなので、勝手に3倍払わせない
      //   3. 失敗はチャットに赤く出て **🔄再送ボタン**が付く。**人間が押すのが再試行**で、
      //      裏で黙って増やす必要がない (「確定は人間」と同じ線)
      maxRetries: 0,
    });
  }
  return client;
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
  const cfg = llmConfig();
  log("llm", `-> ${purpose} model=${model} messages=${params.messages.length}`);
  dumpRequest(purpose, model, params);
  // SDKのReasoningEffort型に 'none' が無いためキャストして通す (OrcaRouter/OpenAI側は受け付ける)
  const extra = params.tools?.length && NEEDS_REASONING_NONE.test(model) ? ({ reasoning_effort: "none" } as any) : {};
  let res;
  try {
    if (cfg.apiStyle === "messages") {
      // #172: Anthropic系は Messages API 形式で投げる。OpenAI互換だと cache_control を
      // 置く場所が無く、前置きを毎回フルで払うことになる。
      // #182: 経路の判定は**モデルIDではなく宛先の設定**から引く。以前は `anthropic/` 接頭辞を
      // 見ていたが、それは OrcaRouter が `provider/model` 形式を要求することに乗った判定で、
      // 直接APIのモデルIDには接頭辞が無い (`claude-...` / `gpt-...`)
      res = (await messagesCompletion(cfg.baseURL, cfg.apiKey, model, params, opts)) as any;
    } else {
      const reqOpts = {
        ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      };
      res = await openai().chat.completions.create(
        { ...params, ...extra, model },
        Object.keys(reqOpts).length > 0 ? reqOpts : undefined
      );
    }
  } catch (e: any) {
    // **上流のエラー本文に秘密が混ざりうるので、ここで伏せる。**
    // 互換宛先の中には認証失敗時に**受け取ったキーをそのままエラーに含めて返すもの**がある
    // (Codexレビューで再現)。この本文はログにもHTTP応答 (index.ts) にも流れるので、
    // **入口ではなく出口の1か所**で伏字にする。e.message を書き換えるのは、
    // status など他のプロパティを保ったまま呼び出し側にも伝えるため
    if (typeof e?.message === "string") e.message = redactSecrets(e.message, [cfg.apiKey]);
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
  // #106 → #181: ここで単価を引いて llm_calls へ打刻していた (recordLlmCall)。撤去した。
  // **打刻のために毎回 fetchModelCatalog() を待っていた**のが消えるので、呼び出しが素直になる。
  // 記録は上の1行 (トークン・キャッシュ・レイテンシ) が backend/logs/ に残るだけで足りる
  return res;
}
