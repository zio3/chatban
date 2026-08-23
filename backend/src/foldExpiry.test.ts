import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #236: **箱の寿命 (24時間) の境目を、時計に依存せず固定する。**
 *
 * `fresh` は「**純粋関数**にしてあるのが要点」と書いてありながら、中で `Date.now()` を
 * 読んでいた (Codexが PR #94 の横断確認で発見)。#94 の `suggestSkipReason` と同じ形 —
 * **「純粋だからDBもexpressも要らない」と書いてある関数が、実は外を読んでいる。**
 *
 * この形は静かに壊れる。#94 は「テストが2本落ちる」という形で見えていたが、
 * こちらは**通ってしまう**。既存の `foldDone.test.ts` は
 * 「畳んだ時刻を25時間前にする (時計を進める代わり)」と書いて回り込んでおり、
 * **境目そのもの (ちょうど24時間、その前後1ミリ秒) は一度も確かめていなかった。**
 *
 * 時計を引数に出したので、ここは**その日いつ走らせても同じ結果**になる。
 *
 * (`archive.ts` は db.js 経由で管理DBを開くため、読み込む前にデータディレクトリを
 * 一時領域へ向ける。判定そのものはDBを1行も引かない) */

// **実データに触らせない** (foldDone.test.ts と同じ作法)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-expirytest-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0";

const { fresh } = await import("./archive.js");

const HOUR = 3600_000;
/** 基準の「いま」。**実時刻を使わない** — 使うと、その日いつ走らせるかで結果が変わりうる */
const NOW = 1_700_000_000_000;
const box = (...ages: number[]) => ages.map((h, i) => ({ id: i + 1, title: `#${i + 1}`, foldedAt: NOW - h * HOUR }));

test("24時間より新しいものは残る", () => {
  assert.deepEqual(
    fresh(box(0, 1, 23), NOW).map((t) => t.id),
    [1, 2, 3]
  );
});

test("24時間より古いものは落ちる", () => {
  assert.deepEqual(
    fresh(box(25, 48), NOW).map((t) => t.id),
    []
  );
});

// **境目は「より新しい」= 24時間ちょうどは落ちる。**`>` か `>=` かで1件ぶんずれるので、
// どちらのつもりで書いたかをここで固定する
test("境目: ちょうど24時間は落ち、1ミリ秒でも新しければ残る", () => {
  const ちょうど = { id: 1, title: "ちょうど24時間", foldedAt: NOW - 24 * HOUR };
  const わずかに新しい = { id: 2, title: "1ミリ秒だけ新しい", foldedAt: NOW - 24 * HOUR + 1 };
  const わずかに古い = { id: 3, title: "1ミリ秒だけ古い", foldedAt: NOW - 24 * HOUR - 1 };

  assert.deepEqual(
    fresh([ちょうど, わずかに新しい, わずかに古い], NOW).map((t) => t.id),
    [2]
  );
});

test("空・未定義でも落ちない (箱がまだ無いプロジェクト)", () => {
  assert.deepEqual(fresh(undefined, NOW), []);
  assert.deepEqual(fresh([], NOW), []);
});

// **時計を渡すのを忘れたら、そもそも呼べない。**#94 と同じく既定値を持たせていないので、
// 「渡し忘れて隠れた依存が黙って復活する」が起きない。型で止まることをここに書いておく
test("いまの時刻は呼び出し側が渡す (既定値を持たない)", () => {
  assert.equal(fresh.length, 2, "引数が2つでなくなっている = 時計を内側に戻した可能性がある");
});

// **順番も中身も変えない。**箱は畳んだ順に並んでおり、画面はその順で出す
test("残ったものの順番は変わらない", () => {
  const items = box(23, 1, 12);
  assert.deepEqual(
    fresh(items, NOW).map((t) => t.title),
    items.map((t) => t.title)
  );
});
