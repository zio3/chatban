import { test } from "node:test";
import assert from "node:assert/strict";
import { isDemoMode, attachmentsEnabled, jsonLimit, suggestBootGraceMs, DEMO_SUGGEST_GRACE_MS, logBodiesEnabled, maskedBody } from "./demoMode.js";

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

// #224: 公開デモでは訪問者が打った本文がそのまま VPS のディスクに平文で残っていた。
// #213 (添付の入口を閉じる) と同じ系譜で、**個別の環境変数をserviceに書き足すのではなく
// DEMO_MODE の既定値として持つ** — 書き忘れても既定で守られる側に倒す
test("ログに本文を残すかはデモでは既定OFF、それ以外は既定ON", () => {
  assert.equal(logBodiesEnabled(env({})), true, "個人利用では調査の道具として要る");
  assert.equal(logBodiesEnabled(env({ DEMO_MODE: "on" })), false, "訪問者の入力を残さない");
  // 明示すればどちらでも勝てる (デモで調査したい場面はありうる)
  assert.equal(logBodiesEnabled(env({ DEMO_MODE: "on", CHATBAN_LOG_BODIES: "1" })), true);
  assert.equal(logBodiesEnabled(env({ CHATBAN_LOG_BODIES: "0" })), false);
});

// #259: 旧 CHATBAN_DUMP_PROMPT はプロンプトダンプ (llm.ts) だけを見ていて、
// 日次ログの `[chat] REQ` と `[choices] raw=` が掛け忘れになっていた。
// **スイッチは増やさず1つのまま**広げたので、古い名前が復活していないことを見張る
test("古い名前のスイッチは効かない (1つに寄せたので分岐が復活していない)", () => {
  assert.equal(
    logBodiesEnabled(env({ DEMO_MODE: "on", CHATBAN_DUMP_PROMPT: "1" })),
    false,
    "撤去した環境変数がまだ読まれている"
  );
});

// **伏せても行は消さない** (#254 と同じ理屈)。長さが残れば「何か打たれた」ことは追える
test("伏せた本文は長さだけになる", () => {
  assert.equal(maskedBody("こんにちは"), "(伏せた 5字)");
  assert.equal(maskedBody(""), "(伏せた 0字)");
  // サロゲートペアを2字と数えると、見た目の字数とズレる
  assert.equal(maskedBody("\u{1F600}\u{1F600}"), "(伏せた 2字)");
});
