import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { currentProjectId } from "./store.js";
import { log } from "./log.js";
import { llmConfig, redactSecrets } from "./config.js";
import { messagesCompletion } from "./messagesRoute.js";
import { logBodiesEnabled } from "./demoMode.js";
import { logError } from "./mcpLog.js";

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
      //   3. **失敗は画面に赤く出す。**裏で黙って叩き直さない (「確定は人間」と同じ線)。
      //      ワンボタンの再送は置いていない — ツールの往復は1ターンに何ラウンドもあり、
      //      **書き込みが済んだあとのラウンドで失敗すると 500 が返る**ので、
      //      押し直すと操作が重複する。ボードを確かめてから手で入力し直してもらう
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
 * purpose (と プロジェクト) ごとに1ファイル。**round ごとに追記し、ターンをまたいでも
 * 積み続ける** (messages がどう伸びるかが、ツール呼び出しのコストそのもの)。
 * 作り直す条件は `startsNewDump` にある。
 *
 * 既定でON。1回20〜60KB程度の書き込みで、logs/ は gitignore 済み。
 * 止めたいときは CHATBAN_LOG_BODIES=0 (#259 で日次ログの本文と同じスイッチになった)。
 *
 * #224: **公開デモでは既定でOFF** (logBodiesEnabled)。訪問者が打った本文が
 * そのままディスクに平文で残るため。判断は demoMode.ts に寄せてあり、ここは値を見るだけ */
/** ダンプを**作り直すか、足すか** (#264)。
 *
 * **ターンでは切れていない。**もとのコメントは「同じターンの2round目以降は足す」と
 * 書いていたが、実装が見ているのは**現在の総メッセージ数と、保存済みの先頭 round のそれ**。
 * 画面の通常経路は次のターンで履歴が増えるので、**ターンをまたいでも足し続ける**。
 *
 * 実測 (2026-08-26): `last-request-p32-chat.json` は `rounds=6`、
 * `messageCount` が `2,4,4,6,6,8` と伸びていた。**この6roundは1ファイルに残っており、
 * 作り直しは起きていない。**単調でないのは、`4→4` `6→6` が**ターンの境目**で、
 * 前のターンの末尾と次のターンの先頭の総数がたまたま同じになったため
 * (比べる相手は直前ではなく**先頭の2**なので、同じでも足す側に入る)。
 *
 * 作り直すのは:
 *
 *   1. `prev` が falsy。**読み込みが失敗したとき全般** (`dumpRequest` の try は
 *      `JSON.parse` だけでなく `readFileSync` も囲むので、権限やI/Oのエラーも入る) に加えて、
 *      **正常に読めても `null` / `false` / 空文字なら**ここに落ちる
 *      (3周目レビュー: 「読めてさえいれば作り直さない」はまだ強かった)
 *   2. **モデルが変わった** — 別のモデルのプロンプトを1つのファイルに混ぜない。
 *      `model` が**欠けている**ファイルもここに入る (`undefined !== model`)
 *   3. **総メッセージ数が、保存済みの先頭 round 以下になった** — 履歴のリセットや
 *      新しい会話の始まり。**`<=` なので、同じ数でも作り直す**
 *
 * 逆に**足す側**に入るのは、同じ `model` の truthy な `prev` で、
 * **`messageCount <= (先頭の messageCount ?? 0)` が false のとき**。
 * 「先頭より大きいとき」と言い換えたくなるが、**数値でない値が入っていると一致しない**
 * (`5 <= "oops"` も `5 > "oops"` も false。4周目レビュー)。式のまま書く。
 * `rounds` が欠けている・空・先頭の `messageCount` が無い場合は `?? 0` で**先頭を 0**
 * として扱うので、件数が正なら足す側になる。
 *
 * **ただし `rounds` が「`null`/`undefined` 以外で、反復できない値」だと、足す側に
 * 入ったあとで落ちる** — 下の `[...prev.rounds]` が例外になり、`dumpRequest` の catch が
 * 拾って**その回のダンプごと書かれない** (足しも作り直しもしない、という第3の結果)。
 * `null`/`undefined` は `?? []` が受け止めるので落ちない。
 * 文字列も例外にならず、1文字ずつの配列として**壊れたまま書かれる**。
 *
 * この振る舞いは意図して残している。キャッシュの効き方は**ターンをまたいで**
 * プレフィックスが安定しているかで決まるので、1ターンで切ると見たいものが見えない。
 * ただし**本文がディスクに残る量も伸びる**ので、止め方は #259 のスイッチが持つ。
 *
 * **なぜ切り出したか:** この判断を `docs/security.md` で説明したときに2回続けて
 * 読み違えた (「最新ターンで上書き」「直前の round と比べている」)。
 * **コメントは実装とずれるが、テストはずれると落ちる。** */
export function startsNewDump(prev: any, model: string, messageCount: number): boolean {
  if (!prev || prev.model !== model) return true;
  return messageCount <= (prev.rounds?.[0]?.messageCount ?? 0);
}

function dumpRequest(
  purpose: string,
  model: string,
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "model">
) {
  if (!logBodiesEnabled()) return;
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

    let prev: any = null;
    try {
      prev = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      /* 読めなければ prev は null のまま = 作り直す。**JSONの不正だけでなく、
         ファイルが無い・権限が無い・I/Oが失敗した場合も含む** */
    }
    const isNewTurn = startsNewDump(prev, model, params.messages.length);

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

/** 上流が断ったかどうか (#212)。**番号を名指ししない。**
 *
 * 残高切れが 402 で返るとは限らない — OrcaRouter は枠切れを 403 で返していたし、
 * 失効は 401 だった。実際に何が返るかは宣伝と違うことがあるので、
 * **「4xx = 上流が断った」までしか見ない**。番号に依存しなければ、番号を知らなくても正しく動く。
 *
 * 残高切れ・キー失効・混雑を見分けて見せる必要は、デモを触っている人には無い
 * (判別は人間が backend/logs/ の本文でやる。伏字は #191 で入っている) */
export function isUpstreamRefusal(status: unknown): boolean {
  return typeof status === "number" && status >= 400 && status < 500;
}

/** 直近の呼び出しで上流に断られたか。**成功したら消える**ので、混雑のような一時的なものは自然に戻る。
 *
 * **プロジェクト別でも用途別でもなく、プロセスに1つ。**宛先が1つだから (config.json 1枚 #182) —
 * 断っているのは上流であって、板でも chat/suggest の別でもない。だから suggest が通れば
 * chat も通るはずで、消してよい。逆に suggest が断られたら chat も断られる (旧デモの発覚もこの形)。
 * **宛先をプロジェクトごとに持てるようにしたら、この旗もそちらへ移すこと。**
 *
 * わざわざ見に行かない (定期監視は、それ自体が課金経路になる #183)。
 * **最後に失敗したことを覚えているだけ**で、板を開いた人に伝わる */
let refused = false;
export function upstreamRefused(): boolean {
  return refused;
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
      // #259: 上流のエラー本文には**入力やプロンプトが反射されうる**ので、本文のスイッチに従う。
      // 秘密 (キー) は上の redactSecrets が既に落としている。**別の理由で別の場所が守る**
      log("llm", `!! ${purpose} model=${model} FAILED after ${Date.now() - t0}ms: ${e?.status ?? ""} ${logError(e)}`);
      if (isUpstreamRefusal(e?.status)) refused = true;
    }
    throw e;
  }
  refused = false; // 通ったので忘れる
  const elapsedMs = Date.now() - t0;
  const cachedTokens = (res.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0;
  // キャッシュに書いたぶん。Messages API 経路だけが返す (OpenAI互換は自動キャッシュで書き込み料金が無い)
  const cacheCreationTokens = (res.usage as any)?.prompt_tokens_details?.cache_creation_tokens ?? 0;
  log(
    "llm",
    `<- ${purpose} routed=${res.model} finish=${res.choices[0]?.finish_reason} tokens=${res.usage?.prompt_tokens}/${res.usage?.completion_tokens} cached=${cachedTokens}${cacheCreationTokens ? ` cacheWrite=${cacheCreationTokens}` : ""} ${elapsedMs}ms`
  );
  // #106 → #181: ここで単価を引いて llm_calls へ打刻していた (recordLlmCall)。撤去した。
  // **打刻のために毎回 fetchModelCatalog() を待っていた**のが消えるので、呼び出しが素直になる。
  // 記録は上の1行 (トークン・キャッシュ・レイテンシ) が backend/logs/ に残るだけで足りる
  return res;
}
