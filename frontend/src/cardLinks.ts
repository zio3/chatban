/** #248: **経緯メモの中の `#123` を、押せるようにする。**
 *
 * 経緯メモは相互参照だらけで (実測: 全カードの経緯メモに `#` が 2,794 個)、
 * 「#245 と同じ形」のように**指させること**が索引の値打ちになっている。
 * それが文字のままだと、指されたほうへ行くのに番号を打ち直す必要があった。
 *
 * ## GitHub の番号とかぶるのは承知の上
 *
 * `PR #109` のような GitHub の番号も同じ形をしていて、**カードIDと丸かぶりする**
 * (PR番号 91〜109 はどれも実在するカードID)。実測で `#` 2,794 個のうち 134 個 (5%)。
 * **そこは人間が文脈で判断する**、という判断 (zio)。判定規則を増やさない。
 *
 * ## 何を拾わないか
 *
 * - **コード** (`` `#123` `` / コードブロック) … 書いたとおりに見せる場所なので触らない
 * - **既存のリンクの中** … 二重にリンクしない
 * - `#abc` / `#0` … IDではない (IDは1から振られる)
 */

/** テキストを「素の文字列」と「カード番号」に切り分ける。
 * **切り分けだけを純粋関数にしてある** — mdast も React も要らずに確かめられる */
export function splitCardRefs(text: string): Array<string | number> {
  const out: Array<string | number> = [];
  let last = 0;
  // 全角の井桁・全角数字も拾う (日本語入力のままだとそうなる。#197 と同じ扱い)
  const re = /[#＃]([0-9０-９]{1,15})/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const digits = m[1].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const id = Number(digits);
    // `#0` や `#000` は存在しないIDなので、ただの文字として残す
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(id);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** mdast のノード (必要なところだけ) */
type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, string> };
};

/** リンクの中を更にリンクにはしない。`[説明 #55](https://…)` の `#55` は
 * 書いた人が意図したリンク文言なので、そこを割ると行き先が2つになる。
 *
 * **コードはここに書かなくてよい。**`code` / `inlineCode` / `html` は
 * 本文を `children` ではなく `value` に持つ**葉のノード**なので、
 * text ノードだけを割るこの実装では**構造上そもそも触れない**
 * (最初は SKIP に並べていたが、外しても挙動が変わらなかった = 効いていなかった)。 */
const SKIP = new Set(["link", "linkReference", "definition"]);

/** react-markdown の remarkPlugins に渡す。
 * `#123` を **`<a data-card-id="123">`** に変える (描画側がそれを見て押せる形にする)。
 *
 * **`hName`/`hProperties` で渡すのは、URLに載せないため** —
 * react-markdown は知らないスキームのURLを落とすので、`card:123` のような形は届かない。 */
export function remarkCardLinks() {
  return (tree: Node) => walk(tree);
}

function walk(node: Node): void {
  if (!node.children) return;
  const next: Node[] = [];

  for (const child of node.children) {
    if (SKIP.has(child.type)) {
      next.push(child);
      continue;
    }
    if (child.type !== "text" || typeof child.value !== "string") {
      walk(child);
      next.push(child);
      continue;
    }

    const parts = splitCardRefs(child.value);
    // 番号が無ければ元のノードのまま (無用にノードを作らない)
    if (parts.length === 1 && typeof parts[0] === "string") {
      next.push(child);
      continue;
    }
    for (const part of parts) {
      if (typeof part === "string") next.push({ type: "text", value: part });
      else
        next.push({
          type: "link",
          // **`url` は省けない。**mdast→hast の link ハンドラが `node.url` の長さを見るので、
          // 無いと描画時に落ちる (実測: パネルが丸ごと出なくなった)。
          // 中身は空でよい — 押したときの行き先はアプリが決める (画面遷移はしない)
          url: "",
          children: [{ type: "text", value: `#${part}` }],
          data: { hName: "a", hProperties: { "data-card-id": String(part) } },
        } as Node);
    }
  }

  node.children = next;
}

/** `remarkCardLinks` が付けた印を読む。**印の名前を知っているのはここだけ**にする —
 * 以前チャット側は `[#12](#card-12)` という文字列に書き換える方式で、
 * **出す側と読む側が別の場所にあり、片方だけ改名すると黙って効かなくなる**状態だった
 * (#232 第3弾で実際に踏んでいる)。 */
export function cardRefId(props: Record<string, unknown>): number | null {
  const raw = props["data-card-id"];
  if (raw === undefined) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
