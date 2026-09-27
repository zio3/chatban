import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/** #274: 旧形 (context の末尾に「## 経過」節) を card_entries の行に落とす移行の番人。
 * 一回きりの移行だが、miniPC の実データ (経過を持つカード 123 枚) に流すものなので、
 * 分け方の規則を合成データで固定しておく。下見が書かないこと、混在を拒むことも見る */

// 実データに触らせない (testEnv.ts の隔離ディレクトリ。migrateCardsRescue.test.ts と同じ)
const dataDir = process.env.CHATBAN_DATA_DIR!;
assert.ok(dataDir && dataDir.includes("chatban-test-data-"), "testEnv.ts の隔離ディレクトリが無い (npm test 経由で走らせる)");

const { ensureProjectSchema } = await import("./store.js");
const script = fileURLToPath(new URL("../scripts/migrate-entries.mjs", import.meta.url));
const backendDir = fileURLToPath(new URL("..", import.meta.url));

function run(apply: boolean) {
  return spawnSync(process.execPath, [script, ...(apply ? ["--apply"] : [])], {
    cwd: backendDir,
    env: { ...process.env, CHATBAN_DATA_DIR: dataDir },
    encoding: "utf8",
  });
}

const OLD = [
  "## 背景",
  "",
  "決めたこと。本文で `## 経過` と書いた説明は見出しではない。",
  "",
  "```md",
  "## 経過",
  "フェンスの中の見出しは本文 (Codexレビュー P1)",
  "```",
  "",
  "## 経過",
  "",
  "- 2026-08-28: 起票",
  "  - サブの箇条書きは前の件に付く",
  "",
  "- 実装完了 (PR#1)。日付が無いので直前の件と同じ日時",
  "- 2026-09-06 10:38 JST デプロイ完了",
  "  ```yaml",
  "  ---",
  "  - フェンスの中の罫線と箇条書きは分けない",
  "  ```",
  "",
  "---",
  "",
  "## 2026-09-10 結果 (見出しで書かれた進捗)",
  "",
  "節の中の箇条書きは分けない:",
  "- 実測 a",
  "- 実測 b",
].join("\n");

function oldDb(file: string, extra?: (db: Database.Database) => void) {
  fs.mkdirSync(path.join(dataDir, "projects"), { recursive: true });
  const p = path.join(dataDir, "projects", file);
  if (fs.existsSync(p)) fs.rmSync(p);
  const db = new Database(p);
  ensureProjectSchema(db);
  db.prepare("INSERT INTO cards (id, title, context, updated_at) VALUES (1, '旧形', ?, '2026-01-01 00:00:00')").run(OLD);
  db.prepare("INSERT INTO cards (id, title, context) VALUES (2, '固定文だけ', '## 背景\n\n経過の節が無い')").run();
  db.prepare("INSERT INTO cards (id, title, context) VALUES (3, '空', NULL)").run();
  extra?.(db);
  db.close();
  return p;
}

test("下見は書かない。--apply で「## 経過」節が行になり、固定文だけが残る", () => {
  const p = oldDb("1-entries.db");

  const preview = run(false);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /1 枚の「## 経過」節を 4 行に分ける/, preview.stdout);
  let db = new Database(p, { readonly: true });
  assert.equal((db.prepare("SELECT COUNT(*) c FROM card_entries").get() as any).c, 0, "下見で書いている");
  db.close();

  const applied = run(true);
  assert.equal(applied.status, 0, applied.stderr);
  db = new Database(p, { readonly: true });
  const card = db.prepare("SELECT context FROM cards WHERE id = 1").get() as any;
  assert.equal(
    card.context,
    "## 背景\n\n決めたこと。本文で `## 経過` と書いた説明は見出しではない。\n\n```md\n## 経過\nフェンスの中の見出しは本文 (Codexレビュー P1)\n```",
    "固定文が残っていない (フェンスの中の ## 経過 は見出しではない)"
  );
  const rows = db.prepare("SELECT at, source, text FROM card_entries WHERE card_id = 1 ORDER BY id").all() as any[];
  assert.deepEqual(
    rows.map((r) => [r.at, r.text]),
    [
      ["2026-08-28 00:00:00", "2026-08-28: 起票\n  - サブの箇条書きは前の件に付く"],
      ["2026-08-28 00:00:00", "実装完了 (PR#1)。日付が無いので直前の件と同じ日時"],
      ["2026-09-06 10:38:00", "2026-09-06 10:38 JST デプロイ完了\n  ```yaml\n  ---\n  - フェンスの中の罫線と箇条書きは分けない\n  ```"],
      // 見出しの節は箇条書きごと1件。罫線は捨てる。日時は見出しの日付
      ["2026-09-10 00:00:00", "## 2026-09-10 結果 (見出しで書かれた進捗)\n\n節の中の箇条書きは分けない:\n- 実測 a\n- 実測 b"],
    ]
  );
  assert.ok(rows.every((r) => r.source === null), "移行分の source は null にする (chat / mcp / human と区別)");
  // 触らないもの
  assert.equal((db.prepare("SELECT context FROM cards WHERE id = 2").get() as any).context, "## 背景\n\n経過の節が無い");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM card_entries WHERE card_id <> 1").get() as any).c, 0);
  db.close();

  // もう一度流しても何もしない (節が無くなっているので対象外)
  const again = run(true);
  assert.equal(again.status, 0);
  assert.doesNotMatch(again.stdout, /に分ける/, "二重に移行している");
});

test("コードフェンスが閉じていないカードは拒む (分け方を決められない)", () => {
  const p = oldDb("3-fence.db", (db) => {
    db.prepare("INSERT INTO cards (id, title, context) VALUES (9, '開いたまま', '## 経過\n```\n- 閉じない')").run();
  });
  const r = run(true);
  assert.equal(r.status, 1, "拒否したのに終了コードが 0");
  assert.match(r.stdout, /#9 はコードフェンスが閉じていない/, r.stdout);
  const db = new Database(p, { readonly: true });
  assert.equal((db.prepare("SELECT COUNT(*) c FROM card_entries").get() as any).c, 0, "拒んだ DB に書いている (#1 も同じ DB)");
  db.close();
});

test("既に行があるのに節も残っているカードは拒み、そのDBには1バイトも書かない", () => {
  const p = oldDb("2-mixed.db", (db) => {
    db.prepare("INSERT INTO card_entries (card_id, text) VALUES (1, '先に足された行')").run();
  });
  const r = run(true);
  assert.equal(r.status, 1, "拒否したのに終了コードが 0");
  assert.match(r.stdout, /#1 は既に経過の行が 1 件ある/, r.stdout);
  const db = new Database(p, { readonly: true });
  assert.equal((db.prepare("SELECT context FROM cards WHERE id = 1").get() as any).context, OLD, "拒んだのに固定文を書き換えている");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM card_entries").get() as any).c, 1, "拒んだのに行を足している");
  db.close();
});
