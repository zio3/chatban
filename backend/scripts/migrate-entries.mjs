// #274: 経緯メモの「経過」を、cards.context の末尾の文字列から card_entries の行へ落とす。一回きりの移行。
//
// 旧形: context = 前半の固定文 + 「## 経過」見出し + 箇条書き (1行 = 1件、手書きの日付付き)。
// 新形: context = 固定文だけ。経過は card_entries(card_id, at, source, text) の行。
//
// 分け方 (実データ 123 枚を見て決めた。2026-09-27):
//   - **見出しの行** (`## 経過` だけの行) の最初のものより後を経過とする。本文中に
//     バッククォートで `## 経過` と書いた箇所 (説明文) は行頭に無いので見出しにならない
//   - 「## 経過」の行が複数あるもの (空の節のあとにもう一度作った形) は、繰り返しの見出し行を読み飛ばす
//   - `- ` で始まる行が1件。字下げされた続き (サブ箇条書き・折り返し) は前の件に付ける
//   - 字下げの無い地の文や `## ` 見出しが経過の中に混じっていたら、前の件に付ける (件が無ければ1件目にする)
//   - 日時: 行頭の `YYYY-MM-DD` (任意で ` HH:MM`) を拾う。無ければ直前の件と同じ。1件目にも無ければ
//     カードの updated_at。source は null (移行分。chat / mcp / human と区別できる)
//   - 見出しより前が空なら context は NULL
//
// **経過の見出しが無いカードは触らない** (固定文だけのカード。そのまま新形として正しい)。
// 全 DB を対象にし、DB 単位でトランザクション。下見は読み取り専用で開く (migrate-cards.mjs と同じ流儀)。
//
//   node scripts/migrate-entries.mjs          # 下見 (何枚を何件に分けるかを出す。書かない)
//   node scripts/migrate-entries.mjs --apply  # 実行
import Database from "better-sqlite3";
import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const DATA = process.env.CHATBAN_DATA_DIR ?? "data";

const HEADING = /^## 経過\s*$/;
const DATE_AT_HEAD = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/;

/** 固定文と経過の行に分ける。純粋関数 (テストから直接呼べる) */
export function splitContext(context, fallbackAt) {
  const lines = context.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => HEADING.test(l));
  if (at < 0) return null;

  const head = lines.slice(0, at).join("\n").trimEnd();
  const entries = [];
  let cur = null;
  let lastAt = fallbackAt;
  const flush = () => {
    if (!cur) return;
    const text = cur.lines.join("\n").trim();
    if (text) entries.push({ at: cur.at, text });
    cur = null;
  };
  for (const raw of lines.slice(at + 1)) {
    if (HEADING.test(raw)) continue; // 繰り返しの見出し
    const line = raw.trimEnd();
    if (line.startsWith("- ")) {
      flush();
      const body = line.slice(2);
      const m = DATE_AT_HEAD.exec(body);
      if (m) {
        const hh = m[2] ? String(m[2]).padStart(2, "0") : "00";
        lastAt = `${m[1]} ${hh}:${m[3] ?? "00"}:00`;
      }
      cur = { at: lastAt, lines: [body] };
      continue;
    }
    if (line === "") {
      if (cur) cur.lines.push("");
      continue;
    }
    // 字下げの続き / 地の文 / 混じった見出し → 前の件に付ける (無ければ1件目)
    if (!cur) cur = { at: lastAt, lines: [] };
    cur.lines.push(line);
  }
  flush();
  return { head: head === "" ? null : head, entries };
}

function inspect(db) {
  const plan = [];
  const refusals = [];
  const ops = [];
  const hasTable = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
  if (!hasTable("cards")) return { plan, refusals, ops };
  if (!hasTable("card_entries")) {
    // 本体がまだ一度も開いていない DB。テーブルは本体が作るものなので、ここでは作らない
    refusals.push("card_entries テーブルが無い (本体で一度開いてから)");
    return { plan, refusals, ops };
  }
  const rows = db.prepare("SELECT id, context, updated_at FROM cards WHERE context LIKE '%## 経過%'").all();
  let n = 0;
  for (const r of rows) {
    const split = splitContext(r.context, r.updated_at);
    if (!split) continue; // バッククォート等で本文に出てくるだけ
    const already = db.prepare("SELECT COUNT(*) c FROM card_entries WHERE card_id = ?").get(r.id).c;
    if (already > 0) {
      refusals.push(`#${r.id} は既に経過の行が ${already} 件あるのに、固定文にも「## 経過」節が残っている — 人が中身を見て決めること`);
      continue;
    }
    ops.push({ id: r.id, ...split });
    n += split.entries.length;
  }
  if (ops.length > 0) plan.push(`${ops.length} 枚の「## 経過」節を ${n} 行に分ける`);
  return { plan, refusals, ops };
}

function handle(path) {
  const db = new Database(path, APPLY ? {} : { readonly: true });
  try {
    const { plan, refusals, ops } = inspect(db);
    if (refusals.length > 0) return { plan, refusals, applied: false };
    if (!APPLY || ops.length === 0) return { plan, refusals, applied: false };
    const ins = db.prepare("INSERT INTO card_entries (card_id, at, source, text) VALUES (?, ?, NULL, ?)");
    const upd = db.prepare("UPDATE cards SET context = ? WHERE id = ?");
    db.transaction(() => {
      for (const op of ops) {
        for (const e of op.entries) ins.run(op.id, e.at, e.text);
        upd.run(op.head, op.id);
      }
    })();
    return { plan, refusals, applied: true };
  } finally {
    db.close();
  }
}

// テストから import されたときは走らせない (splitContext だけ使う)
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const targets = [];
  for (const dir of [join(DATA, "projects"), join(DATA, "trash")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".db")) targets.push(join(dir, f));
  }
  console.log(APPLY ? "=== 実行 ===" : "=== 下見 (読み取り専用。--apply で実行) ===");
  let touched = 0;
  let refused = 0;
  for (const p of targets) {
    const { plan, refusals } = handle(p);
    if (plan.length === 0 && refusals.length === 0) continue;
    if (refusals.length > 0) refused++;
    else touched++;
    console.log(`\n${p}`);
    for (const r of refusals) console.log(`  !! ${r}`);
    if (refusals.length > 0 && plan.length > 0) console.log("  -- 拒否条件があるので、下記は**実行していない**:");
    for (const n of plan) console.log(`  - ${n}`);
  }
  console.log(`\n対象 ${targets.length} / 変更あり ${touched} / 飛ばした ${refused}`);
  if (refused > 0) process.exitCode = 1;
}
