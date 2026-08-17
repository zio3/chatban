import assert from "node:assert/strict";
import test from "node:test";
import { diffBoards, type TaskFacts } from "./boardState.js";

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

test("並べ替えは1行にまとめる (1件動かすと周りの sort も連動するため)", () => {
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
  assert.match(changes[0], /並び順が変わった \(#1, #2, #3\)/);
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
