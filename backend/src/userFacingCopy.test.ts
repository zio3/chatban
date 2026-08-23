import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** #238: **撤去した機能への言及が、人に見せるエラー文言に残っていないか**の番人。
 *
 * frontend には #233 で番人を置いたが (`e2e/staleUiCopy.spec.ts`)、
 * **backend が返す文言はそこから届かない。**実際 #233 のレビューで
 * 「Doneへ確定して**要約カード**に畳まれたカードは削除できません
 * (**要約から辿れなくなる**ため)」が残っているのが見つかった (#200 で撤去済みの仕組み)。
 * **人が読むエラーなので、辿れない場所を教えることになる。**
 *
 * ## なぜ「backend の日本語文字列を全部見る」ではないか
 *
 * それを実測したら**本物1件に対し偽陽性3件**だった (2026-08-23):
 * LLMへ「その機能は無い」と説明する文、撤去処理そのもののログ、移行のログ。
 * **backend の文字列は宛先が混ざっている。**frontend の「文字列はほぼ全部が画面に出る」
 * が成り立たないので、同じ方式は効かない。
 *
 * ## だから宛先を構文で名指しする
 *
 * 見るのは `res.json({...})` / `res.status(...).json({...})` の **`error` と `note` だけ**。
 * この2つが人に届くことは frontend 側で確かめられる:
 *
 *   - `api.ts` … 「サーバーは断る理由を {error} で返すので、**それをそのまま人に見せる**」
 *   - `App.tsx` … `if (!r.ok && r.note) setToast({ message: r.note })`
 *
 * 「ログとプロンプトを除外する規則」ではなく**入口を名指ししている**ので、
 * 宛先を推測で判定していない。MCPの応答や `log()` は最初から入らない。
 *
 * 定数で書かれた文言 (`DONE_GATE_NOTE` など) も同じファイル内で引いて中身を見る —
 * **名前で渡していると見えなくなる**のでは、番人の意味がない。 */

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

/** `res.json(...)` か `res.status(...).json(...)` の呼び出しか */
function isResponseJson(node: ts.CallExpression): boolean {
  const fn = node.expression;
  if (!ts.isPropertyAccessExpression(fn) || fn.name.text !== "json") return false;
  const target = fn.expression;
  if (ts.isIdentifier(target)) return target.text === "res";
  // res.status(409).json(...)
  if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) {
    const inner = target.expression.expression;
    return ts.isIdentifier(inner) && inner.text === "res";
  }
  return false;
}

/** 人に届く文言を集める。文字列そのものと、同じファイルの定数の両方から */
function userFacingCopy(): { file: string; key: string; text: string }[] {
  const out: { file: string; key: string; text: string }[] = [];

  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf-8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const where = file.slice(SRC.length + 1);

    // ファイル内の文字列定数を先に集める (DONE_GATE_NOTE のように名前で渡されるため)
    const consts = new Map<string, string>();
    const collectConsts = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = n.initializer;
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) consts.set(n.name.text, init.text);
        else if (ts.isTemplateExpression(init)) consts.set(n.name.text, init.getText(sf));
      }
      ts.forEachChild(n, collectConsts);
    };
    collectConsts(sf);

    const textOf = (v: ts.Expression): string | undefined => {
      if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return v.text;
      if (ts.isTemplateExpression(v)) return v.getText(sf);
      if (ts.isIdentifier(v)) return consts.get(v.text);
      // `cond ? "A" : "B"` などは両方見る
      if (ts.isConditionalExpression(v)) return [textOf(v.whenTrue), textOf(v.whenFalse)].filter(Boolean).join(" / ");
      return undefined;
    };

    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) && isResponseJson(n) && n.arguments[0]) {
        // **引数の中を深く探す。**最上位のプロパティだけ見ていると、
        // `...(cond ? { note: DONE_GATE_NOTE } : {})` のように
        // 三項演算子やスプレッドの中に置かれた文言を1つも拾えない
        // (この番人の健全性テストが実際に捕まえた)
        const dig = (m: ts.Node) => {
          if (ts.isPropertyAssignment(m)) {
            const key = m.name.getText(sf).replace(/['"]/g, "");
            if (key === "error" || key === "note") {
              const text = textOf(m.initializer);
              if (text && JAPANESE.test(text)) out.push({ file: where, key, text });
            }
          }
          ts.forEachChild(m, dig);
        };
        dig(n.arguments[0]);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return out;
}

/** 撤去済みの機能の、**人に見せる呼び名**。
 * `promptStale.test.ts` (モデル向け) とも `staleUiCopy.spec.ts` (画面) とも別の表。
 * 同じ機能を指すが、宛先ごとに言い回しが違うので、無理に共通化すると偽陽性か見逃しが増える。 */
const REMOVED_UI: { word: string; why: string; allow?: RegExp }[] = [
  { word: "担当者", why: "#179 で機能ごと廃止" },
  { word: "割り振り", why: "#179 で担当者と一緒に廃止" },
  { word: "理由欄", why: "#179 で廃止した reason の呼び名" },
  { word: "要約カード", why: "#200 で撤去 (いまは「📦 畳んだ完了」)。#238 で実際に残っていた" },
  { word: "コストの記録", why: "#181 で計測系を撤去" },
  { word: "監査ログ", why: "#181 で撤去" },
  { word: "ログイン", why: "#180 で認証を廃止" },
];

for (const { word, why, allow } of REMOVED_UI) {
  test(`撤去した「${word}」が人に見せる文言に残っていない (${why})`, () => {
    const found = userFacingCopy().filter(({ text }) => text.includes(word) && !allow?.test(text));
    assert.deepEqual(
      found,
      [],
      found.map(({ file, key, text }) => `${file} [${key}]: ${text.slice(0, 120)}`).join("\n")
    );
  });
}

// **番人が本物を見ていることを、番人自身で確かめる。**
// 集めた文言が空だと、上のテストは全部素通りして「守っている」ように見える。
// #233 ではここが2回続けて甘く、**見えていないのに通っていた** — 同じ轍を踏まない
test("人に見せる文言をちゃんと拾えている (集める側が壊れたら気づく)", () => {
  const copy = userFacingCopy();
  assert.ok(copy.length >= 4, `人に見せる文言が拾えていない (${copy.length}件)`);

  const says = (t: string) => copy.some((c) => c.text.includes(t));
  // 文字列で直に書いたもの
  assert.ok(says("ゴミ箱に無いので戻せません"), "error に直書きした文言が拾えていない");
  // **定数で渡しているもの** (DONE_GATE_NOTE)。ここが拾えないと、名前で渡すだけで番人を抜けられる
  assert.ok(says("Doneへは移していません"), "定数で渡している文言 (note) が拾えていない");
  assert.ok(
    copy.some((c) => c.key === "note"),
    "note を1件も拾えていない (人に見せる出口は error だけではない)"
  );
});
