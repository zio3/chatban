import assert from "node:assert/strict";
import { test } from "node:test";
import { extractChoices } from "./chat.js";
import { differs } from "./archive.js";
import { isAllowed, pickSpeaker, readCookie } from "./auth.js";
import { DONE_GATE_RULE, mayEnterDone } from "./db.js";
import { AGENT_STATUS_VALUES } from "./chat.js";

// 返信ボタンの記法 [[選択肢]] の取り出し。
// ここはLLMを介さずに固定できる唯一の部分なので (発火するかどうかはモデル次第でも、
// 発火したときの読み取りは決定的)、E2Eではなくユニットで押さえる。

test("[[選択肢]] を取り出し、本文からは消す", () => {
  const r = extractChoices("#12を鈴木さんに振りますか?  [[鈴木さんに振る]] [[やめておく]]");
  assert.deepEqual(r.options, ["鈴木さんに振る", "やめておく"]);
  assert.equal(r.text, "#12を鈴木さんに振りますか?");
});

test("記法が無い応答は素通しする", () => {
  const r = extractChoices("#12を鈴木さんに振りました。");
  assert.deepEqual(r.options, []);
  assert.equal(r.text, "#12を鈴木さんに振りました。");
});

test("同じ応答が2回書かれていたら畳む (実測でモデルが繰り返すことがある)", () => {
  const body = "どれから着手しますか。  [[#4から]] [[#5から]]";
  const r = extractChoices(`${body}\n${body}`);
  assert.deepEqual(r.options, ["#4から", "#5から"]);
  assert.equal(r.text, "どれから着手しますか。");
});

test("重複した選択肢は1つにまとめ、5個目以降は落とす", () => {
  const r = extractChoices("[[A]] [[A]] [[B]] [[C]] [[D]] [[E]]");
  assert.deepEqual(r.options, ["A", "B", "C", "D"]);
});

test("長すぎるもの・改行を含むものは選択肢として拾わない (本文の角括弧を巻き込まない)", () => {
  const long = "あ".repeat(25);
  const r = extractChoices(`参照: [[${long}]] と [[改\n行]] は本文のまま`);
  assert.deepEqual(r.options, []);
  assert.equal(r.text, `参照: [[${long}]] と [[改\n行]] は本文のまま`);
});

test("選択肢だけの行が残っても空行は畳む", () => {
  const r = extractChoices("どうしますか。\n\n[[はい]] [[いいえ]]\n\n押さずに打っても構いません。");
  assert.deepEqual(r.options, ["はい", "いいえ"]);
  assert.equal(r.text, "どうしますか。\n\n押さずに打っても構いません。");
});

// アーカイブ要約の世代チェック。regenerateCard は「読む → LLMを待つ(10〜100秒) → 保存」
// なので、待っている間にカードの顔ぶれが変わったら結果を捨てる必要がある。
// 実測で、2件で生成を始めて途中で1件外すと、外したはずのタスクが要約に残った。

test("顔ぶれが変わっていなければ保存する", () => {
  assert.equal(differs([1, 2, 3], [1, 2, 3]), false);
  assert.equal(differs([], []), false);
});

test("タスクが外れたら古い結果として捨てる", () => {
  assert.equal(differs([2], [1, 2]), true); // 生成中にDoneから戻された
  assert.equal(differs([], [1]), true); // 最後の1件が外れた
});

test("タスクが増えても捨てる (次の検収バッチが合流した)", () => {
  assert.equal(differs([1, 2, 3], [1, 2]), true);
});

test("同じ件数でも中身が違えば捨てる", () => {
  assert.equal(differs([1, 3], [1, 2]), true);
});

// #126: 発言者はシステムが決める。以前はメインチャットだけがセッションを見ていて、
// タスクチャットはリクエストの speaker を素通ししていたため、ログイン中でも
// 任意の名前を名乗れた。判断を1か所 (pickSpeaker) に寄せたので、ここで押さえる。

const me = { email: "sato@example.com", name: "佐藤", picture: null } as any;

test("ログイン済みなら自己申告より本人を優先する", () => {
  assert.deepEqual(pickSpeaker(me, "田中"), { name: "佐藤", email: "sato@example.com" });
});

test("ログインしていなければ自己申告を使うが、emailは付けない (未検証の印)", () => {
  assert.deepEqual(pickSpeaker(null, "田中"), { name: "田中", email: null });
});

test("名乗りが無ければ発言者なし", () => {
  assert.deepEqual(pickSpeaker(null, undefined), { name: null, email: null });
  assert.deepEqual(pickSpeaker(null, ""), { name: null, email: null });
  assert.deepEqual(pickSpeaker(null, { name: "偽" }), { name: null, email: null });
});

// #113: セッションCookieは最大30日有効なので、許可リストから外した相手が
// 最長1か月そのまま入れてしまう (自動レビュー指摘)。リクエストごとに突き合わせる。

test("リストに載っていれば通す (大文字小文字は区別しない)", () => {
  assert.equal(isAllowed("Sato@Example.com", ["sato@example.com"]), true);
});

test("外された相手は通さない (セッションが生きていても)", () => {
  assert.equal(isAllowed("sato@example.com", ["tanaka@example.com"]), false);
});

test("リストが空なら通す — ここで閉じると設定タブごと詰む", () => {
  assert.equal(isAllowed("sato@example.com", []), true);
});

// 認証onのSocket.IOハンドシェイクは、認証を通らない相手の生Cookieを最初に触る場所。
// decodeURIComponent が URIError を投げると socket.io は捕まえず uncaughtException になり、
// Cookieを1回送られるだけでプロセスが落ちた (実測。自動レビュー指摘)。

test("壊れたパーセントエンコードは投げずに「無い」を返す", () => {
  assert.equal(readCookie("chatban_session=%E0%A4%A", "chatban_session"), null);
});

test("正常な値はデコードして返す", () => {
  assert.equal(readCookie("chatban_session=a%2Eb", "chatban_session"), "a.b");
});

test("他のCookieに混ざっていても取れる。無ければnull", () => {
  assert.equal(readCookie("x=1; chatban_session=tok; y=2", "chatban_session"), "tok");
  assert.equal(readCookie("x=1; y=2", "chatban_session"), null);
  assert.equal(readCookie(undefined, "chatban_session"), null);
});

// Doneへ入れる条件。PR #1 では検収API (approveChecked) だけが持っていたため、
// PATCH /api/tasks/:id に status:"done" を投げれば素通りしていた (自動レビュー指摘)。
// フロントは Done列へのD&Dを禁止しているが、その禁止がクライアント側にしか無かった —
// PR #1 で塞いだのとまったく同じ形。条件そのものを updateTasks の不変条件にする。

const review = { status: "review" as const, checkedAt: "2026-08-12 10:00", trashedAt: null };

test("Review列で検収チェックが付いていれば入れる", () => {
  assert.equal(mayEnterDone(review), true);
});

test("検収チェックが無ければ入れない (Review列にいても)", () => {
  assert.equal(mayEnterDone({ ...review, checkedAt: null }), false);
});

test("Review列以外からは入れない", () => {
  assert.equal(mayEnterDone({ ...review, status: "todo" }), false);
  assert.equal(mayEnterDone({ ...review, status: "inprogress" }), false);
});

test("ゴミ箱にあるものは入れない (印が残っていても)", () => {
  assert.equal(mayEnterDone({ ...review, trashedAt: "2026-08-12 09:00" }), false);
});

test("エージェントの契約に done は無い — 選べないものは選ばれない", () => {
  assert.deepEqual([...AGENT_STATUS_VALUES], ["todo", "inprogress", "review"]);
});

test("断る理由 (経路) を説明する。できませんとだけ言わない", () => {
  // 「できません」だけだと、エージェントは言い換えて再挑戦する。
  // 順路を書いておけば、reviewに置いて人間に検収を促す、が次の一手になる
  assert.match(DONE_GATE_RULE, /Review列/);
  assert.match(DONE_GATE_RULE, /検収/);
  assert.match(DONE_GATE_RULE, /直送はできません/);
});
