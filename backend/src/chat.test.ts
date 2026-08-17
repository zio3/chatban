import assert from "node:assert/strict";
import { test } from "node:test";
import { extractChoices } from "./chat.js";
import { differs } from "./archive.js";
import { readFileSync } from "node:fs";
import { tools } from "./chat.js";
import { DONE_GATE_RULE, exportableSettings, isTaskStatus, mayEnterDone } from "./db.js";
import { AGENT_STATUS_VALUES } from "./chat.js";
import { isAllowedOrigin } from "./origin.js";

// #180: 認証を廃止したので、境界は「待ち受けを閉じる」と「知らないページを断る」だけ。
// **cors() の許可リストは境界にならない** — 許可しない Origin には ACAO を付けないだけで
// リクエストはハンドラまで届き、状態も変わる (Codexレビュー実測: POST が 200)。
// ブラウザが遮るのはレスポンスを読むことだけなので、書き込みは通る。
// 判定はRESTとSocket.IOで共有する (入口ごとに書き分けると必ずズレる)

const ORIGINS = ["http://localhost:5173", "http://localhost:5199"];

test("許可リストに載っているページからは通す", () => {
  assert.equal(isAllowedOrigin("http://localhost:5173", ORIGINS), true);
});

test("知らないページからは断る", () => {
  assert.equal(isAllowedOrigin("https://evil.example", ORIGINS), false);
  // ポート違い・スキーム違いは別オリジン。前方一致で緩めない
  assert.equal(isAllowedOrigin("http://localhost:5174", ORIGINS), false);
  assert.equal(isAllowedOrigin("https://localhost:5173", ORIGINS), false);
  assert.equal(isAllowedOrigin("http://localhost:5173.evil.example", ORIGINS), false);
});

test("Originが無い呼び出しは通す (curl・スクリプト・MCP)", () => {
  // ブラウザは必ず Origin を付けるので、ここを開けてもページからの攻撃は増えない。
  // 塞ぐと Claude Code から /mcp に繋がらなくなる
  assert.equal(isAllowedOrigin(undefined, ORIGINS), true);
  assert.equal(isAllowedOrigin("", ORIGINS), true);
  assert.equal(isAllowedOrigin(null, ORIGINS), true);
});

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

// #126 → #180: 発言者を決める pickSpeaker のテストがここにあった。
// 個人利用に特化して「誰が言ったか」を持たなくなったので、判断そのものが無くなった
// (話しかけてくるのは常に持ち主ひとり。実測でも null 554件 / "zio" 100件だった)。

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

// TypeScript の TaskStatus は実行時には消える。RESTは検証していなかったので
// status:"banana" が保存でき、ボードは4列でしか抽出しないのでタスクがどこにも出ず、
// 詳細を開くと STATUS_LABELS[status] が undefined で画面が落ちた (自動レビュー指摘)。
// 「消えた」ように見えて実在する、が一番たちが悪い

test("実在する列だけを通す", () => {
  for (const s of ["todo", "inprogress", "review", "done"]) assert.equal(isTaskStatus(s), true);
});

test("知らない値は列として認めない", () => {
  assert.equal(isTaskStatus("banana"), false);
  assert.equal(isTaskStatus("Done"), false); // 大文字違いも別物
  assert.equal(isTaskStatus(""), false);
  assert.equal(isTaskStatus(undefined), false);
  assert.equal(isTaskStatus(null), false);
  assert.equal(isTaskStatus(3), false);
});

// Export は「検証のために人へ渡すファイル」「記事の一次資料」。settings を全行そのまま
// 出していたため、セッション署名鍵が平文で入っていた (自動レビュー指摘)。
// #180 で認証ごと廃止し、いま settings に秘密は無い。**それでもこの番人は残す** —
// 秘密を持つ設定が増えたときに、伏字リストへの追加を忘れたら落ちる側にしておく。

test("Exportに秘密らしき値を素で載せない", () => {
  const rows = exportableSettings();
  assert.equal(
    rows.find((r) => r.key === "auth.sessionSecret"),
    undefined,
    "認証は #180 で廃止した。auth.sessionSecret が残っているなら削除が漏れている"
  );
  for (const r of rows) assert.ok(!/^[0-9a-f]{64}$/.test(r.value), `${r.key} に64桁hexが素で載っている`);
});

test("伏せるのは鍵だけ。設定が存在したことは記録として残す", () => {
  const rows = exportableSettings();
  // モデル設定などは値ごと残る (#88: どのモデルで動いていたかを追うため)
  for (const r of rows) assert.ok(typeof r.key === "string" && r.key.length > 0);
});

// 公開しているツールに実装があるか。restore_tasks はツール定義とゴミ箱画面のプロンプトに
// 出しているのに実行の分岐が無く、呼ばれると unknown tool が返っていた (自動レビュー指摘)。
// 画面が「チャットで戻せる」と案内しているのに成立しない状態で、MCP側には実装があった。
// 「入口ごとに契約がズレる」の変種 — 契約だけ公開して実装を書き忘れる形。
// 個別に直すのではなく、公開と実装の突き合わせを機械で見る。

test("チャットに公開したツールには必ず実装がある", () => {
  const src = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
  const implemented = new Set([...src.matchAll(/^\s*case "([a-z_]+)":/gm)].map((m) => m[1]));
  const published = tools.map((t: any) => t.function.name);
  const missing = published.filter((n: string) => !implemented.has(n));
  assert.deepEqual(missing, [], `実装の無いツール: ${missing.join(", ")}`);
});
