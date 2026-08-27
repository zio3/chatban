import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { CONTEXT_TEMPLATE } from "./contextTemplate.js";

/** #261: **前提情報に置いてよいのは「盤を変えたら変わること」だけ。**
 *
 * 実測すると、`1-chatban` の前提情報 1,765字 / 18段落のうち、
 * **盤を変えても変わらないもの (製品の仕様・行動ルール) が16段落**あった。
 * しかもその多くはシステムプロンプトに**逐語で同じ文**が入っていた
 * (「前提不足で保留 (◯◯が必要)」「『今やりたい』は逆に上へ」など)。
 *
 * ## なぜ二重で持つと困るか — 安さの話ではない (#258)
 *
 * 前提情報は**盤ごとのDBの行**なので、コードの番人がどれも届かない。
 * #232 の移行ガードは識別子、#233/#238 の番人はソースの文言、
 * `promptStale.test.ts` は既定値の載ったプロンプトしか見ていない。
 * **同じことを両方に書くと、腐るのは必ず届かない側**で、実際に3件そうなった:
 * `search_tasks` / `update_task_context` (#260) と、`理由欄` (#179 で廃止した
 * `reason` の日本語名。`promptStale` の `REMOVED` に名指しであるのに、
 * DBの行だけ生き残っていた)。
 *
 * **だから番人を足すのではなく、腐る場所のほうを無くす** (#260 は却下)。
 * ここはその状態を保つための2つの見張り。 */

/** 移設したものが消えていないか。**`buildSystemPrompt()` を呼ばずにソースを読む** —
 * あれは `store.ts` 経由で日常用の管理DBを開く (#265 の当の問題) */
const chatSource = fs.readFileSync(new URL("./chat.ts", import.meta.url), "utf-8");

test("番号打鍵の案内はシステムプロンプト側にある (前提情報から移した #261)", () => {
  const line = chatSource
    .split("\n")
    .find((l) => l.trim().startsWith('"- ') && l.includes("番号だけ"));

  assert.ok(line, "番号打鍵の案内が行動ルールから消えている。前提情報から移した先はここだけなので、消えるとどこにも無くなる");
  assert.match(line!, /#193/, "打ち方の例が無いと、案内として使えない");
});

/** 新しい盤に配る雛形が、また太らないように。
 *
 * **いまの `CONTEXT_TEMPLATE` は既に線を守っている** — 列の意味・完了の条件・
 * 使わないもの、どれも盤ごとに違う。太っていたのは手で育てた `1-chatban` だけだった。
 * その状態を固定する。 */
const TOOL_NAMES = [
  "create_cards",
  "update_cards",
  "delete_cards",
  "restore_cards",
  "reorder_cards",
  "search_cards",
  "get_cards",
  "query_log",
  "get_project_context",
  "update_project_context",
  "sync_board",
];

test("前提情報の雛形はツールの使い方を説明しない", () => {
  for (const name of TOOL_NAMES) {
    assert.ok(
      !CONTEXT_TEMPLATE.includes(name),
      `雛形が「${name}」の使い方を書いている。ツールの契約が言うべきことで、盤を変えても変わらない。` +
        `雛形に入れると、新しい盤の数だけ同じ説明が増え、改名したときに全部が腐る (#260 で実際に起きた)`
    );
  }
});
