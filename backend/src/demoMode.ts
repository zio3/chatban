/** #213: 公開デモ用の既定値。
 *
 * **`DEMO_MODE=on` は「既定値をこう置く」だけで、モード分岐ではない。**
 * `if (DEMO_MODE)` を各所に撒くとコードの経路が2本になり、片方 (デモ側) は
 * テストされないまま本番で動く。ここで値を決めて、使う側は値だけを見る。
 *
 * **個別の環境変数を明示したらそちらが勝つ。**手元の開発機は DEMO_MODE ではないのに
 * 提案チップだけ止めたい、という状況が現にあるので (2026-08-19)、個別の口は残す。
 *
 * まとめる理由は #183 で踏んだこと — **撤去したはずの認証が本番で生きていた**。
 * `SUGGEST_BOOT_GRACE_MS=315360000000` のような値の羅列は、見ても意図が読めない。
 */
const TRUE = /^(1|on|true|yes)$/i;
const FALSE = /^(0|off|false|no)$/i;

/** 明示された真偽値。未指定・空・知らない文字列なら undefined (既定に委ねる) */
function boolEnv(v: string | undefined): boolean | undefined {
  if (v == null || v.trim() === "") return undefined;
  if (TRUE.test(v.trim())) return true;
  if (FALSE.test(v.trim())) return false;
  return undefined;
}

export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolEnv(env.DEMO_MODE) ?? false;
}

/** 添付 (画像/PDF) を受けるか。**デモでは閉じる** —
 * 認証なしで誰でも書けるうえ、添付はそのままLLMへ流れるので入力トークンを大きく食う。
 * デモの上限はプリペイド残高だけ (#183) なので、大きい入力は残高を早く食う */
export function attachmentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolEnv(env.CHATBAN_ATTACHMENTS) ?? !isDemoMode(env);
}

/** express.json の上限。添付を受けないなら本文だけなので小さくてよい。
 * #174 のレビューで「認証前の25MB JSON解析」として残っていたもの */
export function jsonLimit(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.CHATBAN_JSON_LIMIT?.trim();
  if (v) return v;
  return isDemoMode(env) ? "256kb" : "25mb";
}

/** 提案チップの起動猶予 (ms)。デモでは実質OFF。
 * 単価ではなく「人が何もしていなくても呼ばれる」のを避けるため (#183 で旧デモが実際にそうなった) */
export const DEMO_SUGGEST_GRACE_MS = 10 * 365 * 24 * 3600_000;
export function suggestBootGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.SUGGEST_BOOT_GRACE_MS?.trim();
  if (v && Number.isFinite(Number(v))) return Number(v);
  return isDemoMode(env) ? DEMO_SUGGEST_GRACE_MS : 60_000;
}

/** 会話の**本文**をディスクに残すか。**デモでは止める** —
 * #213 が「訪問者のファイルを乗せない」なら、こちらは**訪問者の入力を残さない**。
 *
 * 認証なしで誰でも打てるので、書いた本文がそのまま VPS のディスクに平文で残る。
 * デモの朝のリセット (#211) の対象にも入っていない。
 *
 * 個人利用では調査の役に立つ道具なので、デモ以外では既定ONのまま。
 * 明示すればどちらでも勝てる (CHATBAN_LOG_BODIES=1 でデモでも出せる)。
 *
 * #259: **本文が残る経路は3つあり、この1つの値で全部を決める。**
 * `[chat] REQ` の発言 (index.ts) / `[choices] raw=` の生テキスト (chat.ts) /
 * `last-request-*.json` のプロンプトダンプ (llm.ts)。もとは3つ目だけを見る
 * `promptDumpEnabled` だったが、**残り2つが掛け忘れ**になっていた (デモでダンプは
 * 止まるのに発言の先頭120字は残る、という穴)。用途はどれも「本文を見せたくない」で
 * 同じなので、**スイッチは増やさず1つのまま**広げた (名前だけ実態に合わせて改名)。
 *
 * **切っても行そのものは消さない。**行が消えると、そのターンが在ったことまで
 * 分からなくなる (#254 で「落ちたターンで何を呼んだか」を残したのと同じ理屈)。
 * 本文の代わりに長さを出す。ダンプはファイルなので、書かないだけでよい */
export function logBodiesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolEnv(env.CHATBAN_LOG_BODIES) ?? !isDemoMode(env);
}

/** 本文を伏せたときの代わりの表示。**長さだけ残す** (#259)。
 * サロゲートペアを1字と数えるので、絵文字混じりでも「字」の見た目と合う */
export function maskedBody(text: string): string {
  return `(伏せた ${[...String(text ?? "")].length}字)`;
}
