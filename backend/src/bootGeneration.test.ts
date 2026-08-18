import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #199: 起動世代の採番。store.ts はモジュールを読んだ時点で管理DBを開くので、
// 先に CHATBAN_DATA_DIR を捨て場所へ向けてから読み込む (実データを触らない)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-bootgen-"));
process.env.CHATBAN_DATA_DIR = dir;
const { admin, nextBootGeneration } = await import("./store.js");

const seq = () =>
  (admin.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'boot_generations'").get() as
    | { seq: number }
    | undefined)?.seq;

test("呼ぶたびに増える。連続で呼んでも同じ番号を返さない", () => {
  const a = nextBootGeneration();
  const b = nextBootGeneration();
  const c = nextBootGeneration();
  assert.equal(b, a + 1);
  assert.equal(c, b + 1);
});

test("行を消しても番号は再利用しない (単調性はDBが保証する)", () => {
  // AUTOINCREMENT は sqlite_sequence に最大値を持つので、行が消えても戻らない。
  // 履歴が要らないので nextBootGeneration 自身が古い行を落としている —
  // その掃除が採番に影響しないことを固定しておく
  const before = nextBootGeneration();
  const rows = admin.prepare("SELECT COUNT(*) c FROM boot_generations").get() as { c: number };
  assert.equal(rows.c, 1, "採番のたびに古い行は落とす (履歴は持たない)");
  admin.prepare("DELETE FROM boot_generations").run();
  assert.equal(nextBootGeneration(), before + 1, "全部消しても番号は戻らない");
});

test("再起動をまたいでも増え続ける (DBを開き直しても戻らない)", () => {
  // ここが「プロセス内カウンタでは足りない」の要。実際に接続を張り直して確かめる
  const last = nextBootGeneration();
  const reopened = new (admin.constructor as any)(path.join(dir, "chatban-admin.db"));
  const next = Number(reopened.prepare("INSERT INTO boot_generations DEFAULT VALUES").run().lastInsertRowid);
  reopened.close();
  assert.equal(next, last + 1);
});

test("sqlite_sequence が壊されても、残した1行から復帰する", () => {
  // 次の採番は max(seq, テーブル内の最大rowid) + 1 なので、1行残していることが保険になる。
  // 直接 UPDATE で直そうとすると `MAX(seq, ?)` が型順序で比べるせいで 'abc' や NULL を
  // 修復できず、次の採番が1に戻る (8周目の指摘。ここが落ちればその退行に気づける)
  const last = nextBootGeneration();
  for (const bad of ["'abc'", "NULL", "-5"]) {
    admin.exec(`UPDATE sqlite_sequence SET seq = ${bad} WHERE name = 'boot_generations'`);
    const n = nextBootGeneration();
    assert.ok(n > last, `seq=${bad} でも戻らない (実際: ${n} <= ${last})`);
  }
});

test("settings に残っていた旧世代を引き継ぐ (1へ戻さない)", async () => {
  // #199 の途中まで settings の 'boot.generation' 行で持っていた。引き継がずに1から始めると、
  // 開いたままのタブが持っている世代のほうが大きくなり、以後の更新が全部「古い」と判定される。
  // 旧実装はエポックミリ秒まで番号が上がっていたので、放っておくと必ずそうなる
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-bootgen-legacy-"));
  const legacy = 1_787_000_000_000;
  const raw = new (admin.constructor as any)(path.join(dir2, "chatban-admin.db"));
  raw.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))"
  );
  raw.prepare("INSERT INTO settings (key, value) VALUES ('boot.generation', ?)").run(String(legacy));
  raw.close();

  // そのDBを store.ts の経路で開き直す (ensureAdminSchema → migrateBootGeneration が走る)
  process.env.CHATBAN_DATA_DIR = dir2;
  const fresh = await import(`./store.js?legacy=${Date.now()}`);
  try {
    assert.equal(
      fresh.admin.prepare("SELECT value FROM settings WHERE key = 'boot.generation'").get(),
      undefined,
      "旧キーは消える"
    );
    assert.equal(fresh.nextBootGeneration(), legacy + 1, "旧値の続きから振る");
    // sqlite_sequence を直接UPDATEせず、明示rowidのINSERTで引き継いでいる。
    // seq が壊れていても直る形なので、seq が整数として整っていることも見ておく
    const s = fresh.admin.prepare("SELECT seq, typeof(seq) t FROM sqlite_sequence WHERE name = 'boot_generations'").get();
    assert.equal(s.t, "integer");
    assert.ok(s.seq >= legacy);
  } finally {
    fresh.admin.close();
    process.env.CHATBAN_DATA_DIR = dir;
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test("初回移行を実プロセスで同時に走らせても、全部起動でき、番号も重複しない", async () => {
  // 「読む→判断する→書く」を素で並べていると、2プロセスが同時に初回移行へ入って
  // 両方が max=NULL を見て同じ id を INSERT し、片方が PRIMARY KEY 制約で落ちる (9周目の指摘)。
  //
  // **このテストの限界を先に書いておく。**実装から `.immediate()` を外して同じ手順を流しても、
  // 6本中0本しか落ちなかった (実測)。競合の窓が狭く、プロセス起動のばらつきのほうが大きいので、
  // **BEGIN IMMEDIATE が要ることの証明にはならない**。ここが見ているのは
  // 「実際の起動経路を並行に走らせて、落ちず・番号が重複しない」ところまで。
  // 排他そのものは実装側の BEGIN IMMEDIATE + INSERT OR IGNORE で担保している
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-bootgen-race-"));
  const file = path.join(dir3, "chatban-admin.db");
  const legacy = 1_787_000_000_000;
  const seed = new (admin.constructor as any)(file);
  seed.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))"
  );
  seed.prepare("INSERT INTO settings (key, value) VALUES ('boot.generation', ?)").run(String(legacy));
  seed.close();

  // 子プロセスは store.ts をそのまま読み込む = 本物の起動経路 (ensureAdminSchema → 移行) を通る
  const child = path.join(dir3, "boot.mjs");
  const storeUrl = new URL("./store.ts", import.meta.url).href;
  fs.writeFileSync(
    child,
    `const { nextBootGeneration } = await import(${JSON.stringify(storeUrl)});\nconsole.log(nextBootGeneration());\n`
  );

  const boot = () =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      let out = "";
      let err = "";
      const p = spawn(process.execPath, ["--import", "tsx", child], {
        env: { ...process.env, CHATBAN_DATA_DIR: dir3 },
      });
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code, out, err }));
    });

  try {
    const results = await Promise.all([boot(), boot(), boot(), boot()]);
    const failed = results.filter((r) => r.code !== 0);
    assert.equal(failed.length, 0, `起動に失敗したものがある: ${failed.map((f) => f.err).join(" / ")}`);

    // 標準出力の最後の行が世代番号 (移行のログが混ざる回がある)
    const generations = results.map((r) => Number(r.out.trim().split("\n").at(-1)));
    for (const g of generations) assert.ok(Number.isSafeInteger(g) && g > legacy, `旧値より大きいはず: ${g}`);
    assert.equal(new Set(generations).size, generations.length, `世代が重複した: ${generations.join(", ")}`);
  } finally {
    fs.rmSync(dir3, { recursive: true, force: true });
  }
});

test("採番は safe integer の範囲でしか返さない", () => {
  // ここを超えると JSON を経由した時点で隣接する世代が同じ値に丸まり、全順序が壊れる。
  // 起動を止めて気づかせるほうを選んでいる
  admin.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'boot_generations'").run(Number.MAX_SAFE_INTEGER);
  assert.throws(() => nextBootGeneration(), /採番できませんでした/);

  // 後続のテストに影響しないよう戻す。**行も消す** — 落ちた回のINSERTは残っており、
  // AUTOINCREMENT の次の値は max(seq, テーブル内の最大rowid) + 1 なので、
  // sqlite_sequence だけ戻しても行が残っていれば元の巨大値から振り直される。
  // (実装側から見ると「一度この状態になったら起動は止まり続ける」= 人が直すまで動かない、が意図)
  admin.prepare("DELETE FROM boot_generations").run();
  admin.prepare("UPDATE sqlite_sequence SET seq = 100 WHERE name = 'boot_generations'").run();
  assert.equal(nextBootGeneration(), 101);
  assert.ok(seq()! > 0);
});

test.after(() => {
  admin.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
