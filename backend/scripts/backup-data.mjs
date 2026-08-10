// #86: data/ 配下の全DBを世代バックアップする。
// WALモードでは .db 本体をコピーしても直近の書き込み(-wal側)が落ちるため、
// SQLiteのオンラインバックアップAPIを使う (稼働中のプロセスが書いていても整合が取れる)。
// 使い方: node scripts/backup-data.mjs [世代数]
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.CHATBAN_DATA_DIR ?? "data";
const BACKUP_DIR = process.env.CHATBAN_BACKUP_DIR ?? "backup";
const KEEP = Number(process.argv[2] ?? 20);

if (!existsSync(DATA_DIR)) {
  console.log(`[backup] ${DATA_DIR} が無いのでスキップ`);
  process.exit(0);
}

function collect(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "trash") continue; // 退避済みは対象外
      out.push(...collect(p));
    } else if (e.name.endsWith(".db")) out.push(p);
  }
  return out;
}

const stamp = new Date()
  .toLocaleString("sv-SE")
  .replace(/[-: ]/g, "")
  .slice(0, 14);
const dest = join(BACKUP_DIR, `data-${stamp}`);
mkdirSync(dest, { recursive: true });

let total = 0;
for (const src of collect(DATA_DIR)) {
  const name = src.split(/[\\/]/).pop();
  const db = new Database(src, { readonly: true });
  await db.backup(join(dest, name));
  db.close();
  total += statSync(join(dest, name)).size;
}
const files = readdirSync(dest);
console.log(`[backup] ${files.length} files (${Math.round(total / 1024)}KB) -> ${dest}`);

// 世代整理
const gens = readdirSync(BACKUP_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("data-"))
  .map((e) => e.name)
  .sort()
  .reverse();
for (const old of gens.slice(KEEP)) rmSync(join(BACKUP_DIR, old), { recursive: true, force: true });
