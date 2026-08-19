import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore -- scripts/ は素のJS (依存を入れる前に動く必要があるので型を持たない)
import { parseArgs, isResettable, isSeedable, SIDECAR_SUFFIXES } from "../scripts/reset-demo.mjs";

// #183: 判断だけを純粋関数にしてある。ファイルを消す処理そのものはテストしない
// (消す対象の**決め方**が合っていれば、消す処理は fs のもの)

test("消す対象はDB本体と副産物だけ", () => {
  assert.equal(isResettable("chatban-admin.db"), true);
  assert.equal(isResettable("chatban-admin.db-wal"), true);
  assert.equal(isResettable("chatban-admin.db-shm"), true);
  assert.equal(isResettable("projects/1-demo.db"), true);
  // データディレクトリに何かを足したときに巻き添えで消えないこと
  assert.equal(isResettable("README.md"), false);
  assert.equal(isResettable("backup/chatban.db.bak"), false);
});

test("seed には .db と -wal を揃いで採る (.db だけでは中身が入らない)", () => {
  assert.equal(isSeedable("chatban-admin.db"), true);
  // WALモードでは書いた内容が -wal 側に残る。実測で .db=4KB / -wal=140KB だった
  assert.equal(isSeedable("chatban-admin.db-wal"), true);
  // -shm は採らない (SQLiteが作り直す)
  assert.equal(isSeedable("chatban-admin.db-shm"), false);
});

test("既定は「確認あり・サービスを触る・リセット」", () => {
  const a = parseArgs([]);
  assert.equal(a.yes, false);
  assert.equal(a.service, true);
  assert.equal(a.snapshot, false);
});

test("--yes / --snapshot / --no-service が効く", () => {
  assert.equal(parseArgs(["--yes"]).yes, true);
  assert.equal(parseArgs(["-y"]).yes, true);
  assert.equal(parseArgs(["--snapshot"]).snapshot, true);
  assert.equal(parseArgs(["--no-service"]).service, false);
});

test("知らない引数は黙って捨てない (打ち間違いに気づけないため)", () => {
  assert.deepEqual(parseArgs(["--force"]).unknown, ["--force"]);
  // 打ち間違いが「確認なしで消す」に化けないこと
  assert.equal(parseArgs(["--yess"]).yes, false);
});
