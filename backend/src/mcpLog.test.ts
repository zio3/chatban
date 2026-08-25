import assert from "node:assert/strict";
import test from "node:test";

import { classifyQueryError, redactSql, argDetail, argShape, MCP_TOOL_NAMES, safe, safeToolName, isFailure, toolCalls, toolOutcome, throwOutcome } from "./mcpLog.js";

/** #247: **ログに出てよいのは「こちらが決めた語」だけ。**
 *
 * 最初は「値を出さなければ安全」と考えてキー名をそのまま出していたが、これは誤りだった
 * (Codexレビュー P2)。`create_cards` の要素スキーマは `.passthrough()` なので、
 * **キー名そのものが外部入力**になる。 */

// ---- 値を出さない (元からの性質) ----

test("値は1文字も残さない (経緯メモの本文が混ざらない)", () => {
  const line = argShape({
    updates: [{ id: 12, context: "SECRET-社外に出せない経緯", summary: "SECRET-要約" }],
  });

  assert.ok(!line.includes("SECRET"), `本文が記録に出ている: ${line}`);
  assert.ok(!line.includes("12"), `値が記録に出ている: ${line}`);
  assert.ok(line.includes("context") && line.includes("summary"), `キー名は残っていない: ${line}`);
});

// ---- キー名も外部入力として扱う (レビューで見つかった穴) ----

test("契約に無いキーは平文にせず、個数だけ数える", () => {
  const line = argShape({ cards: [{ title: "x", "SECRET-顧客情報": "y" }] });

  assert.ok(!line.includes("SECRET"), `キー名から本文が漏れている: ${line}`);
  assert.match(line, /\+1不明/, `契約に無いキーを使ったことが消えている: ${line}`);
  assert.ok(line.includes("title"), "契約にあるキーまで消えている");
});

test("トップレベルの未知キーも同じ扱い", () => {
  const line = argShape({ ids: [1], "SECRET-混入": 1 });
  assert.ok(!line.includes("SECRET"), line);
  assert.match(line, /\+1不明/);
});

// **改行を残すと1回の呼び出しで複数行を作れる。**行数を数える集計が丸ごと偽装できる
test("制御文字は落とす (ログの行を作らせない)", () => {
  const forged = "a\n[2099-01-01 00:00:00] [mcp] sync_board ok";
  assert.ok(!safe(forged).includes("\n"), "改行が残っている");
  assert.ok(!safe("a\r\nb\tc").match(/[\r\n\t]/), "制御文字が残っている");
  assert.equal(safe("  詰める   空白  "), "詰める 空白");
  assert.equal(safe(undefined), "");
  assert.equal(safe(123), "");
});

test("自由文は長さを切る (1行に収まる)", () => {
  assert.ok(safe("あ".repeat(500)).length < 70, "切られていない");
});

test("登録済みでないツール名は平文にしない", () => {
  assert.equal(safeToolName("create_cards"), "create_cards");
  assert.equal(safeToolName("SECRET-な名前"), "(未登録のツール)");
  assert.equal(safeToolName(undefined), "(未登録のツール)");
  assert.ok(MCP_TOOL_NAMES.length >= 8, "許可リストが空同然になっている");
});

// ---- 形の読み取り ----

test("配列は件数と、要素に現れたキーを出す", () => {
  assert.equal(argShape({ ids: [1, 2, 3] }), "ids[3]");
  assert.equal(argShape({ cards: [{ title: "a" }], sync_token: "x" }), "cards[1]{title} sync_token");
});

// **1件目だけ見ると足された項目を見落とす。**「どの項目が使われているか」を数えるのが目的なので、
// 2件目で初めて出てきたキーが落ちると、その項目は永久に「使われていない」に見える
test("2件目で足されたキーも拾う (要素キーの和を取る)", () => {
  const line = argShape({ updates: [{ id: 1 }, { id: 2, due: "2026-09-01" }] });
  assert.match(line, /updates\[2\]/);
  assert.ok(line.includes("due"), `2件目のキーが落ちている: ${line}`);
});

test("空・非オブジェクトでも落ちない", () => {
  assert.equal(argShape({}), "");
  assert.equal(argShape(undefined), "");
  assert.equal(argShape("文字列"), "");
  assert.equal(argShape([1, 2]), "");
});

test("行が長くなりすぎない", () => {
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, 1]));
  assert.ok(argShape(many).length <= 201, "行が打ち切られていない");
});

// ---- 結果の読み取り ----

const res = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }] });

test("ok:false は理由の先頭ごと残す (失敗が溜まる場所になる)", () => {
  const out = toolOutcome(res({ ok: false, note: "経緯メモの更新には context_version が必要です" }));
  assert.match(out, /^NG /);
  assert.match(out, /context_version/);
});

test("理由が無いときも NG と分かる", () => {
  assert.equal(toolOutcome(res({ ok: false })), "NG (理由なし)");
});

test("断りの理由にも制御文字と長さの制限が効く", () => {
  assert.ok(!toolOutcome(res({ ok: false, note: "a\nb" })).includes("\n"), "改行が残っている");
  assert.ok(toolOutcome(res({ ok: false, note: "あ".repeat(500) })).length < 80);
});

test("通ったものは ok", () => {
  assert.equal(toolOutcome(res({ ok: true, created: [{ id: 1 }] })), "ok");
  assert.equal(toolOutcome(res({ cards: [] })), "ok", "ok を持たない応答 (sync_board) が NG になっている");
});

test("JSONでない応答や形の違う応答でも落ちない", () => {
  assert.equal(toolOutcome({ content: [{ type: "text", text: "使い方の説明文" }] }), "ok");
  assert.equal(toolOutcome({ content: [] }), "ok");
  assert.equal(toolOutcome(undefined), "ok");
});

// ---- JSON-RPC の取り出し (バッチ) ----

const c = (id: number, name: string, args: unknown = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

test("単発の tools/call を拾う", () => {
  assert.deepEqual(toolCalls(c(1, "sync_board")), [{ id: 1, name: "sync_board", args: {} }]);
});

// **body.method だけを見ていると配列では常に undefined になる** — これが穴だった
test("配列 (バッチ) でも全部拾う", () => {
  const got = toolCalls([c(1, "sync_board"), c(2, "query_log")]);
  assert.deepEqual(
    got.map((g) => g.name),
    ["sync_board", "query_log"]
  );
});

test("tools/call 以外は拾わない", () => {
  assert.deepEqual(toolCalls([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]), []);
  assert.deepEqual(toolCalls(undefined), []);
  assert.deepEqual(toolCalls({ method: "tools/call" }), [{ id: undefined, name: "(未登録のツール)", args: undefined }]);
});

test("未登録のツール名はここでも平文にしない", () => {
  assert.equal(toolCalls(c(1, "SECRET-な名前"))[0].name, "(未登録のツール)");
});

/** #252: **許可した項目だけ、値を平文で出す。**
 *
 * `query_log` の説明はチャットのツール定義の35%を占める (3482/9924字) のに、
 * 呼ばれるのは `update_cards` の3分の1。削る候補は例文11本 (1122字) だが、
 * `argShape` は `sql` というキー名しか出さないので、**どの例文が真似されているか数えられない**。 */
test("query_log は SQL そのものを残す (どの例文が真似されているか数えるため)", () => {
  assert.equal(
    argDetail("query_log", { sql: "SELECT id, title FROM live_cards" }),
    "sql=SELECT id, title FROM live_cards"
  );
});

test("許可していないツール・項目の値は出さない", () => {
  // **経緯メモが丸ごとディスクに残る形にしない** (#224 と同じ形になる)
  assert.equal(argDetail("update_cards", { updates: [{ id: 1, context: "秘密の経緯" }] }), "");
  assert.equal(argDetail("create_cards", { cards: [{ title: "秘密の題名" }] }), "");
  // 未登録のツール名を名乗って許可リストをすり抜けられない
  assert.equal(argDetail("query_log ", { sql: "SELECT 1" }), "");
  assert.equal(argDetail("(未登録のツール)", { sql: "SELECT 1" }), "");
});

test("SQL に改行を混ぜても、ログの行を増やせない", () => {
  // **これが本体。**#247 で「キー名をそのまま出す」を潰したのと同じ攻撃。
  // 行数で集計するので、1回の呼び出しで複数行を作れると数字ごと偽装できる
  const forged = "SELECT 1\n[2099-01-01 00:00:00] [mcp] query_log ok | sql | 1ms";
  const out = argDetail("query_log", { sql: forged });
  assert.ok(!out.includes("\n"), `改行が残っている: ${JSON.stringify(out)}`);
  assert.ok(!out.includes("\r"), "復帰が残っている");
});

test("長いSQLは切り詰める (1回の呼び出しでログを埋められない)", () => {
  // **許可された語だけで長くする。**未知の語は `?` に潰れて短くなるので、
  // それでは切り詰めを試したことにならない (最初はそれで書いてしまい、通ってしまった)
  const out = argDetail("query_log", { sql: "SELECT " + Array(500).fill("id, title").join(", ") + " FROM cards" });
  assert.ok(out.length < 400, `切り詰めていない (${out.length}字)`);
  assert.ok(out.endsWith("…"), "切り詰めた印が無い");
});

test("sql が文字列でなければ何も出さない (スキーマで弾かれた呼び出しでも壊れない)", () => {
  assert.equal(argDetail("query_log", {}), "");
  assert.equal(argDetail("query_log", { sql: 123 }), "");
  assert.equal(argDetail("query_log", null), "");
  assert.equal(argDetail("query_log", undefined), "");
});

// #252: **断り方の欄が1つではない。**`query_log` だけは `{ ok:false, error }` を返すので、
// `note` しか見ていないと、**一番中身を知りたいツールの失敗理由だけが消える**
test("query_log の断り (error 欄) も記録される", () => {
  const wrap = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
  assert.equal(toolOutcome(wrap({ ok: false, error: "no such table: secrets" })), "NG 引けないテーブル");
  // note があるほうを優先する (こちらが書いた案内文のほうが読みやすい)
  assert.equal(toolOutcome(wrap({ ok: false, note: "版が合わない", error: "raw" })), "NG 版が合わない");
  // **SQLiteの例外文は入力をそのまま載せる。**分類に畳んで、断片を残さない
  assert.equal(toolOutcome(wrap({ ok: false, error: "unrecognized token near SECRET-顧客名" })), "NG SQLの文法");
  assert.equal(toolOutcome(wrap({ ok: false })), "NG (理由なし)");
});

/** #252: **SQLの中身は残さない。**
 *
 * 最初は「readonly + テーブルの許可リスト (#168) を通った後だから安全」と書いたが、
 * 理由が2つとも成り立っていなかった (Codexレビュー P2):
 * 記録は `finally` から出るので**弾かれたSQLも残る**し、引ける先を絞ることと
 * **文面を残してよいこと**は別の境界。リテラルは読み出す値と無関係に何でも書ける。 */
test("SQLの文字列リテラルは中身を落とす (形だけ残す)", () => {
  assert.equal(
    redactSql("SELECT id FROM live_cards WHERE title LIKE '%顧客A-未公開買収計画%'"),
    "SELECT id FROM live_cards WHERE title LIKE '…'"
  );
  // 測りたい「どの例文を真似したか」は、落としても分かる
  assert.equal(
    redactSql("SELECT done_day, COUNT(*) n FROM done_cards GROUP BY 1 ORDER BY 1 DESC"),
    "SELECT done_day, COUNT(*) n FROM done_cards GROUP BY ? ORDER BY ? DESC"
  );
});

test("引用符の書き方が変わっても落とせる", () => {
  // '' は中身側のエスケープなので、ここで閉じたと勘違いしない
  // t / u は表にも列にも無い語なので ? になる (許可した語しか出さない)
  assert.equal(redactSql("SELECT 1 WHERE t = 'it''s 秘密' AND u = 'もう1つ'"), "SELECT ? WHERE ? = '…' AND ? = '…'");
  // SQLite は " ` [ ] も引用に使う
  assert.equal(redactSql('SELECT "秘密" FROM cards'), 'SELECT "…" FROM cards');
  assert.equal(redactSql("SELECT `秘密` FROM cards"), "SELECT `…` FROM cards");
  assert.equal(redactSql("SELECT [秘密] FROM cards"), "SELECT […] FROM cards");
});

// **これが一番まずい形。**閉じていない引用符は構文エラーのSQLで普通に起きるので、
// ここを取りこぼすと「壊れた入力のときだけ本文が残る」ことになる
test("閉じていない引用符でも、末尾まで落とす", () => {
  assert.equal(redactSql("SELECT * FROM cards WHERE t='閉じていない秘密"), "SELECT * FROM cards WHERE ?='…");
  assert.ok(!redactSql("SELECT '秘密").includes("秘密"));
});

test("コメントも落とす (メモを書き込まれても残さない)", () => {
  assert.ok(!redactSql("SELECT 1 -- 秘密のメモ").includes("秘密"));
  assert.ok(!redactSql("SELECT /* 秘密 */ 1").includes("秘密"));
  // 閉じていないブロックコメントも末尾まで
  assert.ok(!redactSql("SELECT /* 秘密").includes("秘密"));
  // 行コメントは改行までで終わり、その後のSQLは残る (形を測りたいので)
  assert.match(redactSql("SELECT 1 -- メモ\nFROM done_cards"), /FROM done_cards/);
});

test("失敗の理由は、こちらが決めた語に畳む", () => {
  assert.equal(classifyQueryError("no such table: secrets"), "引けないテーブル");
  assert.equal(classifyQueryError("no such column: foo"), "無い列");
  assert.equal(classifyQueryError("attempt to write a readonly database"), "書き込もうとした");
  assert.equal(classifyQueryError('near "FRM": syntax error'), "SQLの文法");
  // **入力の断片を載せる例外文でも、こちらの語しか出さない**
  assert.equal(classifyQueryError("unrecognized token near SECRET-顧客名"), "SQLの文法");
  assert.equal(classifyQueryError("何か知らない失敗"), "その他");
  assert.equal(classifyQueryError(undefined), "(理由なし)");
});

test("argDetail はリテラルを落としたSQLを返す", () => {
  assert.equal(
    argDetail("query_log", { sql: "SELECT id FROM live_cards WHERE title LIKE '%SECRET%'" }),
    "sql=SELECT id FROM live_cards WHERE title LIKE '…'"
  );
});

// #252 (Codexレビュー P2 の実測で気づいた): **引用符の中だけ落としても足りない。**
// 壊れたSQLでは、利用者の言葉が引用符なしのトークンとしてそのまま現れる
test("引用符なしのトークンも、許可した語でなければ落とす", () => {
  const out = redactSql("SELECT * FROM cards WHERE t = SECRET-未公開の案件名");
  assert.ok(!out.includes("SECRET"), `落ちていない: ${out}`);
  assert.ok(!out.includes("未公開"), `落ちていない: ${out}`);
  // 表の名前とSQLの語彙は残る
  assert.match(out, /SELECT \* FROM cards WHERE/);
});

// **これが無いと変更の意味が消える。**契約の説明に載っている例文が、
// 落とした後も「どれを真似したか」分かる形で残ること
test("契約の例文は、落とした後も見分けが付く", () => {
  // **リテラル (文字列も数値も) は `?` になるが、表・列・関数・句は残る。**
  // 「どの例文を真似したか」はその組み合わせで十分に分かる
  const examples: Array<[string, string]> = [
    [
      "SELECT done_day, COUNT(*) n FROM done_cards GROUP BY 1 ORDER BY 1 DESC",
      "SELECT done_day, COUNT(*) n FROM done_cards GROUP BY ? ORDER BY ? DESC",
    ],
    [
      "SELECT id, status, title, due, checked_at, length(context) ctx FROM live_cards",
      "SELECT id, status, title, due, checked_at, length(context) ctx FROM live_cards",
    ],
    [
      "SELECT title, status, summary, context, context_version, blocked_by FROM cards WHERE id=112",
      "SELECT title, status, summary, context, context_version, blocked_by FROM cards WHERE id=?",
    ],
    [
      "SELECT substr(created_at,1,13) h, COUNT(*) n FROM chat_messages GROUP BY 1 ORDER BY 1",
      "SELECT substr(created_at,?,?) h, COUNT(*) n FROM chat_messages GROUP BY ? ORDER BY ?",
    ],
  ];
  for (const [sql, want] of examples) assert.equal(redactSql(sql), want);

  // **どの2本も、落とした後で同じ形にならない** (同じなら数えても区別が付かない)
  const shapes = examples.map(([, want]) => want);
  assert.equal(new Set(shapes).size, shapes.length, "落とした結果が別の例文と衝突している");
  // リテラルを含む例文も、表・列・関数は残るので見分けが付く
  assert.equal(
    redactSql("SELECT done_day, title FROM done_cards WHERE done_day >= date('now','localtime','-7 days')"),
    "SELECT done_day, title FROM done_cards WHERE done_day >= date('…','…','…')"
  );
});

// #252 (Codexレビュー P2): **数値を残すと、そこから抜けられた。**
// 最初は「`WHERE id=112` の形が見たい」として数字をそのまま出していたが、
// カード番号と電話番号・口座番号・顧客番号は**見分けが付かない**
test("数値リテラルも落とす (カード番号と口座番号は見分けが付かない)", () => {
  for (const [sql, leak] of [
    ["SELECT 4111111111111111 FROM cards", "4111111111111111"],
    ["SELECT * FROM cards WHERE id=090-1234-5678", "090"],
    ["SELECT * FROM cards WHERE id=123.456", "123"],
    ["SELECT * FROM cards WHERE id=-42", "42"],
  ] as const) {
    const out = redactSql(sql);
    assert.ok(!out.includes(leak), `数値が残っている: ${sql} → ${out}`);
  }
  // 桁数からも復元できないこと (`?` は1個にまとまる)
  assert.equal(redactSql("SELECT 4111111111111111 FROM cards"), "SELECT ? FROM cards");
});

// ---- 例外で終わったとき (#254) ----

// **本文は出さない。**例外文は入力値を含みうる (SQLiteのエラーはSQLをそのまま載せる)。
// チャットとMCPの両方がこの1本を使うので、ここが規則そのもの
test("例外は種類だけ残す (本文は出さない)", () => {
  class SqliteError extends Error {}
  const e = new SqliteError("unrecognized token near SECRET-未公開の案件名");
  e.name = "SqliteError";

  const out = throwOutcome(e);
  assert.equal(out, "throw SqliteError");
  assert.ok(!out.includes("SECRET"), `例外文が残っている: ${out}`);
});

test("Error でないものを投げられても、平文にしない", () => {
  assert.equal(throwOutcome("SECRET-文字列を投げた"), "throw 不明");
  assert.equal(throwOutcome({ message: "SECRET-オブジェクトを投げた" }), "throw 不明");
  assert.equal(throwOutcome(undefined), "throw 不明");
});

// ---- 失敗したときだけ出す欄 (#256) ----

test("goal は failed のときだけ出る", () => {
  const args = { sql: "SELECT id FROM cards", goal: "何が知りたかったか" };
  assert.ok(!argDetail("query_log", args).includes("goal"), "成功時に出ている");
  assert.match(argDetail("query_log", args, true), /goal=何が知りたかったか/);
});

// **既定は false。**outcome を知らない呼び出し側が足しても、漏れる方には倒れない
test("failed を渡さなければ出さない (既定は安全側)", () => {
  assert.ok(!argDetail("query_log", { sql: "SELECT 1", goal: "SECRET" }).includes("SECRET"));
});

test("goal は長さを切る (自由文は潰せないので短くする)", () => {
  const out = argDetail("query_log", { sql: "SELECT 1", goal: "あ".repeat(500) }, true);
  assert.ok(out.length < 200, `切れていない: ${out.length}字`);
});

test("他のツールの goal は出ない (例外が広がっていない)", () => {
  assert.equal(argDetail("create_cards", { goal: "SECRET-目的" }, true), "");
});

test("ok 以外はすべて失敗として扱う (断りも例外も届かなかったことに変わりはない)", () => {
  assert.equal(isFailure("ok"), false);
  assert.equal(isFailure("NG 版が合わない"), true);
  assert.equal(isFailure("throw SqliteError"), true);
});
