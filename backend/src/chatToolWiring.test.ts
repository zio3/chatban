import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #245: **入口の配線をテストする。**
 *
 * `delete_cards` / `reorder_cards` は共有入口 (`agentWrite.ts`) を通らないので、
 * ガードが `execTool()` の中にしか無い。**ヘルパ単体を試すだけでは、
 * 配線を消しても気づけない** — 実際、この一式を書く前は
 * チャット側の呼び出しを消しても全テストが通った (Codexレビュー指摘)。
 *
 * だからここでは `execTool()` を直接叩く。**入口ごとにズレる**のがこのリポジトリの
 * 繰り返しの事故 (#92 #108 #114 #153 #213 #237) なので、入口の側で固定する。
 *
 * LLMは呼ばない (ツール実行だけを叩く)。 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-wiring-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0";

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { createCard, getCard, listCards } = await import("./db.js");
const { execTool } = await import("./chat.js");

const run = (name: string, args: unknown) => execTool(name, args, new Set<string>()) as Promise<any>;

test("delete_cards: ids が文字列なら1件も消さない", async () => {
  const id = createCard("消えては困るカード").id;

  const r = await run("delete_cards", { ids: "12" });

  assert.equal(r.ok, false, "文字列を配列として扱っている");
  assert.match(r.note ?? "", /配列/);
  assert.ok(getCard(id) && !getCard(id)!.trashedAt, "巻き添えで消えている");
});

test("delete_cards: 整数でないものが混ざっていたら1件も消さない", async () => {
  const id = createCard("混在で消えては困るカード").id;

  const r = await run("delete_cards", { ids: [id, "x"] });

  assert.equal(r.ok, false);
  assert.ok(!getCard(id)!.trashedAt, "一部だけ処理している");
});

test("reorder_cards: ids が整数配列でなければ並べ替えない", async () => {
  const r = await run("reorder_cards", { ids: "12", status: "todo" });
  assert.equal(r.ok, false);
  assert.match(r.note ?? "", /配列/);
});

// **未知の列は「対象0件」で成功に見えていた。**更新側で塞いだ偽成功が、ここに残っていた
test("reorder_cards: 並べ替えられない列を指定したら、理由を返して何も動かさない", async () => {
  const a = createCard("並び順A").id;
  const b = createCard("並び順B").id;
  const before = listCards().map((t) => t.id);

  const r = await run("reorder_cards", { ids: [b, a], status: "pending" });

  assert.equal(r.ok, false, "未知の列なのに成功と返している");
  assert.match(r.note ?? "", /並べ替えできる列/);
  assert.deepEqual(listCards().map((t) => t.id), before, "並びが動いている");
});

test("reorder_cards: 正しく渡せば、これまでどおり並べ替えられる", async () => {
  const a = createCard("順番1").id;
  const b = createCard("順番2").id;

  const r = await run("reorder_cards", { ids: [b, a], status: "todo" });

  assert.equal(r.ok, true, r.note ?? "");
});

// 作成の入口が、共有入口の判断をそのまま返しているか (ok:true を被せていないか)
test("create_cards: 1件も作れなければ ok:false を返す", async () => {
  const r = await run("create_cards", { cards: [{ title: null }] });
  assert.equal(r.ok, false, "入口が ok:true を被せている");
  assert.equal(r.status, "failed");
  assert.equal(r.created.length, 0);
});

test("create_cards: 一部だけ作れたら partial と返す", async () => {
  const r = await run("create_cards", { cards: [{ title: "作れる" }, { title: 1 }] });
  assert.equal(r.ok, false);
  assert.equal(r.status, "partial");
  assert.equal(r.created.length, 1);
});

// **型は正しいが作成では使えないキー。**黙って捨てられて成功に見えていた
test("create_cards: 更新専用のキーを混ぜたら、黙って捨てずに断る", async () => {
  const r = await run("create_cards", { cards: [{ title: "決定事項つき", context_append: "LOST DECISION" }] });

  assert.equal(r.ok, false, "捨てたのに成功と返している");
  assert.match(r.invalid[0].reason, /context_append/);
  assert.equal(r.created.length, 0);
});

test("update_cards: 要素が null でも例外にせず、理由を返す", async () => {
  const r = await run("update_cards", { updates: [null] });
  assert.equal(r.ok, false);
  assert.match(r.invalid[0].reason, /オブジェクト/);
});
