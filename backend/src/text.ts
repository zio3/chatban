/** 外から来た文字列の後始末。書き込みの入口(agentWrite / 前提情報)から共通で使う。 */

/** 日本語が \uXXXX エスケープのまま届いたらデコードする。
 *
 * 実害を2つ実測した。project 9 の前提情報が全文エスケープで保存されていて:
 *   - 296字 → 1,346字 (4.5倍)。トークンでは 243 → 787 tk (3.2倍)。
 *     前提情報はシステムプロンプトに常時載るので、発言のたびに544tkを余分に払っていた
 *   - 「この文書の見出しの数は?」に、デコード版は3(正解)、エスケープ版は2(誤答)。
 *     読めなくはないが精度が落ちる。コストだけの問題ではない
 *
 * 原因は書き込み側 — JSONの文字列として \\u3053 (バックスラッシュ+u+3053) を送ると、
 * パース後もその6文字が残る。正しく送れば日本語になるので受け方の問題ではないが、
 * 外部エージェントの実装差でデータが壊れるなら受け側で吸収する
 * (booleanを文字列で送ってくるMCPクライアントがあったのと同じ扱い)。
 *
 * 3つ以上連続しているものだけを対象にする。単発の A のような、
 * 意図して書かれたエスケープの説明文を壊さないため */
export function decodeUnicodeEscapes<T extends string | undefined | null>(v: T): T {
  if (typeof v !== "string" || !/(?:\\u[0-9a-fA-F]{4}){3,}/.test(v)) return v;
  return v.replace(/(?:\\u[0-9a-fA-F]{4})+/g, (run) =>
    (run.match(/\\u[0-9a-fA-F]{4}/g) ?? []).map((e) => String.fromCharCode(parseInt(e.slice(2), 16))).join("")
  ) as T;
}

/** 発言者ラベルが本文として書き写されたときの保険 (#95)。プロンプトは漏れるがツール契約は漏れない。
 * 先頭だけでなく行頭のどこに出ても落とす (経緯メモに段落として混ざる例があった) */
export function stripSpeakerLabel<T extends string | undefined | null>(v: T): T {
  if (typeof v !== "string") return v;
  return v.replace(/^\s*\[発言者:[^\]]*\]\s*/gm, "") as T;
}

/** エージェントから来た本文の共通処理。書き込みの入口で必ず通す */
export function cleanAgentText<T extends string | undefined | null>(v: T): T {
  return stripSpeakerLabel(decodeUnicodeEscapes(v));
}
