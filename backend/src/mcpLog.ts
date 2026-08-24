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
 * ## 本文は残さない
 *
 * 残すのは**キー名だけ**で、値は一切出さない。
 * `context` をそのまま出すと経緯メモが丸ごとディスクに残り、
 * **#224 (公開デモでプロンプト全文がディスクに残る) と同じ形**になる。
 * キー名は自分たちのスキーマの語なので、これ自体は実データではない。 */

const MAX_KEY = 40;
const MAX_LINE = 200;

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

const trim = (k: string) => (k.length > MAX_KEY ? k.slice(0, MAX_KEY) + "…" : k);

/** 引数の**形**を1行にする。`cards[2]{title,context} sync_token` のような形。
 * **値は出さない** — 何を渡してきたかではなく、**どの項目を使っているか**を見るためのもの。
 * 使われない項目は、説明文が悪いか、さもなくば要らない (#247) */
export function argShape(args: unknown): string {
  const parts: string[] = [];
  for (const k of keysOf(args)) {
    const v = (args as Record<string, unknown>)[k];
    if (Array.isArray(v)) {
      const inner = elementKeys(v).map(trim).join(",");
      parts.push(`${trim(k)}[${v.length}]${inner ? `{${inner}}` : ""}`);
    } else {
      parts.push(trim(k));
    }
  }
  const line = parts.join(" ");
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line;
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
  const { ok, note } = (body ?? {}) as { ok?: unknown; note?: unknown };
  if (ok === false) return `NG ${typeof note === "string" ? note.slice(0, 60) : "(理由なし)"}`;
  return "ok";
}
