import assert from "node:assert/strict";
import test from "node:test";
import { diffBoards, formatBoardUpdate, type TaskFacts } from "./boardState.js";

/** #150: ボード状況の差分。
 *
 * ここが壊れると、エージェントは「自分が最後に読んだ一覧」を現在だと思い込んだままになる
 * (2026-08-15 に実際に起きた誤報告: 人間が9件を検収して消えていたのに、ビューのバグだと報告した)。
 * 差分計算は純粋関数にしてあるので、DBもMCPサーバーも要らずに確かめられる */

function task(over: Partial<TaskFacts> = {}): TaskFacts {
  return {
    title: "既定のタイトル",
    status: "todo",
    assignee: null,
    summary: null,
    due: null,
    blockedBy: null,
    rejected: false,
    contextVersion: 1,
    checkedAt: null,
    sort: 0,
    ...over,
  };
}

/** 本番の cardIndex と同じ表現。区切り文字での連結にすると要素の中身と衝突する */
function card(title: string, elements: string[]): string {
  return JSON.stringify([title, elements]);
}

function board(tasks: [number, TaskFacts][] = [], cards: [number, string][] = [], projectContext = "") {
  return { tasks: new Map(tasks), cards: new Map(cards), projectContext };
}

test("何も変わっていなければ差分は空", () => {
  const b = board([[4, task()]]);
  assert.deepEqual(diffBoards(b, b), []);
});

test("状態の変化は「どこからどこへ」が1行で分かる", () => {
  const before = board([[4, task({ title: "認証を廃止する" })]]);
  const after = board([[4, task({ title: "認証を廃止する", status: "inprogress" })]]);

  const changes = diffBoards(before, after);
  assert.equal(changes.length, 1);
  assert.match(changes[0], /#4/);
  assert.match(changes[0], /status: todo -> inprogress/);
  // **行だけ見て現在が確定すること。**LLMのコンテキストは追記型なので、
  // IDしか書いていない差分だと古い一覧を見返してマージする羽目になる
  assert.match(changes[0], /認証を廃止する/);
});

test("追加は内容ごと載せる (IDだけでは何か分からないため)", () => {
  const changes = diffBoards(board(), board([[12, task({ title: "新しい仕事", due: "2026-08-20" })]]));
  assert.equal(changes.length, 1);
  assert.match(changes[0], /^\+ #12/);
  assert.match(changes[0], /新しい仕事/);
  assert.match(changes[0], /2026-08-20/);
});

test("消滅を拾える (タイムスタンプ方式では絶対に拾えないケース)", () => {
  // 要約カードに畳まれて消えたタスクは updated_at で絞っても出てこない。
  // Done要約が主戦場になる以上ここは頻発するので、スナップショット比較を選んでいる
  const changes = diffBoards(board([[6, task({ title: "終わった仕事" })]]), board());
  assert.equal(changes.length, 1);
  assert.match(changes[0], /^- #6/);
  assert.match(changes[0], /終わった仕事/);
});

test("変わったフィールドだけを並べる (変わっていないものは書かない)", () => {
  const before = board([[7, task({ title: "T", status: "todo", summary: "前の現況", due: "2026-08-18" })]]);
  const after = board([[7, task({ title: "T", status: "review", summary: "前の現況", due: "2026-08-19" })]]);

  const changes = diffBoards(before, after);
  assert.equal(changes.length, 1);
  assert.match(changes[0], /status: todo -> review/);
  assert.match(changes[0], /期限: 2026-08-18 -> 2026-08-19/);
  assert.ok(!changes[0].includes("現況"), "変わっていない summary は出さない");
});

test("却下と却下の取り消しを区別する", () => {
  const plain = board([[9, task()]]);
  const rejected = board([[9, task({ rejected: true })]]);

  assert.match(diffBoards(plain, rejected)[0], /却下された/);
  assert.match(diffBoards(rejected, plain)[0], /却下を取り消した/);
});

test("経緯メモは版だけ伝える (本文を載せると差分が膨らむ)", () => {
  const changes = diffBoards(board([[3, task()]]), board([[3, task({ contextVersion: 2 })]]));
  assert.equal(changes.length, 1);
  assert.match(changes[0], /経緯メモが更新された \(v2\)/);
});

test("依存は中身で比べる (null と空配列は同じ扱い)", () => {
  assert.deepEqual(diffBoards(board([[1, task({ blockedBy: null })]]), board([[1, task({ blockedBy: [] })]])), []);
  assert.deepEqual(diffBoards(board([[1, task({ blockedBy: [2, 3] })]]), board([[1, task({ blockedBy: [2, 3] })]])), []);

  const changed = diffBoards(board([[1, task({ blockedBy: [2] })]]), board([[1, task({ blockedBy: null })]]));
  assert.equal(changed.length, 1);
  assert.match(changed[0], /依存: \[2\] -> \[\]/);
});

test("担当者の変更を拾う", () => {
  const changes = diffBoards(board([[8, task()]]), board([[8, task({ assignee: "zio" })]]));
  assert.equal(changes.length, 1);
  assert.match(changes[0], /担当: なし -> zio/);
});

test("並べ替えは1行にまとめ、その1行から現在の順を復元できる", () => {
  const before = board([
    [1, task({ sort: 0 })],
    [2, task({ sort: 1 })],
    [3, task({ sort: 2 })],
  ]);
  const after = board([
    [1, task({ sort: 1 })],
    [2, task({ sort: 2 })],
    [3, task({ sort: 0 })],
  ]);

  const changes = diffBoards(before, after);
  assert.equal(changes.length, 1, "3件動いても1行にまとまる");
  // **IDの集合だけでは足りない。**どう並んだかが読み取れること
  assert.match(changes[0], /todo: #3,#1,#2/);
});

test("入れ替われば現在の並びを出す", () => {
  const before = board([
    [1, task({ sort: 0 })],
    [2, task({ sort: 1 })],
  ]);
  const swapped = board([
    [1, task({ sort: 1 })],
    [2, task({ sort: 0 })],
  ]);

  assert.match(diffBoards(before, swapped)[0], /todo: #2,#1/);
});

test("sort の数値だけ振り直され、並びが同じなら何も言わない", () => {
  // 0,1 -> 5,9 は数値が変わっても見た目の順は #1,#2 のまま。
  // sort の数値差で判定すると、ここで「並び順が変わった」と嘘をつく (自動レビュー指摘)
  const before = board([
    [1, task({ sort: 0 })],
    [2, task({ sort: 1 })],
  ]);
  const renumbered = board([
    [1, task({ sort: 5 })],
    [2, task({ sort: 9 })],
  ]);

  assert.deepEqual(diffBoards(before, renumbered), []);
});

test("列を移っても sort の数値が変わらないケースを拾う", () => {
  // UIは移動先の先頭要素の sort-1 を振るので、先頭が 0 の列の先頭へ入れると sort は 0 のまま。
  // 数値を比べていると status の行しか出ず、移動先の現在順を返せなかった (自動レビュー指摘)
  const before = board([
    [1, task({ status: "todo", sort: 0 })],
    [2, task({ status: "review", sort: 1 })],
    [3, task({ status: "review", sort: 2 })],
  ]);
  const after = board([
    [1, task({ status: "review", sort: 0 })],
    [2, task({ status: "review", sort: 1 })],
    [3, task({ status: "review", sort: 2 })],
  ]);

  const changes = diffBoards(before, after);
  assert.ok(
    changes.some((c) => c.includes("status: todo -> review")),
    "列の移動そのものは出る"
  );
  const order = changes.find((c) => c.startsWith("並び順"));
  assert.ok(order, "移動先の現在順も出る");
  assert.match(order!, /review: #1,#2,#3/);
});

test("ゴミ箱からの復元は、列の途中に戻っても位置が分かる", () => {
  // restoreTask は sort を保ったまま戻すので、列の真ん中に現れることがある。
  // 復元は「追加」なので並び順の判定 (居続けたIDの比較) には入らず、
  // 追加行に位置を書かないとエージェントには順序が分からない (自動レビュー指摘)
  const before = board([
    [10, task({ sort: 0 })],
    [20, task({ sort: 10 })],
  ]);
  const after = board([
    [10, task({ sort: 0 })],
    [5, task({ sort: 5, title: "戻ってきた仕事" })],
    [20, task({ sort: 10 })],
  ]);

  const added = diffBoards(before, after).find((c) => c.startsWith("+"));
  assert.ok(added);
  assert.match(added!, /todo の #10 と #20 の間/);
});

test("列の先頭・末尾に入ったときも位置が分かる", () => {
  const base = board([
    [10, task({ sort: 0 })],
    [20, task({ sort: 10 })],
  ]);

  const atHead = diffBoards(base, board([
    [1, task({ sort: -5 })],
    [10, task({ sort: 0 })],
    [20, task({ sort: 10 })],
  ])).find((c) => c.startsWith("+"));
  assert.match(atHead!, /todo の先頭 \(次が #10\)/);

  const atTail = diffBoards(base, board([
    [10, task({ sort: 0 })],
    [20, task({ sort: 10 })],
    [30, task({ sort: 99 })],
  ])).find((c) => c.startsWith("+"));
  assert.match(atTail!, /todo の末尾 \(前が #20\)/);
});

test("ゴミ箱からの復元は、追加行に検収済みが載る", () => {
  // restoreTask は checked_at を保ったまま戻すので、「追加」として現れる。
  // 追加行は fieldChanges を通らないため、ここに書かないと検収状態が抜け落ちる (自動レビュー指摘)
  const changes = diffBoards(
    board(),
    board([[5, task({ status: "review", title: "戻ってきた仕事", checkedAt: "2026-08-17 10:00:00" })]])
  );

  const added = changes.find((c) => c.startsWith("+"));
  assert.ok(added);
  assert.match(added!, /検収済み/);
});

test("通常の新規追加には検収済みが付かない", () => {
  const changes = diffBoards(board(), board([[6, task({ title: "新しい仕事" })]]));
  assert.ok(!changes[0].includes("検収済み"));
});

test("列をまたいで動いたら、入った先の並びを出す (抜けたほうは出さない)", () => {
  const before = board([
    [1, task({ status: "todo", sort: 0 })],
    [2, task({ status: "todo", sort: 1 })],
    [3, task({ status: "review", sort: 0 })],
  ]);
  const after = board([
    [1, task({ status: "review", sort: 1 })],
    [2, task({ status: "todo", sort: 1 })],
    [3, task({ status: "review", sort: 0 })],
  ]);

  const line = diffBoards(before, after).find((c) => c.startsWith("並び順"));
  assert.ok(line, "入った先の並びは出る");
  assert.match(line!, /review: #3,#1/);
  // 抜けたほうは「#1 が review へ移った」で足りる。残りの並びまで出すとノイズになる
  assert.ok(!line!.includes("todo:"));
});

test("人の検収の印を拾う (setChecked は updated_at を動かさないので差分でしか気づけない)", () => {
  const before = board([[5, task({ status: "review" })]]);
  const after = board([[5, task({ status: "review", checkedAt: "2026-08-17 10:00:00" })]]);

  const changes = diffBoards(before, after);
  assert.equal(changes.length, 1);
  assert.match(changes[0], /人が検収の印を付けた/);
  assert.match(changes[0], /2026-08-17 10:00:00/);

  // 外れたときも拾う (ゴミ箱からの復元で印が残る問題 #161 と関係する)
  assert.match(diffBoards(after, before)[0], /検収の印が外れた/);
});

test("並べ替えが status の変化を埋もれさせない", () => {
  const before = board([
    [1, task({ title: "動く", sort: 0 })],
    [2, task({ title: "並ぶ", sort: 1 })],
  ]);
  const after = board([
    [1, task({ title: "動く", status: "review", sort: 1 })],
    [2, task({ title: "並ぶ", sort: 0 })],
  ]);

  const changes = diffBoards(before, after);
  assert.ok(
    changes.some((c) => c.includes("status: todo -> review")),
    "並び順の行に混ぜず、状態の変化は独立した行で出す"
  );
});

test("要約カードの追加・更新・消滅を拾う", () => {
  const none = board();
  const one = board([], [[5, card("8月の完了", ["認証を消した", "計測を消した"])]]);
  const edited = board([], [[5, card("8月の完了", ["認証を消した", "計測を消した", "MCPを直した"])]]);

  assert.match(diffBoards(none, one)[0], /\+ 要約カード#5/);
  assert.match(diffBoards(one, edited)[0], /~ 要約カード#5/);
  assert.match(diffBoards(one, none)[0], /- 要約カード#5 が統合され消滅した/);
  // 索引はJSONでも、人が読む文面は連結した見た目に戻す
  assert.match(diffBoards(none, one)[0], /8月の完了 :: 認証を消した \/ 計測を消した/);
});

test("要約カードの要素に区切り文字が入っていても別物と判定する", () => {
  // 連結方式だと ['B / C'] と ['B', 'C'] が同じ索引になり、カードの分割・編集を見逃した
  const joined = board([], [[5, card("T", ["B / C"])]]);
  const split = board([], [[5, card("T", ["B", "C"])]]);

  const changes = diffBoards(joined, split);
  assert.equal(changes.length, 1, "要素の切れ目が変わったことを検出する");
  assert.match(changes[0], /~ 要約カード#5/);
});

test("前提情報の更新は本文を載せずに知らせる", () => {
  const changes = diffBoards(board([], [], "むかしの前提"), board([], [], "いまの前提"));
  assert.deepEqual(changes, ["プロジェクトの前提情報が更新された"]);
});

test("複数の変化がまとめて返る", () => {
  const before = board([
    [1, task({ title: "残るもの" })],
    [2, task({ title: "動くもの" })],
    [3, task({ title: "消えるもの" })],
  ]);
  const after = board([
    [1, task({ title: "残るもの" })],
    [2, task({ title: "動くもの", status: "review" })],
    [4, task({ title: "増えたもの" })],
  ]);

  const changes = diffBoards(before, after);
  assert.equal(changes.length, 3);
  assert.equal(changes.filter((c) => c.startsWith("~")).length, 1);
  assert.equal(changes.filter((c) => c.startsWith("+")).length, 1);
  assert.equal(changes.filter((c) => c.startsWith("-")).length, 1);
});

/** 書き込み応答に混ぜるボード部分。**キーの取り違えはここでしか捕まらない** —
 * 実際、boardNote を note という名前で返していたときは、書き込み側の警告
 * (「#9999 は存在しません。古い一覧を見ている可能性があります」) を spread で消していた。
 * diffBoards のテストでは検出できず、実機で気づいた */

test("差分が返せたときは状況IDと変化を返す", () => {
  const r = formatBoardUpdate({ stateId: "p1-run-2", since: "p1-run-1", changes: ["~ #4 status: todo -> review"] }, "p1-run-1");
  assert.equal(r.stateId, "p1-run-2");
  assert.deepEqual(r.changesSince, ["~ #4 status: todo -> review"]);
  assert.ok(!("note" in r), "書き込み側の警告と同じキーを使わない");
  assert.ok(!("boardNote" in r));
});

test("変化が無ければ changesSince を付けない (空配列を読ませない)", () => {
  const r = formatBoardUpdate({ stateId: "p1-run-2", since: "p1-run-1", changes: [] }, "p1-run-1");
  assert.equal(r.stateId, "p1-run-2");
  assert.ok(!("changesSince" in r));
});

test("since を渡していなければ、次回のための状況IDだけ返す", () => {
  const r = formatBoardUpdate({ stateId: "p1-run-1", full: true });
  assert.deepEqual(r, { stateId: "p1-run-1" });
});

test("差分を返せなかったときは状況IDを返さず、note とも衝突しない", () => {
  const r = formatBoardUpdate({ stateId: "p1-run-9", full: true, note: "状況IDが失効していた" }, "p1-dead-1");

  // 返すとエージェントが次の since に使い、空差分が返って全件を見ないまま進む
  assert.ok(!("stateId" in r), "新しい状況IDを渡さない");
  // 書き込み側の警告 (note) を潰さないよう、別のキーに入れる
  assert.ok(!("note" in r));
  assert.match(String(r.boardNote), /状況IDが失効していた/);
  assert.match(String(r.boardNote), /since を付けずに get_board/);
});

test("書き込み側の警告と同時に返しても、どちらも消えない", () => {
  // 実際の応答は { ...書き込み結果, ...boardUpdate() } の順で spread される
  const writeResult = { ok: false, note: "#9999 は存在しません (古い一覧を見ている可能性があります)" };
  const merged: Record<string, unknown> = {
    ...writeResult,
    ...formatBoardUpdate({ stateId: "p1-run-9", full: true, note: "失効" }, "p1-dead-1"),
  };

  assert.match(String(merged.note), /#9999 は存在しません/);
  assert.match(String(merged.boardNote), /失効/);
});
