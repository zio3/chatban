import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** #233: **撤去した機能への言及が画面の文言に残っていないか**の番人。
 *
 * backend の `promptStale.test.ts` (#218) は**モデルが読むもの**だけを見ている。
 * 人間が読むUI文言には番人が無く、同じ形で3回壊れた:
 *
 *   - #220 プロンプトに「理由欄」(#179で廃止) が残っていた
 *   - #229 チャットの表示名に実在しないツール3件
 *   - 2026-08-21 設定画面に「コストの記録は全プロジェクト共通です」(#181で撤去)
 *
 * この番人を書いた時点でも**2件見つかった** (どちらも `CardDetailPanel.tsx`):
 * 「理由は下の割り振り理由・経緯メモ参照」(#179 で列ごと落ちた欄を見に行かせていた) と
 * 「Doneの要約カードにアーカイブされました」(#200 で撤去)。
 *
 * ## なぜ「画面を描いて本文を見る」ではなく静的に見るか
 *
 * 見つかった2件は**アーカイブ済みのカードを開いたときにしか出ない**。
 * 描いて見る方式だと、その状態に到達するテストを書いた分しか守れない —
 * **番人の網が、たまたま書いたテストの形になる。**
 * 静的に見れば、どの状態で出るかに関係なく全部見える。
 *
 * ## なぜ自前の正規表現ではなく TypeScript のパーサで読むか
 *
 * 最初は字句を正規表現で分けていたが、**JSXに直接書いた文言 (`<span>要約カード</span>`) を
 * 1つも見ていなかった** (レビュー指摘 P2)。このリポジトリでは `🚫 却下` や `現況` のように
 * JSX直書きの文言が多数あるので、**方式の主目的を満たしていなかった。**
 *
 * パーサなら `JsxText` も文字列リテラルも構文として区別でき、コメントと正規表現リテラルを
 * 取り違える心配も消える (#232 の改名で、正規表現リテラルの中を見落とす穴を実際に踏んでいる)。
 *
 * コメントは対象にしない。このリポジトリは「#181 で撤去した」と経緯をコメントに残す方針 (#225)
 * なので、語で grep すると偽陽性だらけになる。
 *
 * ブラウザは要らないが、`test:e2e` で一緒に走ってほしいのでここに置く。 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** 画面に出うる日本語の文言を全部集める。
 *
 * 拾うのは3種: 文字列リテラル / テンプレートリテラルの地の文 / **JSXのテキストノード**。
 * `${...}` の中はコードなので入らない (パーサが分けてくれる)。 */
function uiCopy(): { file: string; kind: string; text: string }[] {
  const out: { file: string; kind: string; text: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf-8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const where = file.slice(SRC.length + 1);

    const push = (kind: string, text: string) => {
      if (JAPANESE.test(text)) out.push({ file: where, kind, text: text.trim() });
    };

    const walk = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) push("文字列", node.text);
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
        push("テンプレート", node.text);
      else if (ts.isJsxText(node)) push("JSX", node.text);
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }
  return out;
}

/** 撤去済みの機能。**その語が文言に出たら落とす。**
 *
 * `promptStale.test.ts` の REMOVED と**同じ機能を指すが、語は別**。
 * あちらは道具名や列名 (`llm_calls` / `assignee`)、こちらは**人間に見せる呼び名**。
 * 撤去したものを足すときは、**画面で何と呼んでいたか**を書くこと。
 *
 * 見逃したい一文があるときは `allow` に**名指しで**書く。曖昧な条件で緩めない
 * (promptStale.test.ts が打ち消し規則で実際に見逃した教訓)。 */
const REMOVED_UI: { word: string; why: string; allow?: RegExp }[] = [
  { word: "担当者", why: "#179 で機能ごと廃止" },
  { word: "割り振り", why: "#179 で担当者と一緒に廃止 (#233 で実際に残っていた)" },
  { word: "理由欄", why: "#179 で廃止した reason の画面での呼び名" },
  { word: "要約カード", why: "#200 で撤去 (いまは「📦 畳んだ完了」)" },
  { word: "コストの記録", why: "#181 で計測系を撤去 (2026-08-21 に設定画面で実際に残っていた)" },
  { word: "単価", why: "#181 で料金表を撤去" },
  { word: "監査ログ", why: "#181 で撤去" },
  { word: "ログイン", why: "#180 で認証を廃止" },
  { word: "ログアウト", why: "#180 で認証を廃止" },
];

for (const { word, why, allow } of REMOVED_UI) {
  test(`撤去した「${word}」が画面の文言に残っていない (${why})`, () => {
    const found = uiCopy().filter(({ text }) => text.includes(word) && !allow?.test(text));
    expect(
      found,
      found.map(({ file, kind, text }) => `${file} [${kind}]: ${text.slice(0, 120)}`).join("\n")
    ).toHaveLength(0);
  });
}

// **番人が本物を見ていることを、番人自身で確かめる。**
// 集めた文言が空だと、上のテストは全部素通りして「守っている」ように見える
// (rows をループするだけで rows が空でも通るテストを実際に消した経緯がある — #180 の教訓)。
//
// **3種それぞれについて実在の文言を名指しで確かめる。**1周目は placeholder (引用符付き属性) しか
// 見ておらず、**JSX直書きを1つも拾えていないのにこの健全性テストが通っていた** (レビュー指摘 P2)。
test("3種の文言をどれも拾えている (集める側が壊れたら気づく)", () => {
  const copy = uiCopy();
  expect(copy.length, "日本語の文言が1つも拾えていない").toBeGreaterThan(50);

  const kinds = (k: string) => copy.filter((c) => c.kind === k);
  expect(kinds("文字列").length, "文字列リテラルを拾えていない").toBeGreaterThan(10);
  expect(kinds("JSX").length, "JSXのテキストノードを拾えていない").toBeGreaterThan(10);

  const says = (t: string) => copy.some((c) => c.text.includes(t));
  expect(says("ボードに話しかける"), "属性の文言 (placeholder) が拾えていない").toBe(true);
  expect(says("畳んだ完了"), "JSX直書きの文言が拾えていない").toBe(true);
});
