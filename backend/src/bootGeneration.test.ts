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

test("行が無ければ現在のUNIX秒から始める (1から始めない)", () => {
  // 「新規DB」と「壊れたので消した」は区別できない。1から始めると後者で過去世代より
  // 小さくなり、旧プロセスの応答を新しいと誤採用する。安全な側に揃える
  admin.prepare("DELETE FROM settings WHERE key = 'boot.generation'").run();
  const n = nextBootGeneration();
  assert.ok(n > 1_000_000_000, `UNIX秒相当のはず: ${n}`);
});

test("壊れた値はUNIX秒へ逃がす。過去の世代より小さくしない", () => {
  // GLOB '[0-9]*' だと先頭1文字しか見ないので、ここが素通りしていた。
  // 空文字・全角・小数・数字で始まるゴミまで含めて確かめる
  for (const bad of ["", "abc", "12.3", "123x", "0x10", " 42", "１２３", "-5"]) {
    setRaw(bad);
    const n = nextBootGeneration();
    assert.ok(n > 1_000_000_000, `${JSON.stringify(bad)} は数字列ではないのでUNIX秒へ逃がす (実際: ${n})`);
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
