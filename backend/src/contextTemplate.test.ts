import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_TEMPLATE, contextTemplateHint } from "./contextTemplate.js";

/** #186: 前提情報の健康診断。
 *
 * ここが黙ると、前提情報は太る一方になる。他 (完了カード→要約カード、経緯メモ→遅延読み込み、
 * ボード状態→基準スナップショット+差分) と違って、前提情報は**生データがそのまま毎回載る**ため。
 *
 * 実測 (2026-08-17): プロジェクト#1 が 3,162文字まで育ち、中身の7割が終わったイベントだった。 */

/** 節は全部あるが中身は短い、という状態を作る */
function shortButComplete(): string {
  return ["## 列の意味", "## 完了の条件", "## できなかったとき・やらないとき", "## このプロジェクトで使わないもの"].join(
    "\n"
  );
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

test("既定のテンプレートは、それ自体が診断を通る", () => {
  // テンプレートを直したときに節の見出しがズレると、
  // **新規プロジェクトが作られた瞬間から「節が無い」と言われ続ける**。
  // 実際 TEMPLATE_SECTIONS は「テンプレートを直しても既存プロジェクトが取り残される」問題への
  // 対処として入ったもので、テンプレート側とのズレは静かに壊れる
  assert.equal(contextTemplateHint(CONTEXT_TEMPLATE), null);
});
