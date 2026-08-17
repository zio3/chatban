import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

/** ループバック宛か。**HTTPを許すのはここだけ。**
 * ローカルLLM (Ollama等) は http://localhost:11434 で待ち受けるので http を塞げないが、
 * 外向きの http はキーが平文で流れる */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/** 宛先URLとして受け付けてよいか。**駄目な理由を返す (良ければ null)。**
 *
 * `z.string().url()` だけでは足りない理由が3つある:
 *  - `new URL("localhost:11434")` は成功する (`localhost:` をプロトコルと解釈する)
 *  - **http:// を任意のホストに許すと、APIキーが平文でネットワークに出る。**
 *    Authorization ヘッダも x-api-key も暗号化されない (Codexレビュー指摘)
 *  - userinfo (`https://user:pass@host`) や query を許すと、**キーがURLに混ざり、
 *    ログや画面表示にそのまま出る**。宛先の指定にこれらは要らない */
export function baseUrlProblem(v: string): string | null {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "URLとして読めません";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "http:// または https:// で始める必要があります";
  if (u.protocol === "http:" && !isLoopbackHost(u.hostname)) {
    return `http:// はローカル宛 (localhost / 127.0.0.1 / ::1) のときだけ使えます。外部の宛先には https:// を使ってください`;
  }
  if (u.username || u.password) return "URLにユーザー名やパスワードを含めないでください (キーは apiKey / apiKeyFile に書きます)";
  if (u.search) return "URLにクエリを含めないでください";
  if (u.hash) return "URLに # 以降を含めないでください";
  return null;
}

/** 空白だけの値を弾く。`min(1)` はスペース1文字を通してしまう */
const nonBlank = (what: string) => z.string().trim().min(1, `${what}が空です`);

const schema = z
  .object({
    apiKey: nonBlank("apiKey").optional(),
    /** キーを設定と同じファイルに置きたくないとき用。設定を人に見せる場面 (記事・スクショ) で効く */
    apiKeyFile: nonBlank("apiKeyFile").optional(),
    baseURL: z.string().superRefine((v, ctx) => {
      const problem = baseUrlProblem(v);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
    // **推測しない。**サンプルを丸ごとコピーする導線なので省略されることがない。
    // baseURL から推測する実装も考えたが、OrcaRouter のように両方を持つ宛先があるので原理的に当たらない
    apiStyle: z.enum(["chat", "messages"]),
    models: z.object({
      main: nonBlank("main"),
      archive: nonBlank("archive"),
      cheap: nonBlank("cheap"),
    }),
  })
  .refine((c) => Boolean(c.apiKey || c.apiKeyFile), {
    message: "apiKey か apiKeyFile のどちらかが要ります",
  });

/** 文字列から秘密を伏せる。**上流のエラー本文をそのまま出さないための最後の砦。**
 *
 * 互換宛先の中には、認証に失敗したとき**受け取ったキーをエラー本文に含めて返すもの**がある
 * (Codexレビューで `messages 401: invalid key: sk-...` を再現)。その本文は
 * ログにもHTTP応答にも流れるので、出口で伏せる。
 *
 * **長さで手加減しない。**最初は「短い値を伏せると無関係な文字列が壊れる」と考えて8文字未満を
 * 素通りさせていたが、**設定は短いキーを許すので、短いキーだけ伏字にならない**という穴になった
 * (Codexレビュー指摘: `apiKey="abc123"` が漏れる)。ローカルLLM向けのダミー (`"ollama"` など) が
 * 伏字になっても実害は無い — ログに `***` と出るだけで、意味を取り違える情報ではない。
 * **伏せすぎて困ることより、伏せ損ねて困ることのほうが取り返しがつかない。** */
export function redactSecrets(text: string, secrets: (string | undefined | null)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue; // 空文字だけは除く (全ての位置に一致してしまう)
    out = out.split(s).join("***");
  }
  return out;
}

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

// ここに `isGitignored(gitignoreText, entry)` があった。**.gitignore を自前で読んで
// 「完全一致の行があるか」を見る実装で、gitのignore規則ではなかった** (Codexレビュー指摘)。
// 否定パターン (`!backend/config.json`)・ワイルドカード・ディレクトリ指定・
// `.git/info/exclude`・親ディレクトリの .gitignore を扱えず、**無視されていないのに
// 「無視されている」と答える**ことがある。規則を近似して持つのをやめ、gitCheckIgnore で本家に聞く

/** その設定ファイルについて .gitignore に書かれているべき行。**リポジトリの外なら null。**
 *
 * CHATBAN_CONFIG で別のパスを指せるので、**固定の `backend/config.json` だけを見ると
 * 見落とす** (Codexレビュー指摘: 既定行が .gitignore にある限り、リポジトリ内の
 * 別名の設定ファイルが追跡対象でも警告されない)。実際に使うパスから逆算する */
export function ignoreEntryFor(configPath: string, repoRoot: string): string | null {
  const rel = path.relative(repoRoot, configPath);
  // **`startsWith("..")` では広すぎる。**`..secret.json` はリポジトリ直下の正当なファイル名で、
  // これを「外」と判定すると**リポジトリ内なのに警告が黙る** (Codexレビュー指摘・Windowsで再現)。
  // 上位ディレクトリを指すのは、`..` そのものか `..` の直後が区切り文字のときだけ
  const escapes = rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../");
  if (!rel || escapes || path.isAbsolute(rel)) return null; // リポジトリ外なのでgitの管轄外
  return rel.split(/[\\/]/).join("/"); // .gitignore は常に / 区切り
}

/** そのパスが git に無視されるか。**判定は git 本体に任せる (true / false / 判定不能なら null)。**
 *
 * 自前で .gitignore を読む実装にしていたが、**それは「完全一致の行があるか」でしかなく、
 * gitのignore規則ではなかった** (Codexレビュー指摘)。`!backend/config.json` の否定パターン、
 * `*.json`、ディレクトリ指定、`.git/info/exclude`、親ディレクトリの .gitignore —
 * どれも自前実装では扱えない。**近似した規則を持つより、本家に聞くほうが正しい。**
 *
 * `--no-index` はインデックスを見ずにパターンだけで判定する (追跡済みのファイルについても
 * 「そのパターンなら無視されるか」を答えさせるため)。 */
export function gitCheckIgnore(repoRoot: string, absPath: string): boolean | null {
  try {
    const r = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", absPath], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    if (r.error) return null; // gitが無い
    if (r.status === 0) return true; // 無視される
    if (r.status === 1) return false; // 無視されない
    return null; // 128 = リポジトリではない等
  } catch {
    return null;
  }
}

/** 起動時に一度だけ。**設定ファイルがあるのに git に無視されていなければ警告する。**
 *
 * 公開リポジトリでキーが漏れる経路は実質これ1つ (gitignoreを書き忘れて `git add .`) なので、
 * 起動のたびに確認しておく。「あとで消す」は履歴に残るので効かない。
 *
 * 判定できないとき (gitが無い・リポジトリではない) は**黙る**。無視されている確証は無いが、
 * git が無い環境ではそもそもコミットされないので、警告は雑音にしかならない */
export function warnIfConfigNotIgnored(
  configPath: string = CONFIG_PATH,
  repoRoot: string = path.join(process.cwd(), ".."),
  emit: (msg: string) => void = (m) => log("config", m),
  check: (repoRoot: string, absPath: string) => boolean | null = gitCheckIgnore
): void {
  if (!fs.existsSync(configPath)) return;
  const entry = ignoreEntryFor(configPath, repoRoot);
  if (entry === null) return; // リポジトリ外に置いてあるなら、そもそもコミットされない
  if (check(repoRoot, configPath) === false) {
    emit(`!! ${configPath} が git に無視されていません。APIキーがコミットされる恐れがあります (.gitignore に ${entry} を追加してください)`);
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
