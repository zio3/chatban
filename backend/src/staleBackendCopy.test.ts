import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** #238: **撤去した機能への言及が backend の文言に残っていないか**の番人。
 *
 * frontend には #233 で番人を置いたが (`e2e/staleUiCopy.spec.ts`)、
 * **backend が返す文言はそこから届かない。**実際 #233 のレビューで
 * 「Doneへ確定して**要約カード**に畳まれたカードは削除できません」が見つかった (#200 で撤去済み)。
 * **人が読むエラーなので、辿れない場所を教えることになる。**
 *
 * ## 一度「宛先を構文で名指しする」で書いて、失敗した
 *
 * 最初は `res.json({...})` の `error` / `note` だけを見た。宛先が構文で分かるので
 * ログやプロンプトを巻き込まない、という狙いだった。**が、これは fail-open だった** —
 * 見えた値しか検査せず、**見えないものは黙って通る**。レビュー (P2) が示した実際の抜け道:
 *
 *   - `{ error }` の**短縮記法** (`ShorthandPropertyAssignment`) — そもそも拾っていなかった
 *   - `error: ng` のようなローカル変数、`error: attachmentRefusal()` のような関数呼び出し
 *   - **別ファイルから流れてくる値** — `db.ts` の `setChecked()` が返すエラーは
 *     `index.ts` で `res.status(409).json({ error })` になり、そのままトーストに出る
 *   - テンプレートに埋め込んだ別ファイルの定数 (`DONE_GATE_RULE`)
 *
 * **値の流れを追い始めると、経路が1つ増えるたびに穴が空く。**
 *
 * ## だから fail-closed にした
 *
 * **backend の日本語の文言を全部見て、正当なものだけ `allow` に名指しで書く。**
 * 検査対象が「見えたもの」ではなく「全部」なので、**新しい経路が増えても勝手に守られる。**
 * 番人は、漏れたときに黙る側ではなく、鳴りすぎる側に倒す。
 *
 * 実測 (2026-08-23): 全走査してのヒットは**2件だけ**で、どちらも移行のログ。
 * 「偽陽性だらけになる」と見積もっていたが、**語をUI向けに絞れば実際には2件**だった。
 *
 * コメントは対象にしない (このリポジトリは経緯をコメントに残す方針 #225)。
 * パーサで読むので、コメントも正規表現リテラルも構文として区別される。 */

const SRC = dirname(fileURLToPath(import.meta.url));
const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** backend が持つ日本語の文言を全部。**どこへ届くかは問わない** —
 * 問うと、問い方の外側が穴になる */
function backendCopy(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf-8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const where = file.slice(SRC.length + 1);
    const push = (text: string) => {
      if (JAPANESE.test(text)) out.push({ file: where, text: text.trim() });
    };
    const walk = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) push(n.text);
      else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) push(n.text);
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return out;
}

/** 撤去済みの機能の、**人に見せる呼び名**。
 *
 * `promptStale.test.ts` (モデル向け: `llm_calls` / `assignee` など道具名・列名) とは別の表。
 * 同じ機能を指すが、宛先ごとに言い回しが違うので、無理に共通化すると偽陽性か見逃しが増える。
 *
 * **見逃したい一文は `allow` に名指しで書く。**曖昧な条件で緩めない —
 * `promptStale.test.ts` は「『無い』と書いてあれば見逃す」という打ち消し規則で
 * 実際に見逃した (「ない」は日本語のどこにでも出る)。 */
const REMOVED_UI: { word: string; why: string; allow?: RegExp }[] = [
  { word: "担当者", why: "#179 で機能ごと廃止", allow: /を削除しました \(#179 担当者の廃止/ },
  { word: "割り振り", why: "#179 で担当者と一緒に廃止" },
  { word: "理由欄", why: "#179 で廃止した reason の呼び名" },
  {
    word: "要約カード",
    why: "#200 で撤去 (いまは「📦 畳んだ完了」)。#238 で実際に残っていた",
    // 撤去処理そのもののログ。「撤去に失敗した」と言うために名前を出す必要がある
    allow: /^要約カードの撤去に失敗:$/,
  },
  { word: "コストの記録", why: "#181 で計測系を撤去" },
  { word: "監査ログ", why: "#181 で撤去" },
  { word: "ログイン", why: "#180 で認証を廃止" },
];

for (const { word, why, allow } of REMOVED_UI) {
  test(`撤去した「${word}」が backend の文言に残っていない (${why})`, () => {
    const found = backendCopy().filter(({ text }) => text.includes(word) && !allow?.test(text));
    assert.deepEqual(
      found,
      [],
      found.map(({ file, text }) => `${file}: ${text.slice(0, 120)}`).join("\n")
    );
  });
}

// **番人が本物を見ていることを、番人自身で確かめる。**
// 集めた文言が空だと、上のテストは全部素通りして「守っている」ように見える。
// #233 ではここが2回続けて甘く、**見えていないのに通っていた。**
//
// ここで名指しするのは、**1周目の fail-open な実装がどれも拾えなかったもの**。
// 「値の流れを追わない」から守れている、という主張がそのままテストになっている。
test("経路に関係なく文言を拾えている (集める側が壊れたら気づく)", () => {
  const copy = backendCopy();
  assert.ok(copy.length > 100, `日本語の文言が拾えていない (${copy.length}件)`);

  const says = (t: string) => copy.some((c) => c.text.includes(t));

  // res.json に直書き (1周目でも拾えていた)
  assert.ok(says("ゴミ箱に無いので戻せません"), "直書きの文言が拾えていない");
  // 定数から (1周目でも拾えていた)
  assert.ok(says("Doneへは移していません"), "定数の文言が拾えていない");
  // **別ファイルの関数の戻り値** — db.ts の setChecked が返し、index.ts が error に載せる
  assert.ok(says("ゴミ箱にあるカードには検収チェックを付けられません"), "別ファイル経由の文言が拾えていない");
  // **関数呼び出しの戻り値** — index.ts の attachmentRefusal()
  assert.ok(says("添付"), "関数が組み立てる文言が拾えていない");
  // **別ファイルの定数をテンプレートに埋めたもの** — db.ts の DONE_GATE_RULE
  assert.ok(says("Review 列"), "別ファイルの定数が拾えていない");
});

// **`allow` は名指しであること。**「その語を含む行は全部見逃す」に緩めると、
// 番人が居るという事実だけが残る。いま許しているのは移行のログ2件だけ
test("allow で見逃しているのは移行のログだけ", () => {
  const allowed = REMOVED_UI.filter((r) => r.allow);
  assert.equal(allowed.length, 2, "見逃しが増えている。増やすなら、なぜ許すのかを allow の隣に書くこと");
  for (const { word, allow } of allowed) {
    // 語だけの文字列を許してしまう `allow` は名指しになっていない
    assert.ok(!allow!.test(word), `「${word}」の allow が広すぎる (語そのものを見逃す)`);
  }
});
