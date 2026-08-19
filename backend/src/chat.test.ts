import assert from "node:assert/strict";
import { test } from "node:test";
import { extractChoices, suggestSkipReason } from "./chat.js";
import { readFileSync } from "node:fs";
import { buildTools } from "./chat.js";
import { DONE_GATE_RULE, isDueDate, isTaskStatus, mayEnterDone } from "./db.js";
import { AGENT_STATUS_VALUES } from "./chat.js";
import { isAllowedOrigin, isBrowserCrossSite } from "./origin.js";

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

// Origin だけ見ていると、**Origin が付かないブラウザ要求**が素通りする。
// `<img src="http://localhost:8787/api/suggestions">` のような subresource GET がそれで、
// 実際そこは有料のLLM呼び出しを起こしていた (自動レビュー指摘)。
// Sec-Fetch-Site はブラウザが自分で付けるのでページ側から偽装できない

test("他所のページからの要求は Sec-Fetch-Site で断る (Originが無くても)", () => {
  assert.equal(isBrowserCrossSite("cross-site"), true);
});

test("自分のページとブラウザ以外は通す", () => {
  assert.equal(isBrowserCrossSite("same-origin"), false);
  assert.equal(isBrowserCrossSite("same-site"), false);
  assert.equal(isBrowserCrossSite("none"), false); // アドレス欄に打った / ブックマーク
  assert.equal(isBrowserCrossSite(undefined), false); // curl・スクリプト・MCP は送らない
});

test("Originが無い呼び出しは通す (curl・スクリプト・MCP)", () => {
  // 状態を変える cross-origin の fetch/フォーム送信と WebSocket は必ず Origin を伴う。
  // ただしトップレベルのGETナビゲーションには付かないので、**課金・外部アクセスを伴う処理を
  // GETに置かない**ことが前提の判断 (origin.ts の注記)。
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

// #153: 期限の形式チェック。契約は YYYY-MM-DD と言っていたのに確かめておらず、
// `not-a-date` がそのまま保存された (ユーザー報告)。
// **保存できてしまう値のほうが、弾かれる値より始末が悪い** — バッジや「期限が近い順」が静かに狂う
test("期限は YYYY-MM-DD だけ通る", () => {
  for (const ok of ["2026-08-17", "2026-01-01", "2024-02-29" /* 閏年 */, "2026-12-31"]) {
    assert.equal(isDueDate(ok), true, `${ok} は通るはず`);
  }
});

test("**暦として在る日かも見る** (正規表現だけだと 2026-02-31 が通る)", () => {
  for (const ng of ["2026-02-31", "2026-13-01", "2026-00-10", "2026-01-32", "2023-02-29"]) {
    assert.equal(isDueDate(ng), false, `${ng} は弾くはず`);
  }
});

test("形が違うものを弾く (報告された not-a-date を含む)", () => {
  for (const ng of [
    "not-a-date", // ユーザー報告の実物
    "2026/08/17", // 区切りが違う
    "2026-8-17", // 0埋めなし
    "26-08-17",
    "2026-08-17T00:00:00", // 時刻つき
    " 2026-08-17", // 前後の空白は通さない (保存前に整えるのは呼ぶ側の責任)
    "2026-08-17 ",
    "",
  ]) {
    assert.equal(isDueDate(ng), false, `${JSON.stringify(ng)} は弾くはず`);
  }
});

test("文字列以外を渡されても落ちない (外から来る値なので型は当てにしない)", () => {
  for (const ng of [null, undefined, 20260817, {}, [], true, new Date()]) {
    assert.equal(isDueDate(ng), false, `${JSON.stringify(ng)} は弾くはず`);
  }
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

// 提案チップを「呼ばずに諦める」条件。#167 でOFFにできるようにしたとき、
// **表示だけ消すのではなく呼び出し自体を止める**のが要件だった (切っている間はコストも止まる)。
// #181 まではE2Eが llm_calls の件数差で確かめていたが、計測系の撤去でテーブルが無くなった。
// 共有ログの行数で数える形は開発サーバーの書き込みで誤判定しうるので、判断を純粋関数に切り出した。
//
// **このテストが保証するのは判定結果だけ。**「generateSuggestions がこの結果を見て
// 実際に chatCompletion を呼ばずに return する」ところは検証していない (自動レビュー指摘)。
// そこまで固定するには LLM 呼び出しを差し替えられる形にする必要があり、それは別の改修になる。
// いま呼び出し0回を保証しているものは無い — 判定の正しさと、E2Eの「OFFなら空で返る」までが範囲

// #209: ON/OFF設定は撤去した (#199で作った設定タブごと)。代わりに起動猶予が先頭に立つ
const AFTER_BOOT = 60_000; // 猶予を過ぎた状態

test("提案の生成を諦める判定: 起動直後が最優先で booting を返す", () => {
  assert.equal(suggestSkipReason({ sinceBootMs: 0, chatBusy: false, emptyBoard: false }), "booting");
  // 他の条件が「生成してよい」と言っていても起動直後が勝つ
  assert.equal(suggestSkipReason({ sinceBootMs: 59_999, chatBusy: true, emptyBoard: true }), "booting");
});

test("提案の生成を諦める判定: 会話中は chat-busy、空ボードは empty-board", () => {
  assert.equal(suggestSkipReason({ sinceBootMs: AFTER_BOOT, chatBusy: true, emptyBoard: false }), "chat-busy");
  assert.equal(suggestSkipReason({ sinceBootMs: AFTER_BOOT, chatBusy: false, emptyBoard: true }), "empty-board");
});

test("提案の生成を諦める判定: 猶予を過ぎ・会話中でない・中身があるときだけ null (生成へ進む)", () => {
  assert.equal(suggestSkipReason({ sinceBootMs: AFTER_BOOT, chatBusy: false, emptyBoard: false }), null);
  // 境界: ちょうど猶予に達したら通す
  assert.equal(suggestSkipReason({ sinceBootMs: 60_000, chatBusy: false, emptyBoard: false }), null);
});

// #180 で「Exportに認証の設定と64桁hexが載っていないこと」を見る番人を2本置いていたが、
// **#181 で Export (全ログExport / 監査タブ) ごと撤去したので消した。**
// 渡すファイルが無くなったので、そこに秘密が載る経路も無い。
// 設定を読める窓口は残っていない (query_log の許可リストに settings は入っていない)

// 3本目に「設定が存在したことは記録として残る (#88: どのモデルで動いていたかを追うため)」という
// テストがあったが**消した。**rows をループして key が非空かを見るだけで、**rows が空でも通る** —
// 「既存の設定がExportに残る」ことを何も保証していなかった (自動レビュー指摘)。
// exportableSettings は管理DBを直接読むので、意味のある形にするには設定を注入できるようにする必要がある。
// **保証できないテストを名前で保証しているように見せるほうが、無いより悪い** (通っているのに守られていない)

// 公開しているツールに実装があるか。restore_tasks はツール定義とゴミ箱画面のプロンプトに
// 出しているのに実行の分岐が無く、呼ばれると unknown tool が返っていた (自動レビュー指摘)。
// 画面が「チャットで戻せる」と案内しているのに成立しない状態で、MCP側には実装があった。
// 「入口ごとに契約がズレる」の変種 — 契約だけ公開して実装を書き忘れる形。
// 個別に直すのではなく、公開と実装の突き合わせを機械で見る。

test("チャットに公開したツールには必ず実装がある", () => {
  const src = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
  const implemented = new Set([...src.matchAll(/^\s*case "([a-z_]+)":/gm)].map((m) => m[1]));
  const published = buildTools([]).map((t: any) => t.function.name);
  const missing = published.filter((n: string) => !implemented.has(n));
  assert.deepEqual(missing, [], `実装の無いツール: ${missing.join(", ")}`);
});
