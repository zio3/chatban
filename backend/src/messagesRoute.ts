import type OpenAI from "openai";

/** #172: Anthropic Messages API 形式で問い合わせる経路。
 *
 * **なぜ2つ目の形式を持つのか: プロンプトキャッシュのため。**
 *
 * OpenAI互換 (`/v1/chat/completions`) では `cache_control` を指定する場所が無く、
 * Anthropic系モデルを選ぶと `cached_tokens` も返らない。25,000トークンの前置きを毎回フルで払うので、
 * Day2 の比較では「Anthropicはキャッシュ不発」と結論して gpt-5.4-mini に固定していた。
 *
 * その前提が **エンドポイントの選び方の問題** だった。OrcaRouter は `/v1/messages` で
 * Anthropic Messages API 形式も受け付ける。実測 (2026-08-13):
 *   1回目 cache_creation=25,083 / 2回目以降 cache_read=25,083 (新規入力は332トークンだけ)
 *   所要 2.35 / 1.83 / 3.17秒
 * routed_model は呼ぶたびに変わる (anthropic. → global.anthropic. → jp.anthropic.) が、
 * **Bedrockのリージョンをまたいでもキャッシュは効いている**。
 *
 * 責務は「chatCompletion と同じ形の値を返すこと」だけ。呼び出し側 (chat.ts) は無改造で動く */

/** 呼び出し側が timeoutMs を渡さなかったときの上限。OpenAI SDK の既定 (10分) に合わせる —
 * 経路を変えただけで詰まり方が変わらないようにする */
const DEFAULT_TIMEOUT_MS = 600_000;

type OaMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OaTool = OpenAI.Chat.Completions.ChatCompletionTool;

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

/** 文字列でも配列でも来る content を、素直な文字列に均す */
function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? (p.text ?? "") : ""))
      .join("");
  }
  return "";
}

/** OpenAI形式の messages を Anthropic の {system, messages} へ。
 *
 * ツールの往復がここの本体:
 *   assistant + tool_calls → content:[{type:"tool_use", id, name, input}]
 *   role:"tool"            → user の content:[{type:"tool_result", tool_use_id, content}]
 * Anthropic には tool ロールが無く、結果は user 側のブロックとして返す */
export function toAnthropicMessages(messages: OaMessage[]): { system: string; messages: any[] } {
  const systemParts: string[] = [];
  const out: any[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(asText(m.content));
      continue;
    }
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: (m as any).tool_call_id, content: asText(m.content) };
      // 1回の assistant が複数の tool_use を出すので、結果も1つの user にまとめて返す
      const prev = out[out.length - 1];
      if (prev?.role === "user" && Array.isArray(prev.content) && prev.content[0]?.type === "tool_result") {
        prev.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      const text = asText(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of (m as any).tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {}; // 壊れた引数は空で送る (ツール実行側が弾く)
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks }); // 空の assistant は受け付けられない
      continue;
    }
    // user。添付 (画像/PDF) はこの経路では持ち回れないのでテキストだけ通す。
    // **落とすこと自体は割り切りだが、黙って落とすのは駄目** — 呼び出し側は
    // 「内容を読み取って活用すること」というテキストを付けているので、原本が届かないまま
    // 読めと言われたモデルが**推測で答える** (レビュー指摘 2026-08-21)。
    // 入口では canAcceptAttachments が断っているが、ここは最後の砦
    if (Array.isArray(m.content)) {
      const parts = (m.content as any[]).filter((p) => p?.type === "text").map((p) => ({ type: "text", text: p.text }));
      out.push({ role: "user", content: parts.length > 0 ? parts : [{ type: "text", text: "" }] });
    } else {
      out.push({ role: "user", content: asText(m.content) });
    }
  }
  return { system: systemParts.join("\n"), messages: out };
}

/** OpenAI形式の tools を Anthropic の input_schema 形式へ */
export function toAnthropicTools(tools?: OaTool[]): any[] {
  return (tools ?? []).map((t: any) => {
    const f = t.function ?? t;
    return { name: f.name, description: f.description ?? "", input_schema: f.parameters ?? { type: "object" } };
  });
}

/** chatCompletion が返すのと同じ形。chat.ts はこの形しか見ていない */
export interface OpenAiShapedResponse {
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: any[] };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens: number;
      /** キャッシュに**書いた**ぶん。読みと単価が違う (書き込みは標準入力の1.25倍) ので、
       * 合算せずに分けて持つ。OpenAI形式には無い欄だが、落とすと初回の概算が安く出る */
      cache_creation_tokens?: number;
    };
  };
}

/** Anthropic のレスポンスを OpenAI の形へ。変換の対応表はここ1か所に置く */
export function toOpenAiShape(data: any, fallbackModel: string): OpenAiShapedResponse {
  const blocks: AnthropicBlock[] = data.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id!,
      type: "function" as const,
      function: { name: b.name!, arguments: JSON.stringify(b.input ?? {}) },
    }));

  const finish =
    data.stop_reason === "tool_use" ? "tool_calls" : data.stop_reason === "max_tokens" ? "length" : "stop";

  const u = data.usage ?? {};
  const cached = u.cache_read_input_tokens ?? 0;
  const cacheCreation = u.cache_creation_input_tokens ?? 0;
  // OpenAI の prompt_tokens は「キャッシュ分も含む総入力」。合わせないと、
  // コスト画面で入力トークンだけ極端に少なく見える (新規分しか出ない)
  const promptTokens = (u.input_tokens ?? 0) + cached + cacheCreation;

  return {
    model: data.model ?? fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finish,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: promptTokens + (u.output_tokens ?? 0),
      prompt_tokens_details: { cached_tokens: cached, cache_creation_tokens: cacheCreation },
    },
  };
}

/** 添付 (画像/PDF) が混ざっているか。**この経路は持ち回れない**ので、投げる前に見る。
 * DBもHTTPも要らない純粋関数にしてあるのはテストのため (isTaskStatus / mayEnterDone と同じ置き方) */
export function hasAttachmentParts(messages: OaMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as any[]).some((p) => p?.type === "image_url" || p?.type === "file" || p?.type === "input_audio")
  );
}

/** Messages API 形式で問い合わせる。宛先は設定の baseURL をそのまま使う。
 * OrcaRouter は /v1/chat/completions と /v1/messages の両方を持ち、Anthropic直は後者だけを持つ —
 * どちらで話すかは `apiStyle` が決める (#182)。この関数は「言われた宛先へ Messages 形式で投げる」だけ */
export async function messagesCompletion(
  baseURL: string,
  apiKey: string,
  model: string,
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "model">,
  opts?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<OpenAiShapedResponse> {
  // **黙って落とさない。**ここまで来ているのは入口の判定が漏れたときなので、
  // 中身を減らして送るのではなく止める (送ったのに読まれていない、が一番たちが悪い / #123)
  if (hasAttachmentParts(params.messages as OaMessage[]))
    throw new Error(
      "いまの宛先 (apiStyle: messages) は添付を扱えません。添付を使うなら config.json を chat 形式の宛先にしてください"
    );
  const { system, messages } = toAnthropicMessages(params.messages as OaMessage[]);
  const tools = toAnthropicTools(params.tools as OaTool[] | undefined);

  // キャッシュの区切りは「安定している前半の末尾」に置く。
  // system と tools は毎回同じなので、ここまでを丸ごとキャッシュに乗せる (実測25,083トークン)
  const body: any = {
    model,
    max_tokens: params.max_tokens ?? 1024,
    system: system ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : undefined,
    messages,
  };
  if (tools.length > 0) {
    body.tools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
  }

  const ctrl = new AbortController();
  // **省略時も必ずタイムアウトを掛ける。**OpenAI SDK 経路が詰まらないのはクライアントの既定(10分)が
  // 効いているからで、素の fetch には何も掛からない。呼び出し側の大半 (chat / archive-decompose) は
  // opts を渡さないので、既定が無いと「応答が返らないまま詰まるのを防ぐ」という chatCompletion の
  // 約束がこの経路だけ守られない。
  //
  // 詰まると chatInflight が解放されず、そのプロジェクトの提案生成まで止まり続ける (#162) —
  // 1本のリクエストが返らないだけでは済まない (外部レビュー指摘)
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // **すでに中断済みなら、その場でやめる。**addEventListener は「これから起きる abort」しか拾わないので、
  // 呼ばれた時点で aborted な signal を渡されると誰も ctrl を止めず、fetch がそのまま走ってしまう。
  // #162 が消したかった並走 (先に始まった suggest がチャットと重なる) がここだけ残っていた
  if (opts?.signal?.aborted) ctrl.abort();
  else opts?.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  let res: Response;
  try {
    res = await fetch(`${baseURL.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        // OrcaRouter は Bearer、Anthropic直は x-api-key。両方付けても弾かれないので、
        // 経路ごとに条件分岐を増やさない (向き先を変えるだけで使い回せる形にしておく)
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`messages ${res.status}: ${text.slice(0, 400)}`), { status: res.status });
  }
  return toOpenAiShape(await res.json(), model);
}

// #182: ここに `usesMessagesApi(model)` があった (`/^anthropic\//` で判定)。
// **モデルIDの接頭辞で経路を決めるのをやめ、宛先の設定 (`apiStyle`) から引くようにした。**
// 接頭辞判定は OrcaRouter が `provider/model` 形式を要求することに乗ったもので、
// 直接APIのモデルIDには接頭辞が無いため成立しない。判定が設定に移ったことで、
// 「モデルIDを送信直前に加工する」処理も要らなくなった (設定の文字列をそのまま送る)
