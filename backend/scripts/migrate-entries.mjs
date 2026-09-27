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
//   - 字下げの無い地の文が経過の中に混じっていたら、前の件に付ける (件が無ければ1件目にする)
//   - 経過の途中の見出し (`# ` 〜 `###### `) は**節ごと1件**にする (次の見出し・罫線・「## 経過」まで。
//     節の中の箇条書きは分けない)。日時は見出しの中の `YYYY-MM-DD` を拾う。開発機の実データ 174 枚のうち
//     91 枚がこの形で、大半は「## 2026-08-18 実装完了 (PR #38)」のような日付つきの進捗の節だった
//     (箇条書きで積む運用が決まる前の書き方)。固定文に戻すと進捗が固定文に混ざり、行に分けると
//     節の見出しだけの行ができるので、節を1件として残す
//   - 罫線 (`---` だけの行) は区切りとして捨てる
//   - **コードフェンス (``` 〜 ```) の中は本文として扱う** — 中の `## 経過` / `- ` / `---` を見出しや
//     箇条書きに読まない (Codexレビュー P1: フェンス内の `## 経過` が見出し扱いで消えていた)。
//     閉じるのは CommonMark どおり「開いたのと同じ記号で、同じ長さ以上の行」だけ (```` の中の ``` は閉じない。
//     Codexレビュー 2周目)。フェンスが閉じないまま終わるカードは分け方が決められないので拒む
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
const SECTION_HEADING = /^#{1,6} /;
const RULE = /^---\s*$/;
// 字下げは 3 スペースまで (CommonMark)。4 スペース以上の ``` はコードの本文であって開閉ではない (Codexレビュー 3周目)
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
/** フェンスの開閉。open が null なら外。閉じ行は同じ記号で同じ長さ以上 (CommonMark) */
function fenceStep(open, line) {
  if (!open) {
    const m = FENCE_OPEN.exec(line);
    return m ? { ch: m[1][0], len: m[1].length, changed: true } : { changed: false, open: null };
  }
  const m = FENCE_CLOSE.exec(line);
  const closes = !!m && m[1][0] === open.ch && m[1].length >= open.len;
  return closes ? { changed: true, open: null } : { changed: false, open };
}
const DATE_ANYWHERE = /(\d{4}-\d{2}-\d{2})/;
const DATE_AT_HEAD = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/;

/** 固定文と経過の行に分ける。純粋関数 (テストから直接呼べる) */
export function splitContext(context, fallbackAt) {
  const lines = context.replace(/\r\n/g, "\n").split("\n");
  // フェンスの外にある最初の「## 経過」行
  let fence = null;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const step = fenceStep(fence, lines[i]);
    if (step.changed) {
      fence = step.open ?? (fence ? null : step);
      continue;
    }
    if (!fence && HEADING.test(lines[i])) {
      at = i;
      break;
    }
  }
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
  // section = 見出しで始まる節の中 (箇条書きも節に含める) / bullets = 「- 」ごとに1件
  let mode = "bullets";
  fence = null;
  for (const raw of lines.slice(at + 1)) {
    const step = fenceStep(fence, raw);
    if (step.changed) {
      fence = step.open ?? (fence ? null : step);
      if (!cur) cur = { at: lastAt, lines: [] };
      cur.lines.push(raw.trimEnd());
      continue;
    }
    if (fence) {
      // フェンスの中は見出しでも箇条書きでも罫線でもない。そのまま本文
      if (!cur) cur = { at: lastAt, lines: [] };
      cur.lines.push(raw.trimEnd());
      continue;
    }
    if (HEADING.test(raw)) {
      // 繰り返しの見出し。節の途中なら節を閉じて箇条書きの読み方に戻る
      flush();
      mode = "bullets";
      continue;
    }
    const line = raw.trimEnd();
    if (RULE.test(line)) {
      flush();
      continue;
    }
    if (SECTION_HEADING.test(line)) {
      flush();
      const m = DATE_ANYWHERE.exec(line);
      if (m) lastAt = `${m[1]} 00:00:00`;
      cur = { at: lastAt, lines: [line] };
      mode = "section";
      continue;
    }
    if (line.startsWith("- ") && mode === "bullets") {
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
  if (fence) return { unterminatedFence: true };
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
    if (split.unterminatedFence) {
      refusals.push(`#${r.id} はコードフェンスが閉じていない — 分け方を決められないので人が直すこと`);
      continue;
    }
    const already = db.prepare("SELECT COUNT(*) c FROM card_entries WHERE card_id = ?").get(r.id).c;
    if (already > 0) {
      refusals.push(`#${r.id} は既に経過の行が ${already} 件あるのに、固定文にも「## 経過」節が残っている — 人が中身を見て決めること`);
      continue;
    }
    ops.push({ id: r.id, original: r.context, ...split });
    n += split.entries.length;
  }
  if (ops.length > 0) plan.push(`${ops.length} 枚の「## 経過」節を ${n} 行に分ける`);
  return { plan, refusals, ops };
}

function handle(path) {
  const db = new Database(path, APPLY ? {} : { readonly: true });
  try {
    if (!APPLY) {
      const { plan, refusals } = inspect(db);
      return { plan, refusals, applied: false };
    }
    // 読む・拒否を決める・書く、を1つの書き込みトランザクションの中で行う (Codexレビュー P2)。
    // 外で読んでから書くと、稼働中の本体がその間に固定文を書き換えたり行を足したりしたぶんが、
    // 古い本文から作った head の無条件 UPDATE で消える。immediate で最初に書きロックを取る
    return db.transaction(() => {
      const { plan, refusals, ops } = inspect(db);
      if (refusals.length > 0 || ops.length === 0) return { plan, refusals, applied: false };
      // prepare は inspect の後。表の無い DB (trash/ の削除済みプロジェクト) で先に prepare すると
      // 「no such table」で落ちて、残りの DB を見ずに止まる (miniPC の初回適用で実際に起きた。
      // projects/ が名前順で先だったので実害は無かった)
      const ins = db.prepare("INSERT INTO card_entries (card_id, at, source, text) VALUES (?, ?, NULL, ?)");
      const upd = db.prepare("UPDATE cards SET context = ? WHERE id = ? AND context = ?");
      for (const op of ops) {
        for (const e of op.entries) ins.run(op.id, e.at, e.text);
        // 読んだ本文と同じときだけ書く。違えば (同じトランザクション内なので起きないはずだが) 巻き戻す
        if (upd.run(op.head, op.id, op.original).changes !== 1) throw new Error(`#${op.id} の固定文が読んだときと違う`);
      }
      return { plan, refusals, applied: true };
    }).immediate();
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
