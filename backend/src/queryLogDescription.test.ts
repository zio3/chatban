import assert from "node:assert/strict";
import test from "node:test";

import { QUERY_LOG_DESCRIPTION } from "./chat.js";

/** #255: **「SQLiteなら知っている知識」を説明に書き戻さない。**
 *
 * MCPのツール定義はセッションのたびに全文が読まれる。実測 (2026-08-25) で
 * `query_log` は10本合計 12,862字のうち 3,573字 = **27.8%** を占めていた。
 *
 * 方言の説明を185字かけて書いていたが、`chat_messages.trace` から復元した
 * **実際に発行されたSQL 98本で、方言違反0件・失敗0件**だった。
 * 事故を見て足した行ではなく、予防で書いた行だった。
 *
 * **落としてよかったのは2つ揃ったから** — 転んだ形跡が無く、かつモデルが元から持つ知識。
 * 「使われていないから消す」ではない (#189)。 */

const dialectKnowledge = ["date_trunc", "INTERVAL", "NOW()", "真偽値は 0/1", "文字列連結は ||"];

test("SQLiteの一般知識を説明に書かない (モデルが元から持っている)", () => {
  for (const w of dialectKnowledge) {
    assert.ok(
      !QUERY_LOG_DESCRIPTION.includes(w),
      `「${w}」は SQLite と言えば伝わる。ここに書くとMCPが毎セッション読むぶんだけ高くつく`
    );
  }
});

// **方言ではなく、このDBのスキーマの事実。**SQLiteを知っていても、列がUNIX秒かTEXTか、
// UTCかローカルかは分からない。`store.ts` の既定は datetime('now','localtime')
test("日時の入り方は書く (SQLiteを知っていても分からない)", () => {
  assert.match(QUERY_LOG_DESCRIPTION, /ローカル時刻/, "ローカル時刻であることが書かれていない");
  assert.match(QUERY_LOG_DESCRIPTION, /YYYY-MM-DD/, "文字列で入っていることが書かれていない");
});

// **散文で言ったことを、SQLで言い直さない。**外した5本はどれも上の行が既に言っている
// 事実の書き直しで、実測でも真似したSQLは0件だった
const restatedInProse = [
  "length(context) ctx FROM live_cards",
  "ORDER BY updated_at DESC LIMIT 15",
  "trashed_at IS NOT NULL ORDER BY trashed_at",
  "status='review' AND checked_at IS NULL",
  "done_day >= date('now','localtime','-7 days')",
];

test("散文が言っている事実を、例文で言い直さない", () => {
  for (const w of restatedInProse) {
    assert.ok(!QUERY_LOG_DESCRIPTION.includes(w), `「${w}」は上の行が既に言っている`);
  }
});

// **例文が仕事をしているのはここだけだった** (実測: 18件と12件で真似されている)。
// context と context_version を一緒に読むのは、列の一覧からは出てこない組み合わせ
test("context と context_version を一緒に読む例は残す", () => {
  assert.match(QUERY_LOG_DESCRIPTION, /例\(1件の詳細/, "1件の詳細の例が消えている");
  assert.match(QUERY_LOG_DESCRIPTION, /context, context_version/, "版を一緒に読む形が消えている");
});

// **同じ事実を散文と例文の両方で言わない** (#255)。太った原因は行を足したことより、
// **同じことを2回言っていた**こと。片方に寄せる — 例文で通じるなら例文だけにする
test("散文と例文で同じことを2回言わない", () => {
  const lines = QUERY_LOG_DESCRIPTION.split("\n");
  const examples = lines.filter((l) => l.startsWith("例")).join("\n");
  const prose = lines.filter((l) => !l.startsWith("例")).join("\n");

  for (const w of ["length(context)", "WHERE id=<番号>", "date() を書かなくてよい"]) {
    assert.ok(
      !(examples.includes(w) && prose.includes(w)),
      `「${w}」が散文と例文の両方にある。どちらか一方に寄せる`
    );
  }
});

// 説明が伸びたら気づく。**上限そのものに意味は無い**が、伸ばすときに一度立ち止まる線になる
test("説明の長さに歯止めを置く", () => {
  assert.ok(
    QUERY_LOG_DESCRIPTION.length < 2600,
    `${QUERY_LOG_DESCRIPTION.length}字。伸ばすなら、その情報がMCPの毎セッションぶんの価値があるか先に考える`
  );
});

// #262: **`chat_messages` を窓口から外した。**#258 は説明だけを落として列を残したが、
// **能力のほうを畳んだ** — 費用ではなく思想の判断 (「チャットの話から絞るはやらない」zio)。
// **#258 で戻した `role` の2値も一緒に落ちる**。前提が変わったのであって、あれが誤りだったのではない
test("chat_messages は説明にも「引けるもの」にも出てこない", () => {
  assert.ok(!QUERY_LOG_DESCRIPTION.includes("chat_messages"), "chat_messages がまだ案内されている");
  for (const w of ["role は user=持ち主", "過去の話を聞かれたらここを掘る", "いつ何を頼まれたか"]) {
    assert.ok(!QUERY_LOG_DESCRIPTION.includes(w), `「${w}」が残っている`);
  }
});

// **窓口そのものが閉じていること。**説明から消しても引けたままなら、閉じたことにならない
// (#258 のときは実際そうで、説明だけ落ちて口は開いていた)
test("引ける表の一覧から外れている (説明ではなく実体)", async () => {
  const { PUBLIC_TABLES, PUBLIC_COLUMNS } = await import("./db.js");
  assert.ok(!PUBLIC_TABLES.includes("chat_messages"), "許可リストに残っている");
  // 専用列も落とす。**この一覧は「引ける表の列」**であって、DBに在る列の一覧ではない
  for (const c of ["role", "content", "trace", "usage", "card_id"]) {
    assert.ok(!PUBLIC_COLUMNS.includes(c), `${c} が引ける列に残っている`);
  }
});

// **失う機能を名指しで固定する。**キーワードで会話を引く経路は残っている —
// 落としたのは「時期や条件で絞る」だけで、「あんな話してたっけ」は答えられる
test("会話をキーワードで引く経路は残っている (search_cards)", async () => {
  const { buildTools } = await import("./chat.js");
  const names = buildTools([]).map((t: any) => t.function.name);
  assert.ok(names.includes("search_cards"), "会話を引く手段が1つも無くなっている");
});

// **従えない指示を作っていないこと。**説明を削るときに一番危ないのはこれ
test("query_log を使えと言っている用途は、説明から引ける", async () => {
  const { buildSystemPrompt } = await import("./chat.js");
  // #265: `buildSystemPrompt()` は活動中のプロジェクトを読むので、1件も無いと落ちる。
  // 実データの管理DBを開いていたから通っていただけだった
  const { ensureInitialProject } = await import("./store.js");
  ensureInitialProject();
  const prompt = buildSystemPrompt();

  // #262: **指示のほうを消した。**説明から chat_messages を落とすなら、
  // システムプロンプトが query_log で会話を引けと言っていてはいけない (従えない指示になる)
  assert.ok(
    !/時期や条件で絞りたいとき.*query_log/.test(prompt),
    "会話を query_log で絞れと、まだ指示している (説明からは落としたので従えない)"
  );
  if (/project_context/.test(prompt)) {
    assert.match(QUERY_LOG_DESCRIPTION, /project_context\(/, "前提情報の列が説明に無い (版を読めない)");
  }
});
