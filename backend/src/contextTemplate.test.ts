import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_TEMPLATE, contextTemplateHint } from "./contextTemplate.js";

/** #186: 前提情報の健康診断。
 *
 * ここが黙ると、前提情報は太る一方になる。他 (完了カード→畳んだ完了の箱、経緯メモ→遅延読み込み、
 * ボード状態→基準スナップショット+差分) と違って、前提情報は**生データがそのまま毎回載る**ため。
 *
 * 実測 (2026-08-17): プロジェクト#1 が 3,162文字まで育ち、中身の7割が終わったイベントだった。 */

/** 節は全部あるが中身は短い、という状態を作る */
function shortButComplete(): string {
  return ["## 列の意味", "## 完了の条件", "## このプロジェクトで使わないもの"].join("\n");
}

test("節が揃っていて短ければ、何も言わない", () => {
  assert.equal(contextTemplateHint(shortButComplete()), null);
});

test("節が欠けていれば、足りないものを挙げる", () => {
  const hint = contextTemplateHint("## 列の意味\nTodoは未着手");
  assert.ok(hint);
  assert.ok(hint!.missing!.includes("## 完了の条件"));
  assert.match(hint!.note!, /reference=true/);
  // 短いのでサイズの指摘は出ない
  assert.ok(!("size" in hint!));
});

test("太ってきたら文字数と、何を見るべきかを言う", () => {
  const fat = shortButComplete() + "あ".repeat(2100);
  const hint = contextTemplateHint(fat);

  assert.ok(hint);
  assert.ok(hint!.size);
  assert.match(hint!.size!, /文字ある/);
  // **何を探せばいいかを書く。**「短くしろ」だけでは何を削るか分からない
  assert.match(hint!.size!, /終わった予定/);
  // **勝手に消させない。**消す確定は人間の仕事
  assert.match(hint!.size!, /勝手に消さず/);
  // 節は揃っているので、そちらは言わない
  assert.ok(!("missing" in hint!));
});

test("節が欠けていて、かつ太っていれば両方言う", () => {
  const hint = contextTemplateHint("## 列の意味\n" + "あ".repeat(2100));
  assert.ok(hint);
  assert.ok(hint!.missing!.length > 0);
  assert.ok(hint!.size);
});

test("しきい値ちょうどでは言わない (超えたときだけ)", () => {
  const base = shortButComplete();
  const pad = 2000 - base.length;

  assert.ok(!contextTemplateHint(base + "あ".repeat(pad))?.size, "2000文字ちょうどは出さない");
  assert.ok(contextTemplateHint(base + "あ".repeat(pad + 1))?.size, "2001文字から出す");
});

// #266: **雛形に「盤ごとに変わらないこと」が戻ってこないように。**
//
// 落とした節 (保留・却下・誤登録の扱い) は3行とも製品の振る舞いで、
// 同じことがシステムプロンプトの行動ルールに書いてある。**読む側から見ると、
// 二重に持つのは確認にならない** — LLMは前提情報が腐っていることに気づけないうえ
// (#261 の `理由欄` は毎ターン読まれていたのに気づかれなかった)、
// **`status` の置き場・列の意味については** `STATUS_DESCRIPTION` が明示的に前提情報へ委ねており、
// 参考 (reference=true) と食い違った場合も参考の側が「前提情報が優先」と譲る。
// つまりこの2つの衝突では**腐った側が勝つ**。行動ルールとの衝突まで一般に前提情報が勝つ、
// という契約はどこにも無い (Codexレビュー P3)。
//
// **語の全面禁止はやめた** (Codexレビュー P2-3)。取りこぼしと巻き込みが両方あった —
// `前提待ち`/`見送り` のように別の語で同じことを書き戻せるし、逆に
// 「この盤では `rejected` を使わない」は `## このプロジェクトで使わないもの` の正しい用法なのに弾かれる。
// **落とした規則そのものを名指しする** — 語ではなく「同じ行に◯と◯が並んでいるか」を見る。
const DROPPED_RULES = [
  { name: "やらない決定の扱い", any: ["やらない", "却下", "見送"], with: ["rejected"] },
  { name: "誤登録・重複の扱い", any: ["誤登録", "重複"], with: ["削除", "ゴミ箱"] },
];

test("落とした規則が雛形に書き戻されていない (#266)", () => {
  for (const line of CONTEXT_TEMPLATE.split("\n")) {
    for (const rule of DROPPED_RULES) {
      const hit = rule.any.some((w) => line.includes(w)) && rule.with.some((w) => line.includes(w));
      assert.ok(
        !hit,
        `雛形が「${rule.name}」を書いている (${line.trim()})。盤ごとに変わらないので、書き換える人がいない。` +
          "同じことはシステムプロンプトの行動ルールにある (#266 で落とした)"
      );
    }
  }
});

// **落とさなかった1行**。製品側 (STATUS_DESCRIPTION) が「status をどこに置くかは前提情報の定義に従う」と
// 盤に委ねているので、雛形から消すと**委ねた先が空になる**。節ごと落とすときに巻き込みかけた (P2-1)
test("保留のときの status の置き場は雛形に残っている (#266)", () => {
  assert.ok(CONTEXT_TEMPLATE.includes("status を変えず"), "保留の置き場が消えている");
  assert.ok(CONTEXT_TEMPLATE.includes("## 列の意味"), "移設先の節ごと消えている");
});

test("既定のテンプレートは、それ自体が診断を通る", () => {
  // テンプレートを直したときに節の見出しがズレると、
  // **新規プロジェクトが作られた瞬間から「節が無い」と言われ続ける**。
  // 実際 TEMPLATE_SECTIONS は「テンプレートを直しても既存プロジェクトが取り残される」問題への
  // 対処として入ったもので、テンプレート側とのズレは静かに壊れる
  assert.equal(contextTemplateHint(CONTEXT_TEMPLATE), null);
});
