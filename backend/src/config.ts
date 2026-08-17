import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { log } from "./log.js";

/** #182: LLMの接続設定。**env ではなく JSON ファイルで持つ。**
 *
 * envを捨てた理由は「プロバイダを選ぶ」を「ファイルを1枚コピーする」にするため。
 * envだと baseURL / apiStyle / モデル3つを個別に埋めることになり、**組み合わせを間違えられる**
 * (OpenAIの宛先にAnthropicのモデルID、など)。4つは常にセットで動くので、1枚にまとめて
 * examples/ から丸ごとコピーさせれば、間違った組み合わせが存在しなくなる。
 *
 * **ここに入れるのは「プロバイダを替えたら一緒に替わるもの」だけ。**
 * PORT・CHATBAN_ALLOWED_ORIGINS・CHATBAN_DATA_DIR は env のまま —
 * 環境ごとに違う値なので、プロバイダの選択に巻き込むと、サンプルをコピーしただけで上書きされる。 */

export type ApiStyle = "chat" | "messages";
export type ModelSlot = "main" | "archive" | "cheap";

export interface LlmConfig {
  apiKey: string;
  baseURL: string;
  apiStyle: ApiStyle;
  models: Record<ModelSlot, string>;
}

/** 設定ファイルの位置。既定は backend/config.json (cwd は backend) */
export const CONFIG_PATH = process.env.CHATBAN_CONFIG ?? path.join(process.cwd(), "config.json");
/** .gitignore に載っていてほしい行。**リポジトリは公開なので、ここが唯一の事故経路** */
export const IGNORE_ENTRY = "backend/config.json";

const schema = z
  .object({
    apiKey: z.string().min(1).optional(),
    /** キーを設定と同じファイルに置きたくないとき用。設定を人に見せる場面 (記事・スクショ) で効く */
    apiKeyFile: z.string().min(1).optional(),
    // **`z.string().url()` だけでは足りない。**`new URL("localhost:11434")` は成功する
    // (`localhost:` をプロトコルと解釈する) ので、Ollama の宛先を http:// なしで書いた設定が
    // 起動時に通ってしまい、最初のLLM呼び出しまで気づけない
    baseURL: z
      .string()
      .url()
      .refine((v) => /^https?:\/\//i.test(v), { message: "http:// または https:// で始める必要があります" }),
    // **推測しない。**サンプルを丸ごとコピーする導線なので省略されることがない。
    // baseURL から推測する実装も考えたが、OrcaRouter のように両方を持つ宛先があるので原理的に当たらない
    apiStyle: z.enum(["chat", "messages"]),
    models: z.object({
      main: z.string().min(1),
      archive: z.string().min(1),
      cheap: z.string().min(1),
    }),
  })
  .refine((c) => Boolean(c.apiKey || c.apiKeyFile), {
    message: "apiKey か apiKeyFile のどちらかが要ります",
  });

/** `~/...` をホームディレクトリへ展開する。設定ファイルに絶対パスを書かせないため */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/** 設定を検証して、キーを解決した形にする。
 *
 * **ファイル読み込みを注入する**ので、DBもHTTPもディスクも要らずに試せる。
 * zodのエラーはそのままだと読みにくいので「どの項目が」を先頭に出す —
 * 起動時に落ちる側の人が読むメッセージなので、原因が名指しで出ることに意味がある */
export function parseLlmConfig(
  raw: unknown,
  readTextFile: (p: string) => string,
  home: string = homedir()
): LlmConfig {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(全体)"}: ${i.message}`);
    throw new Error(`設定の内容が正しくありません:\n${lines.join("\n")}`);
  }
  const c = parsed.data;
  let apiKey = c.apiKey ?? "";
  if (!apiKey && c.apiKeyFile) {
    const file = expandHome(c.apiKeyFile, home);
    try {
      apiKey = readTextFile(file).trim();
    } catch {
      throw new Error(`apiKeyFile を読めません: ${file}`);
    }
    if (!apiKey) throw new Error(`apiKeyFile が空です: ${file}`);
  }
  return { apiKey, baseURL: c.baseURL, apiStyle: c.apiStyle, models: c.models };
}

/** .gitignore に該当行があるか。コメントと空行は無視し、前後の空白は詰める。
 *
 * **ワイルドカードは受け付けない。**`config*.json` のような書き方だと examples/ 側まで
 * ignore され、「コミットしたつもりが入っていない」という逆向きの事故になる。
 * ここが探すのは完全一致の1行だけ */
export function isGitignored(gitignoreText: string, entry: string = IGNORE_ENTRY): boolean {
  return gitignoreText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .some((l) => l === entry || l === `/${entry}`);
}

/** 起動時に一度だけ。**設定ファイルがあるのに .gitignore に載っていなければ警告する。**
 *
 * 公開リポジトリでキーが漏れる経路は実質これ1つ (gitignoreを書き忘れて `git add .`) なので、
 * ファイルを1枚読むだけの確認で塞いでおく。「あとで消す」は履歴に残るので効かない */
export function warnIfConfigNotIgnored(
  configPath: string = CONFIG_PATH,
  repoRoot: string = path.join(process.cwd(), "..")
): void {
  if (!fs.existsSync(configPath)) return;
  const gitignore = path.join(repoRoot, ".gitignore");
  let text = "";
  try {
    text = fs.readFileSync(gitignore, "utf8");
  } catch {
    log("config", `!! ${gitignore} を読めませんでした。${IGNORE_ENTRY} が無視されるか確認してください`);
    return;
  }
  if (!isGitignored(text)) {
    log("config", `!! ${configPath} が .gitignore に載っていません。APIキーがコミットされる恐れがあります (${IGNORE_ENTRY} を追加してください)`);
  }
}

let cached: LlmConfig | null = null;

/** 実効設定。**遅延で読む** — 起動時に読むと、設定が無い環境で
 * 「画面を開くことすらできない」状態になる。E2E (LLMを呼ばない) と、
 * clone した直後にまず起動してみる人のために、LLMを使う操作まで要求を遅らせる */
export function llmConfig(): LlmConfig {
  if (cached) return cached;
  let text: string;
  try {
    text = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch {
    throw new Error(
      `LLMの設定がありません: ${CONFIG_PATH}\n` +
        `backend/examples/ の中から使うプロバイダのものを config.json としてコピーし、APIキーを書いてください。`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`${CONFIG_PATH} がJSONとして読めません: ${e?.message ?? e}`);
  }
  cached = parseLlmConfig(raw, (p) => fs.readFileSync(p, "utf8"));
  log("config", `LLM設定を読みました: ${cached.baseURL} (${cached.apiStyle}) main=${cached.models.main}`);
  return cached;
}

/** 用途別モデル。#181 で⚙設定タブ (#88の実行時切り替え) を撤去し、
 * #182 で env から設定ファイルへ移した */
export function getModel(slot: ModelSlot): string {
  return llmConfig().models[slot];
}

/** テスト用。読み込みは1回きりなので、差し替えるための口を開けておく */
export function __setLlmConfigForTest(c: LlmConfig | null): void {
  cached = c;
}
