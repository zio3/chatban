import { logBodiesEnabled, maskedBody } from "./demoMode.js";
import { PUBLIC_COLUMNS, PUBLIC_TABLES } from "./publicSchema.js";
import { toolArgSchemas } from "./toolArgs.js";

/** #247: **MCP経由の呼び出しを1行に畳む。**
 *
 * 直近5日分のログを数えたら、内蔵チャットのツール呼び出しは4回、
 * **MCP経由は1行も残っていなかった** (残っていたのは接続拒否の2件だけ)。
 * Claude Code から叩いている**一番使っている経路が丸ごと無記録**だった。
 *
 * 目的は「次に何を直すか」の材料を、**聞かずに集める**こと。
 * LLMに「使っていて不便でしたか」と聞くと、詰まりを思い出すのではなく
 * 尤もらしい改善案をその場で作るので、**作るものを無限に生成する装置**になる。
 * 困ったときは振る舞いに出る (#245 は「作ってから update_cards で直す往復」を
 * 契約の突き合わせから見つけた。聞いて分かったのではない)。
 *
 * ## ログに出てよいのは「こちらが決めた語」だけ
 *
 * 最初は「値を出さなければ安全」と考えて**キー名をそのまま出していた**が、これは誤りだった
 * (Codexレビュー P2)。`create_cards` の要素スキーマは `.passthrough()` なので、
 * **キー名そのものが外部入力**になる。実測: `{ "SECRET-顧客情報\n[2099-01-01 00:00:00] [mcp] forged": "x" }`
 * を渡すと、**本文がログに残り、しかも偽の行が1本増える** (集計そのものを偽装できる)。
 *
 * なので**許可した語だけを平文にする**。
 *
 *   - キー名 … 契約 (`toolArgs.ts`) にある語だけ。それ以外は**個数だけ**数える
 *   - ツール名 … 登録済みの名前だけ。それ以外は固定ラベル
 *   - 自由文 (断りの理由・例外) … 制御文字を落として長さを切る
 *
 * **値は元から1文字も出さない。**`context` をそのまま出すと経緯メモが丸ごとディスクに残り、
 * #224 (公開デモでプロンプト全文がディスクに残る) と同じ形になる。
 *
 * ## 入口が2つあるので、規則も2つになっていた (#254)
 *
 * ここはMCPのために書いたが、**同じ道具は内蔵チャットからも呼ばれる**。そちら (`chat.ts`) は
 * 引数JSONを無加工で先頭200字残していて、**経緯メモの本文がディスクに落ちていた** — 同じ道具を
 * 入口ごとに違う規則で記録していたことになる。CLAUDE.md の「入口で契約がズレると入口ごとに
 * 違う汚れ方をする」が、契約ではなく記録側で起きた形。
 *
 * **なのでこのモジュールは入口に依存しない。**ファイル名は `mcpLog` のままだが、
 * 中身はMCPとチャットの共通の規則で、DBにも `express` にも触らない
 * (純粋であることは `mcpLogIsPure.test.ts` が固定している)。 */

const MAX_LINE = 200;
const MAX_FREE_TEXT = 60;

/** 外部由来の文字列をログへ出す前の**最後の共通処理**。
 * **改行を残すと1回の呼び出しで複数行を作れる** — 行数を数える集計が丸ごと偽装できる */
export function safe(s: unknown, max = MAX_FREE_TEXT): string {
  if (typeof s !== "string") return "";
  // 制御文字 (CR/LF・タブ・エスケープ) は空白に潰してから詰める
  const flat = s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** 契約 (`toolArgs.ts`) に出てくるキー名。**平文で出してよい語はこれだけ。**
 * ここから漏れた正当なキーは「不明」に数えられるだけで、**壊れるのではなく鈍る**方に倒れる */
function contractKeys(): Set<string> {
  const out = new Set<string>();
  const walk = (schema: any) => {
    const shape = schema?.shape ?? schema?._def?.shape?.();
    if (!shape) return;
    for (const [k, v] of Object.entries<any>(shape)) {
      out.add(k);
      const el = v?._def?.type ?? v?.element; // z.array(...) の中身
      if (el) walk(el);
    }
  };
  for (const schema of Object.values(toolArgSchemas([]))) walk(schema);
  // MCPにだけある引数 (契約はチャットと共有だが、この2つはMCP側の口)
  for (const k of ["sync_token", "reference"]) out.add(k);
  return out;
}

const KNOWN_KEYS = contractKeys();

/** 登録済みのツール名。**未知の名前を平文で出さない**ための許可リスト。
 * 実物と合っているかは mcpToolLog.test.ts が listTools と突き合わせる */
export const MCP_TOOL_NAMES = [
  "create_cards",
  "update_cards",
  "delete_cards",
  "restore_cards",
  "search_cards",
  "get_cards",
  "reorder_cards",
  "query_log",
  "get_project_context",
  "update_project_context",
  "sync_board",
] as const;

const NAME_SET: Set<string> = new Set(MCP_TOOL_NAMES);

/** 未知のツール名は平文にしない (名前もクライアントが決める文字列なので) */
export function safeToolName(name: unknown): string {
  return typeof name === "string" && NAME_SET.has(name) ? name : "(未登録のツール)";
}

function keysOf(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.keys(v as Record<string, unknown>);
}

/** 配列要素に現れたキーの**和**。1件目だけ見ると、2件目で足された項目を見落とす */
function elementKeys(arr: unknown[]): string[] {
  const seen = new Set<string>();
  for (const el of arr) for (const k of keysOf(el)) seen.add(k);
  return [...seen];
}

/** 契約にある語だけ並べ、それ以外は個数にする。
 * **「契約に無いキーを使った」こと自体は見たい情報**なので、消さずに数だけ残す */
function render(keys: string[]): string {
  const known = keys.filter((k) => KNOWN_KEYS.has(k));
  const unknown = keys.length - known.length;
  return [...known, ...(unknown ? [`+${unknown}不明`] : [])].join(",");
}

/** 引数の**形**を1行にする。`cards[2]{title,context} sync_token` のような形。
 * **値は出さない** — 何を渡してきたかではなく、**どの項目を使っているか**を見るためのもの。
 * 使われない項目は、説明文が悪いか、さもなくば要らない (#247) */
export function argShape(args: unknown): string {
  const parts: string[] = [];
  const top = keysOf(args);
  const unknownTop: string[] = [];

  for (const k of top) {
    const v = (args as Record<string, unknown>)[k];
    if (!KNOWN_KEYS.has(k)) {
      unknownTop.push(k);
      continue;
    }
    if (Array.isArray(v)) {
      const inner = render(elementKeys(v));
      parts.push(`${k}[${v.length}]${inner ? `{${inner}}` : ""}`);
    } else {
      parts.push(k);
    }
  }
  if (unknownTop.length) parts.push(`+${unknownTop.length}不明`);

  const line = parts.join(" ");
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line;
}

/** SQLのうち**平文で残してよい語**。`mcpLog` 全体と同じ規則 — こちらが決めた語だけを出す。
 *
 * 表・列の名前と、SQLの語彙 (キーワードと関数)。**それ以外の識別子は `?` に潰す。**
 * 引用符の中だけ落としても足りなかった (Codexレビュー P2 の実測で気づいた):
 * 壊れたSQLでは利用者の言葉が**引用符なしのトークンとして**そのまま残る。
 *
 * ```sql
 * SELECT * FROM cards WHERE t = 顧客A-未公開買収計画   -- 構文エラーだが、文面はログに来る
 * ```
 *
 * **抜けても壊れず、鈍るだけ** — 知らない語が `?` になって読みにくくなるだけで、
 * 「どの例文を真似したか」は表・列・キーワードで十分に分かる。 */
const SQL_WORDS = new Set(
  [
    ...PUBLIC_TABLES,
    ...PUBLIC_COLUMNS,
    // 句と演算子
    "select", "from", "where", "group", "order", "by", "limit", "offset", "having", "with", "as",
    "and", "or", "not", "is", "null", "in", "like", "glob", "between", "exists", "case", "when",
    "then", "else", "end", "distinct", "all", "union", "except", "intersect", "join", "left",
    "inner", "outer", "cross", "on", "using", "asc", "desc", "nulls", "first", "last", "collate",
    "nocase", "escape", "values", "cast", "filter", "over", "partition",
    // 関数と型
    "count", "sum", "avg", "min", "max", "total", "length", "substr", "substring", "replace",
    "trim", "ltrim", "rtrim", "upper", "lower", "coalesce", "ifnull", "nullif", "iif", "abs",
    "round", "group_concat", "json_extract", "printf", "format", "instr",
    "date", "time", "datetime", "julianday", "strftime", "unixepoch", "now", "localtime",
    "integer", "text", "real", "blob", "numeric",
    // 例文に出てくる別名 (残らないと「どの例文か」が読みにくくなる)
    "n", "h", "c", "ctx",
  ].map((w) => w.toLowerCase())
);

/** 識別子として1語ぶんを切り出す (ASCII英数と `_`、および非ASCII文字)。
 * **非ASCIIも1語に含める**のが肝 — 日本語がそのまま素通りしては意味が無い */
const WORD = /[A-Za-z0-9_\u0080-\uffff]+/g;

/** 識別子のうち、許可した語だけ残す。**それ以外は数値も含めて `?`。**
 *
 * 最初は「`WHERE id=112` の形が見たい」として数値を残していたが、**そこから抜けられた**
 * (Codexレビュー P2)。カード番号と、電話番号・口座番号・顧客番号は**見分けが付かない**:
 *
 * ```sql
 * SELECT 4111111111111111 FROM cards
 * SELECT * FROM cards WHERE id=090-1234-5678
 * ```
 *
 * 測るのに要るのは**リテラルがそこに在ったこと**だけで、`WHERE id=?` でも
 * 列・演算子・位置は分かる。**具体値は元から要らなかった。** */
function redactWords(text: string): string {
  return text.replace(WORD, (w) => (SQL_WORDS.has(w.toLowerCase()) ? w : "?"));
}
/** #252: **SQLから、文字列リテラルとコメントを落とす。**
 *
 * 測りたいのは**SQLの形** (どのビュー・どの列・どの関数を使ったか) で、リテラルは元からノイズ。
 * 落としても目的は達せられるのに、残すと利用者の言葉がログへ複製される:
 *
 * ```sql
 * SELECT id FROM live_cards WHERE title LIKE '%顧客A-未公開買収計画%'
 * ```
 *
 * **最初は「readonly + テーブルの許可リスト (#168) を通った後だから安全」と書いたが、
 * これは誤りだった** (Codexレビュー P2)。理由が2つとも成り立っていない:
 *
 *   - 記録は `finally` から出るので、**弾かれたSQLも残る**。「通った後」ではない
 *   - 引ける先を絞ることと、**SQLの文面を残してよいこと**は別の境界。
 *     リテラルは読み出す値と無関係に何でも書ける
 *
 * 環境変数で一時的に有効化する案 (Codex提示の最小案) は採らなかった。**測りたいのは
 * 日常の使われ方**で、有効にした期間に偏るとそれが測れない。落として常時残すほうが目的に合う。
 *
 * **正規表現ではなく1文字ずつ見る。**閉じていない引用符 (構文エラーのSQLでは普通に起きる) を
 * 正しく扱えないと、**壊れた入力のときだけ本文が残る**という一番まずい形になる。 */
export function redactSql(sql: string): string {
  // 開き記号 → 閉じ記号。SQLiteは '' " " ` ` [ ] のどれも受ける
  const QUOTES: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];

    // -- 行コメント (改行まで)
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
      out += " ";
      continue;
    }
    // /* ブロックコメント */
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += " ";
      continue;
    }

    const close = QUOTES[c];
    if (close) {
      // 中身は捨てて「リテラルがあった」ことだけ残す
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          // 同じ記号が2つ続くのは中身側のエスケープ ('it''s')。まだ閉じていない
          if (sql[i + 1] === close) i += 2;
          else break;
        } else i++;
      }
      const closed = i < sql.length;
      out += `${c}…${closed ? close : ""}`;
      i = closed ? i + 1 : i; // 閉じていなければ末尾まで食べ切っている
      continue;
    }

    // 引用符の外。**ここも素通りさせない** — 壊れたSQLでは、利用者の言葉が
    // 引用符なしのトークンとしてそのまま現れる (Codexレビュー P2)。
    // 1語ぶんまとめて取り、許可した語かどうかで残すか `?` にするかを決める
    WORD.lastIndex = i;
    const m = WORD.exec(sql);
    if (m && m.index === i) {
      out += redactWords(m[0]);
      i += m[0].length;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/** #252: **失敗の理由を、こちらが決めた語に畳む。**
 *
 * SQLiteの例外文は入力をそのまま載せる (`unrecognized token near 顧客A-…`) ので、
 * **生のまま残すとリテラルを落とした意味が無くなる** (Codexレビュー P2)。
 * 測りたいのは「どこで詰まっているか」なので、分類だけで足りる。 */
export function classifyQueryError(message: unknown): string {
  const m = typeof message === "string" ? message.toLowerCase() : "";
  if (!m) return "(理由なし)";
  if (m.includes("no such table")) return "引けないテーブル";
  if (m.includes("no such column")) return "無い列";
  if (m.includes("no such function")) return "無い関数";
  if (m.includes("readonly") || m.includes("read-only")) return "書き込もうとした";
  if (m.includes("syntax error") || m.includes("unrecognized token") || m.includes("incomplete input"))
    return "SQLの文法";
  return "その他";
}
/** #252: **値を平文で出してよい項目。**`mcpLog` の芯は「値は元から1文字も出さない」で、
 * それは崩さない。ここは**穴ではなく例外の一覧**で、増やすときは理由を書くこと。
 *
 * `query_log.sql` … `query_log` の説明はチャットのツール定義の**35%を占める** (3482/9924字、
 * 2026-08-25実測) のに、呼ばれるのは `update_cards` の3分の1。削る候補は例文11本 (1122字) だが、
 * `argShape` は `sql` というキー名しか出さないので、**どの例文が真似されているか数えられない**。
 * 測ってから削るために、**SQLの形**を残す (中身は `redactSql` が落とす)。 */
const LOGGED_VALUES: Record<string, Record<string, (v: string) => string>> = {
  query_log: { sql: redactSql },
};

/** #256: **失敗したときだけ出してよい項目。**上の一覧より狭い例外。
 *
 * `query_log.goal` (このSQLで何が知りたいか) は**エージェントが書いた自由文**で、
 * SQLと違って**語の許可リストで潰せない** — 利用者の言葉がそのまま入りうる。
 * それでも要るのは、#255 で説明を削るときに**削れないものが残った**から:
 * `done_cards` が0件・`SELECT *` 違反が0件なのは、**知られていないのか規則が効いているのか
 * 区別できない** (#189)。区別するには**届かなかったときに本人から聞く**しかない。
 *
 * **だから成功した呼び出しでは捕らない。**欲しいのは「説明が届かなかった瞬間」だけで、
 * 実測では 98/98 が成功していた = 残るのはごく僅か。長さも `MAX_GOAL` で切る。 */
const FAILURE_ONLY_VALUES: Record<string, string[]> = {
  query_log: ["goal"],
};

const MAX_VALUE = 300;
/** 自由文なので短く切る。**知りたいのは詰まった方向**で、文章そのものではない */
const MAX_GOAL = 80;

/** 許可した項目だけ、値を平文で1行に足す。`sql=SELECT id, title FROM live_cards` の形。
 * 許可されていないツール・項目は**何も返さない** (呼び出し側で足す文字も増えない)。
 *
 * `failed` を渡すと、失敗したときだけ出す項目 (`FAILURE_ONLY_VALUES`) も足す。
 * **既定は false** — 呼び出し側が outcome を知らないまま呼んでも、漏れる方には倒れない */
export function argDetail(name: unknown, args: unknown, failed = false): string {
  const tool = safeToolName(name);
  const allowed = LOGGED_VALUES[tool];
  const parts: string[] = [];
  const bag = args as Record<string, unknown> | null | undefined;

  for (const [key, redact] of Object.entries(allowed ?? {})) {
    const v = bag?.[key];
    // **落としてから `safe()` に渡す。**順番が逆だと、`safe()` が改行を空白に潰した後で
    // `--` 行コメントを見ることになり、コメントの終わりが分からなくなる
    const text = typeof v === "string" ? safe(redact(v), MAX_VALUE) : "";
    if (text) parts.push(`${key}=${text}`);
  }
  if (failed) {
    for (const key of FAILURE_ONLY_VALUES[tool] ?? []) {
      const v = bag?.[key];
      // #259: **これも本文なので、本文のスイッチに従う。**もとはスイッチと無関係に出ていた
      // (Codexレビュー P2 で発覚 — 「本文が残る経路は3つ」と数えたうちに入っていなかった)。
      // 伏せても「失敗した呼び出しが在った」ことは残るので、#256 の目的のうち
      // 「規則が届いていないのか、知られていないのか」の切り分けだけが落ちる
      const text = typeof v === "string" ? (logBodiesEnabled() ? safe(v, MAX_GOAL) : maskedBody(v)) : "";
      if (text) parts.push(`${key}=${text}`);
    }
  }
  return parts.join(" ");
}

/** 記録の上で「失敗」と見なすか。`toolOutcome` / `outcomeOf` / `throwOutcome` が返す語で判断する
 * (`ok` 以外はすべて失敗 — 断りも例外も「届かなかった」ことに変わりはない) */
export function isFailure(outcome: string): boolean {
  return outcome !== "ok";
}
/** 応答から「通ったか / 断ったならどう言ったか」を取り出す。
 * **失敗が溜まっていく場所が要る** — `ok:false` が繰り返すツールは、契約が伝わっていない */
export function toolOutcome(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined) : undefined;
  if (typeof first?.text !== "string") return "ok";

  let body: unknown;
  try {
    body = JSON.parse(first.text);
  } catch {
    return "ok"; // JSONでない応答 (queryLogHelp など) は、断り方を持たないので通ったものとして扱う
  }
  return outcomeOf(body);
}

/** 例外で終わったときに残す語。**本文は出さない** (#254)。
 *
 * 例外文は入力値を含みうる — SQLiteのエラーはSQLをそのまま載せるし、下位層が組み立てた
 * 文字列に利用者の言葉が入ることもある。**種類だけで「どのツールが落ちているか」は分かる。**
 *
 * **入口ごとに書かない。**チャットとMCPで別々に書いていたら、片方だけ `safe(e.message)` に
 * なっていた (Codexレビュー P2)。`finally` で記録する目的が「例外で終わったターンを残す」
 * ことなので、**そこだけ規則が逆だと、直したはずの穴が失敗時にだけ開く** */
export function throwOutcome(e: unknown): string {
  return `throw ${e instanceof Error ? e.name : "不明"}`;
}

/** 通ったか断られたかを、**封筒を剥がした結果そのもの**から読む (#254)。
 *
 * MCPはJSON文字列を `content[0].text` に包んで返すが、**チャット側の `execTool` は
 * 素のオブジェクトをそのまま返す**。断り方 (`ok` / `note` / `error`) は両方で同じなので、
 * 読む部分だけを分けて、判断は1箇所に閉じておく */
export function outcomeOf(body: unknown): string {
  const { ok, note, error } = (body ?? {}) as { ok?: unknown; note?: unknown; error?: unknown };
  // **断り方の欄が1つではない** (#252)。断りの多くは `note` だが、`query_log` だけは
  // `{ ok:false, error }` を返す (SQLiteの例外をそのまま渡して直させる形)。
  // `note` しか見ていなかったので、**一番中身を知りたいツールの失敗理由だけが
  // 「(理由なし)」に落ちていた** — 説明のどこが伝わっていないかを測る材料が消えていた。
  //
  // 断りの文はこちらが書いたものだが、**将来入力値を含むようになっても越えない**ように通す。
  // `error` だけは違う — **SQLiteの例外文は入力をそのまま載せる**
  // (`unrecognized token near 顧客A-…`) ので、`safe()` では足りず分類に畳む (Codexレビュー P2)
  if (ok === false) return `NG ${safe(note) || (error !== undefined ? classifyQueryError(error) : "(理由なし)")}`;
  return "ok";
}

/** リクエストに含まれる `tools/call` を全部拾う。
 *
 * **JSON-RPCは配列 (バッチ) で来ることがある** (Codexレビュー P2)。
 * `body.method` だけを見ていると配列では常に undefined になり、
 * **バッチの中でスキーマに弾かれた呼び出しだけが記録から消える** —
 * 「間違え続けているツールが呼ばれていないように見える」という、この記録が解こうとしている
 * 当の問題がバッチ経路にそのまま残っていた。
 *
 * 突き合わせは JSON-RPC の `id` で行う (同じツール名が複数回入っていても区別が付く) */
export function toolCalls(body: unknown): Array<{ id: unknown; name: string; args: unknown }> {
  const list = Array.isArray(body) ? body : [body];
  const out: Array<{ id: unknown; name: string; args: unknown }> = [];
  for (const m of list) {
    const msg = m as { method?: unknown; id?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (msg?.method !== "tools/call") continue;
    out.push({ id: msg.id, name: safeToolName(msg.params?.name), args: msg.params?.arguments });
  }
  return out;
}

/** #259: **日次ログに本文を載せるときの共通の形。**ONなら先頭 `max` 字、OFFなら長さだけ。
 *
 * ここに置くのは、このモジュールが**入口に依存しないログの規則**だから (#254 と同じ理由)。
 * 呼ぶ側で `logBodiesEnabled()` を書くと、また掛け忘れが起きる — 実際に起きた (#259 の P2)。 */
export function logBody(text: unknown, max = 120, quote = true): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (!logBodiesEnabled()) return maskedBody(s);
  const cut = s.slice(0, max);
  return quote ? `"${cut}"` : cut;
}

/** 上流 (LLM) のエラー本文 (#259 Codexレビュー2周目 P2)。**これも本文が入りうる。**
 *
 * 互換宛先の中には、受け取った入力やプロンプトを**そのままエラーに反射して返すもの**がある
 * (`messagesRoute.ts` は非2xx応答の本文を400字まで `Error.message` に入れる)。
 * 秘密は `redactSecrets` が既に落としているが、**本文は落ちていなかった**。
 *
 * **伏せるのはログだけ。**画面に出るのは打った本人で、消えると「なぜ失敗したか」が
 * 分からなくなる。ディスクに残るかどうかが、ここでの境目。
 *
 * **「HTTP応答はそのまま」ではない** (3周目 P3 — 厳密でない書き方をしていた)。
 * チャットAPIが返すのは `llm.ts` が `redactSecrets` を掛けたあとの `message` で、
 * 提案APIは本文を返さず空配列を返す。**本文のスイッチでは伏せない**、が正確な言い方 */
export function logError(e: unknown, max = 400): string {
  const msg = typeof (e as any)?.message === "string" ? (e as any).message : String(e ?? "");
  return logBody(msg, max, false);
}

/** 選択肢つき応答の1行 (#259)。**生テキストも選択肢も、どちらもモデルが書いた本文**なので
 * 一緒に伏せる。抽出前後の違いでしかなく、中身は同じ文章 */
export function choicesDetail(reply: unknown, options: unknown[]): string {
  if (!logBodiesEnabled()) return `raw=${maskedBody(typeof reply === "string" ? reply : "")} options=${options.length}件`;
  return `raw=${JSON.stringify(reply)} options=${JSON.stringify(options)}`;
}
