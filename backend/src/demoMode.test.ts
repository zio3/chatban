import { test } from "node:test";
import assert from "node:assert/strict";
import { isDemoMode, attachmentsEnabled, jsonLimit, suggestBootGraceMs, DEMO_SUGGEST_GRACE_MS } from "./demoMode.js";

// #213: DEMO_MODE は**既定値のセットであって、モード分岐ではない**。
// ここで固定するのは「何が既定になるか」と「個別指定が勝つこと」の2点。

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

test("既定 (DEMO_MODEなし) は全部開いている", () => {
  const e = env({});
  assert.equal(isDemoMode(e), false);
  assert.equal(attachmentsEnabled(e), true);
  assert.equal(jsonLimit(e), "25mb");
  assert.equal(suggestBootGraceMs(e), 60_000);
});

test("DEMO_MODE=on で既定がまとめて変わる", () => {
  const e = env({ DEMO_MODE: "on" });
  assert.equal(attachmentsEnabled(e), false, "添付は閉じる");
  assert.equal(jsonLimit(e), "256kb", "本文だけなので小さくてよい");
  assert.equal(suggestBootGraceMs(e), DEMO_SUGGEST_GRACE_MS, "提案チップは実質OFF");
});

test("個別指定が勝つ (デモでも開けられるし、デモでなくても閉じられる)", () => {
  // 手元の開発機は DEMO_MODE ではないが提案チップだけ止めたい、が実在する使い方
  assert.equal(suggestBootGraceMs(env({ SUGGEST_BOOT_GRACE_MS: "0" })), 0);
  assert.equal(attachmentsEnabled(env({ DEMO_MODE: "on", CHATBAN_ATTACHMENTS: "on" })), true);
  assert.equal(attachmentsEnabled(env({ CHATBAN_ATTACHMENTS: "off" })), false);
  assert.equal(jsonLimit(env({ DEMO_MODE: "on", CHATBAN_JSON_LIMIT: "5mb" })), "5mb");
  assert.equal(suggestBootGraceMs(env({ DEMO_MODE: "on", SUGGEST_BOOT_GRACE_MS: "0" })), 0);
});

test("真偽値の書き方は複数受ける。知らない文字列は既定に委ねる", () => {
  for (const v of ["1", "on", "true", "yes", "ON", "True"]) assert.equal(isDemoMode(env({ DEMO_MODE: v })), true, v);
  for (const v of ["0", "off", "false", "no"]) assert.equal(isDemoMode(env({ DEMO_MODE: v })), false, v);
  // **空文字や打ち間違いで勝手にデモになると事故る**ので、そこは既定 (デモではない) に倒す
  for (const v of ["", "  ", "demo", "onn"]) assert.equal(isDemoMode(env({ DEMO_MODE: v })), false, JSON.stringify(v));
});

test("数値でない SUGGEST_BOOT_GRACE_MS は既定に倒す (NaNで猶予が壊れない)", () => {
  assert.equal(suggestBootGraceMs(env({ SUGGEST_BOOT_GRACE_MS: "ずっと" })), 60_000);
  assert.equal(suggestBootGraceMs(env({ DEMO_MODE: "on", SUGGEST_BOOT_GRACE_MS: "ずっと" })), DEMO_SUGGEST_GRACE_MS);
});
