import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #199: 起動世代の採番。store.ts はモジュールを読んだ時点で管理DBを開くので、
// 先に CHATBAN_DATA_DIR を捨て場所へ向けてから読み込む (実データを触らない)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-bootgen-"));
process.env.CHATBAN_DATA_DIR = dir;
const { admin, nextBootGeneration } = await import("./store.js");

const setRaw = (value: string) =>
  admin
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('boot.generation', ?, datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(value);
const raw = () =>
  (admin.prepare("SELECT value FROM settings WHERE key = 'boot.generation'").get() as { value: string }).value;

test("呼ぶたびに増える。連続で呼んでも同じ番号を返さない", () => {
  setRaw("7");
  assert.equal(nextBootGeneration(), 8);
  assert.equal(nextBootGeneration(), 9);
  assert.equal(raw(), "9", "DBにも残る (再起動をまたいで単調増加する)");
});

test("行が無ければ現在時刻(ミリ秒)から始める (1から始めない)", () => {
  // 「新規DB」と「壊れたので消した」は区別できない。1から始めると後者で過去世代より
  // 小さくなり、旧プロセスの応答を新しいと誤採用する。安全な側に揃える
  admin.prepare("DELETE FROM settings WHERE key = 'boot.generation'").run();
  const n = nextBootGeneration();
  assert.ok(n > 1_000_000_000_000, `エポックミリ秒相当のはず: ${n}`);
});

test("現在時刻へ逃げた値は、次の起動でそのまま+1される (逃げ続けない)", () => {
  // ここが今回の穴だった。数値で束縛すると better-sqlite3 が REAL として渡し、
  // CAST(... AS TEXT) が "1787019867.0" になる。すると次の起動で数字列判定に落ちて
  // また現在時刻へ逃げ、**同じミリ秒内の起動が同じ世代を名乗る**。
  // 保存された値が桁だけの文字列であること、次が厳密に+1であることの両方を見る
  setRaw("こわれた値");
  const escaped = nextBootGeneration();
  assert.match(raw(), /^[0-9]+$/, `桁だけの文字列で保存されているはず (実際: ${raw()})`);
  assert.equal(nextBootGeneration(), escaped + 1, "逃げた次は+1で進む (もう一度逃げない)");
});

test("壊れた値は現在時刻(ミリ秒)へ逃がす。過去の世代より小さくしない", () => {
  // GLOB '[0-9]*' だと先頭1文字しか見ないので、ここが素通りしていた。
  // 空文字・全角・小数・数字で始まるゴミまで含めて確かめる
  for (const bad of ["", "abc", "12.3", "123x", "0x10", " 42", "１２３", "-5"]) {
    setRaw(bad);
    const n = nextBootGeneration();
    assert.ok(n > 1_000_000_000_000, `${JSON.stringify(bad)} は数字列ではないので現在時刻へ逃がす (実際: ${n})`);
  }
});

test("数字列だけを数字列として扱う (先頭が数字なだけの文字列を通さない)", () => {
  setRaw("100");
  assert.equal(nextBootGeneration(), 101, "全桁数字はそのまま+1する");
});

test("safe integer を超える値は黙って返さず落とす", () => {
  // ここを通すとJSONを経由した時点で隣接する世代が同じ値に丸まり、全順序が壊れる。
  // 起動を止めて気づかせるほうを選んでいる
  setRaw(String(Number.MAX_SAFE_INTEGER));
  assert.throws(() => nextBootGeneration(), /boot\.generation を採番できませんでした/);
});

test.after(() => {
  admin.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
