import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #237: **`search_cards` の応答に載るキーを固定する番人。**
 *
 * `chatHits[]` がどのカードの会話かを指すキーは、**読み手がLLMだけ**で backend 内に利用側が無い。
 * だから名前を変えても型は通り、既存のテストも全部通る — **壊れても誰も気付けない。**
 *
 * 実際に3回往復した: #215 で `taskId` のまま取りこぼし → #232 第2弾で `cardId` に変えて
 * レビューで戻され (当時は内部識別子だけが範囲) → #237 で契約変更として改めて直した。
 * **見ているものが1つも無かったから**、毎回「これは動かしていいのか」から始まっていた。
 *
 * E2Eには置けない。カード専用チャットの発言を残すには実際のLLM呼び出しが要るため
 * (E2EはLLMを呼ばない方針)。DBを直に使えば、LLMもexpressも要らずに固定できる。 */

// **実データに触らせない。**store.ts は読み込み時に管理DBを開く (foldDone.test.ts と同じ作法)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-wiretest-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0";

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { createCard, saveChatMessage, searchCards } = await import("./db.js");

test("chatHits はカードを cardId で指す (taskId ではない)", () => {
  const card = createCard("検索の当たり先");
  saveChatMessage("user", "バリデーションの取りこぼしについて", undefined, undefined, card.id);

  const r = searchCards(["取りこぼし"]);

  assert.ok(r.chatHits, "chatHits が返っていない");
  const hit = r.chatHits.find((h: any) => h.cardId === card.id);
  assert.ok(hit, `chatHits がカードを cardId で指していない: ${JSON.stringify(r.chatHits)}`);
  assert.equal((hit as any).taskId, undefined, "古い taskId が残っている");
});

// **メインチャットの発言には紐付け先が無い。**キーごと出さない (null を載せない) ので、
// 「どのカードの話か」を持つものだけが cardId を持つ、が読み手から見て一貫する
test("メインチャットの発言には cardId を載せない", () => {
  saveChatMessage("user", "ハクセキレイの話をした", undefined, undefined, null);

  const r = searchCards(["ハクセキレイ"]);

  assert.ok(r.chatHits, "chatHits が返っていない");
  const hit = r.chatHits.find((h: any) => String(h.snippet).includes("ハクセキレイ"));
  assert.ok(hit, "発言が引けていない (前提が崩れている)");
  assert.ok(!("cardId" in (hit as any)), "紐付け先が無いのに cardId が載っている");
});
