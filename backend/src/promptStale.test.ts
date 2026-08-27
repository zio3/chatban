import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt, QUERY_LOG_DESCRIPTION, REJECTED_DESCRIPTION } from "./chat.js";
import { CONTEXT_TEMPLATE, contextReference } from "./contextTemplate.js";

// #218: **撤去した機能への言及がプロンプトに残っていないか**の番人。
//
// E2E の「計測系と監査ログのAPIは無い (#181の撤去漏れの番人)」はAPI側を見ているが、
// プロンプト側には番人が無かった。実際にこう壊れていた:
//
//   - システムプロンプトが「reason に却下の根拠を書いて」と指示していた。
//     reason は #179 で欄ごと廃止済みで、**additionalProperties:false なので渡せば必ずエラーになる**。
//     ツール契約 (REJECTED_DESCRIPTION) は直っていたのに、**プロンプトだけ取り残されていた**
//   - 前提情報テンプレートが「使わないものの例」として「担当者は割り当てない」を挙げていた。
//     存在しない欄を「使わない」と書けることになり、あると誤解させる
//
// **プロンプトは実装ではないので、型チェックもテストも守ってくれない。**
// 撤去のたびに人間が全文を読み直す前提にしないために、ここで機械に見張らせる。
//
// 見るのは「LLMへ実際に届く文字列」だけ。コメントは履歴の記録なので対象にしない。

/** システムプロンプトの**静的な部分だけ**を取る。
 *
 * 末尾には getBoardPromptSection() の索引 (実データのカード) が載る。そこまで見ると
 * **カードのタイトルに撤去済みの語が入っているだけで落ちる** — 実際に落ちた:
 * このカード自身 (#218「廃止した reason 欄への言及を…」) が索引に出て、番人が反応した。
 *
 * 見張りたいのは「こちらが書いた指示」であって、ユーザーが書いたカードの中身ではない。
 * ついでに、ここを切ると**このテストが実DBを読まなくて済む** (ユニットが環境に依存しない)。
 *
 * 境目は `## 今日:` (getBoardPromptSection の先頭)。プロンプトは静的→動的の順に並べてある
 * (キャッシュ友好の並び)。ここから先は前提情報・索引・履歴で、全部ユーザー側の中身。 */
const DYNAMIC_STARTS_AT = "## 今日:";

/** #265: **`buildSystemPrompt()` は呼ぶ時点でDBを読む。**
 *
 * 上のコメントに「ここを切ればこのテストが実DBを読まなくて済む」と書いてあったが、
 * **切っているのは結果の文字列だけ**で、呼び出し自体は `activeProjectId()` を通る
 * (プロジェクトが1件も無いと例外)。実データの管理DBを開いていたから通っていただけで、
 * まっさらな `CHATBAN_DATA_DIR` では9件とも落ちる。
 *
 * 直し方は**下ごしらえを作る**ほう。既定プロジェクトを1つ用意すれば、
 * 中身は見ない (静的な部分しか読まない) ので、空のままで足りる。 */
const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

function staticPrompt(): string {
  const full = buildSystemPrompt();
  const i = full.indexOf(DYNAMIC_STARTS_AT);
  assert.ok(i >= 0, `境目 "${DYNAMIC_STARTS_AT}" が見つからない。プロンプトの構成が変わった可能性がある`);
  return full.slice(0, i);
}

/** LLMへ届く文字列を全部集める。**入口を1つ増やしたらここにも足すこと** */
function everythingTheModelReads(): { where: string; text: string }[] {
  return [
    { where: "システムプロンプト", text: staticPrompt() },
    { where: "query_log の契約", text: QUERY_LOG_DESCRIPTION },
    { where: "rejected の契約", text: REJECTED_DESCRIPTION },
    { where: "前提情報テンプレート", text: CONTEXT_TEMPLATE },
    { where: "前提情報リファレンス", text: JSON.stringify(contextReference()) },
  ];
}

/** 撤去済みの機能。**その語が出たら落とす。**
 *
 * 最初は「『無い』と書いてあれば見逃す」という打ち消し規則を入れたが、**これは成立しなかった** —
 * `ない` は日本語のどこにでも出るので、「やらない決定」を含む行がそのまま素通りし、
 * 直す前の文言 (「reason に却下の根拠を書いて」) を実際に見逃した。
 *
 * 打ち消しを許すなら `allow` に**その一文を名指しで書く**。曖昧な条件で緩めない —
 * 番人を甘くすると、番人が居るという事実だけが残る */
//
// **#220: 語を1つ足すだけでは足りない。**番人は「機能」ではなく「語」を見ているので、
// **同じものを指す別の語があるとすり抜ける。**実際 `reason` を塞いだ直後の版で、
// システムプロンプトに「カードのタイトルや**理由欄**に書く」が残っていた —
// 英語の `reason` は消えていたのに、日本語の言い換えが生き残っていた。
// 撤去した欄を足すときは、**その欄を日本語で何と呼んでいたか**も一緒に並べること。
const REMOVED: { word: string; why: string; allow?: RegExp }[] = [
  { word: "reason", why: "#179 で欄ごと廃止。additionalProperties:false なので渡すと必ずエラー" },
  { word: "理由欄", why: "#179 で廃止した reason の日本語での呼び名 (#220 で実際に残っていた)" },
  { word: "担当者", why: "#179 で機能ごと廃止" },
  { word: "assignee", why: "#179 で列ごと削除" },
  { word: "llm_calls", why: "#181 で計測系を撤去" },
  { word: "model_prices", why: "#181 で料金表を撤去" },
  { word: "summary_cards", why: "#200 で要約カードを撤去" },
  // #223: update_cards の薄いラッパーで、機能はすべて update_cards にある。
  // **チャットの道具で唯一 task を名乗っていた** (#215 の取りこぼし) 上に、MCP側には無く、
  // 返り値の形も他と違った (失敗が英語の {error} だけ)。誘導先はプロンプトに2箇所あったので、
  // 定義を消しただけでは「無い道具を呼べ」と書いてある状態になる — そこをここで見る
  { word: "update_task_context", why: "#223 で撤去 (update_cards の context_append に寄せた)" },
];

for (const { word, why, allow } of REMOVED) {
  test(`撤去した「${word}」への言及がプロンプトに残っていない (${why})`, () => {
    for (const { where, text } of everythingTheModelReads()) {
      for (const line of text.split("\n")) {
        if (!line.includes(word)) continue;
        assert.ok(
          allow?.test(line),
          `${where} に撤去済みの「${word}」が残っている。${why}\n  → ${line.trim().slice(0, 160)}`
        );
      }
    }
  });
}

test("却下の案内は summary と経緯メモを指す (reason ではなく)", () => {
  // 契約とプロンプトの**両方**を見る。片方だけ直る形で実際に壊れたので、対で確かめる
  assert.match(REJECTED_DESCRIPTION, /summary/);
  assert.match(REJECTED_DESCRIPTION, /context/);
  const prompt = buildSystemPrompt();
  const rejectLine = prompt.split("\n").find((l) => l.includes("rejected=true"));
  assert.ok(rejectLine, "却下の案内がシステムプロンプトから消えている");
  assert.match(rejectLine!, /summary/);
  assert.match(rejectLine!, /context/);
});
