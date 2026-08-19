#!/usr/bin/env node
/**
 * デモ板を初期状態へ戻す (#183)。
 *
 *   node backend/scripts/reset-demo.mjs            リセットする (確認あり)
 *   node backend/scripts/reset-demo.mjs --yes      確認なし (cron 用)
 *   node backend/scripts/reset-demo.mjs --snapshot いまの板を seed として保存する
 *   node backend/scripts/reset-demo.mjs --no-service  サービスを触らない (手元での確認用)
 *
 * **ファイル差し替えだけでは壊れる。**better-sqlite3 が WAL モードでDBを開いたままなので、
 * 動いているところへ `.db` を上書きすると、残っている `-wal` が新しい `.db` に適用されて
 * 中身が混ざる。だから **停止 → 差し替え → 起動** の順を、このスクリプトが保証する。
 *
 * **Nodeの標準機能だけで書く** (setup.mjs と同じ)。backend の依存を import しないので、
 * このスクリプト自身は SQLite を開かない — 開かないことが安全性そのもの。
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync, chownSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** SQLite が1つのDBに対して作る副産物。**seed には入れず、リセット時は消す**。
 * `-wal` を残したまま `.db` を入れ替えると、直前の書き込みが新しいDBへ適用されて壊れる */
export const SIDECAR_SUFFIXES = ["-wal", "-shm"];

/** リセットで data 配下から消すもの = DB本体と副産物。
 * **それ以外 (ログ・置き忘れ) には触らない** — 消す範囲を名前で決めておくと、
 * データディレクトリに何かを足したときに巻き添えで消えない */
export function isResettable(name) {
  return /\.db$/.test(name) || SIDECAR_SUFFIXES.some((s) => name.endsWith(`.db${s}`));
}

/** seed に採るもの = DB本体と `-wal`。**`.db` だけでは中身が入らない。**
 *
 * WALモードでは、書いた内容はしばらく `-wal` 側にあり、`.db` には取り込まれていない。
 * 実測 (2026-08-19 デモ環境): カードを3枚置いた直後の `.db` は 4,096バイト、`-wal` が 140KB。
 * `.db` だけ採ると**空の板が seed になる**。
 *
 * 「`-wal` を混ぜると壊れる」のは**新しい `.db` に古い `-wal` が残っている**ときの話で、
 * 停止中に揃いで採って揃いで戻すぶんには整合している。`-shm` は採らない (SQLiteが作り直す) */
export function isSeedable(name) {
  return /\.db$/.test(name) || name.endsWith(".db-wal");
}

/** `--project` の絞り込み。プロジェクトDBは `projects/<id>-<名前>.db` という名前なので、
 * **番号でも名前の一部でも指せる** (`--project 3` / `--project デモ`)。
 *
 * 絞ったときは **`projects/` の下しか見ない** — 管理DB (chatban-admin.db) を巻き込むと、
 * プロジェクトの一覧ごと差し替わって**他のプロジェクトが消える**。手元の実録の板と
 * お試しの板が同じデータディレクトリに同居しているときに、これが効く */
/** seed 配下にある「消してよいもの」= DB本体と `-wal`。
 * README など、リポジトリで管理しているファイルはここに入らない */
function seedableFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter(isSeedable);
}

export function matchesProject(rel, needle) {
  if (!needle) return true;
  const p = rel.split(path.sep).join("/");
  if (!p.startsWith("projects/")) return false;
  const base = p.slice("projects/".length);
  return /^\d+$/.test(needle) ? base.startsWith(`${needle}-`) : base.includes(needle);
}

/** 引数の解釈。未知のフラグは黙って捨てない (setup.mjs と同じ規則) */
export function parseArgs(argv) {
  const out = { yes: false, snapshot: false, service: true, help: false, project: null, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--snapshot") out.snapshot = true;
    else if (a === "--no-service") out.service = false;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--project") out.project = argv[++i] ?? "";
    else if (a.startsWith("--project=")) out.project = a.slice("--project=".length);
    else out.unknown.push(a);
  }
  return out;
}

const SERVICE = process.env.CHATBAN_SERVICE ?? "chatban";
const DATA = process.env.CHATBAN_DATA_DIR ?? path.join(ROOT, "data");
const SEED = process.env.CHATBAN_SEED_DIR ?? path.join(ROOT, "seed");

/** コピーしたものの持ち主を、データディレクトリの持ち主に合わせる。
 *
 * **root で走らせると、置いたファイルが root 所有になってサービスが書けなくなる** (systemctl を
 * 叩くので root で走らせるのが普通)。壊れ方が「リセットの直後は動いていて、次の書き込みで落ちる」
 * なので気づきにくい。root でないとき・Windows では何もしない */
function matchOwner(to, root, owner) {
  if (process.getuid?.() !== 0) return;
  const { uid, gid } = statSync(owner);
  chownSync(to, uid, gid);
  // 作った途中のディレクトリも合わせる (projects/ が root 所有のままだと中身を足せない)。
  // **持ち主を見る場所 (owner) と、辿る根 (root) は別。**seed へ採るときは
  // 「data の持ち主」を「seed の下のディレクトリ」に付ける
  for (let d = path.dirname(to); d !== root && d.startsWith(root); d = path.dirname(d)) chownSync(d, uid, gid);
}

/** 停止・起動の指示。**stop に失敗したらデータに触らない**ので、呼び出し側は戻り値を見ること */
function service(action, enabled) {
  if (!enabled) return true;
  const r = spawnSync("systemctl", [action, SERVICE], { stdio: "inherit" });
  return r.status === 0;
}

const USAGE = `使い方:
  node backend/scripts/reset-demo.mjs             デモ板を seed の状態へ戻す
  node backend/scripts/reset-demo.mjs --yes       確認なし (cron 用)
  node backend/scripts/reset-demo.mjs --snapshot  いまの板を seed として保存する
  node backend/scripts/reset-demo.mjs --no-service サービスを止めずに実行する (手元での確認用)

  --project <番号 or 名前の一部>  そのプロジェクトの板だけを採る/戻す。
      管理DBには触らないので、**同じデータディレクトリにある他の板は無事**。
      手元で「お試しの板だけ元に戻す」ときはこちら

  データ: ${DATA}
  seed  : ${SEED}
  サービス: ${SERVICE} (環境変数 CHATBAN_SERVICE / CHATBAN_DATA_DIR / CHATBAN_SEED_DIR で変えられる)`;

const say = (s = "") => process.stdout.write(s + "\n");

async function confirm(question) {
  if (!process.stdin.isTTY) {
    say("対話できない環境です。意図しての実行なら --yes を付けてください。");
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.unknown.length > 0) {
    if (args.unknown.length > 0) say(`知らない引数: ${args.unknown.join(" ")}\n`);
    say(USAGE);
    process.exit(args.unknown.length > 0 ? 1 : 0);
  }
  if (!existsSync(DATA)) {
    say(`データディレクトリがありません: ${DATA}`);
    process.exit(1);
  }

  // 動いたまま差し替えると、開きっぱなしのDBと `-wal` の対応が崩れる。
  // systemctl の無い環境 (Windows の開発機など) では手で止めてから使うことになるので、念を押す
  if (!args.service) say("※ サービスを止めずに実行します。動いているならDBが壊れることがあります。");

  // --- サービスを止める。ここが失敗したら**何も触らない** ---
  if (!service("stop", args.service)) {
    say(`${SERVICE} を止められませんでした。データには触っていません。`);
    process.exit(1);
  }

  try {
    if (args.snapshot) {
      const dbs = readdirSync(DATA, { recursive: true })
        .map(String)
        .filter((f) => isSeedable(f) && matchesProject(f, args.project));
      if (dbs.length === 0) {
        say(args.project ? `${args.project} に当たるプロジェクトDBがありません。` : "DBが1つも無いので、seed に採るものがありません。");
        process.exit(1);
      }
      if (!args.yes && !(await confirm(`${SEED} を ${dbs.length}件のDBで置き換えます。`))) {
        say("やめました。");
        process.exit(0);
      }
      // **絞ったときは seed を消さない。**他の板の seed を巻き添えにしないため、
      // 当たったファイルだけを上書きする
      //
      // 消すのは **DBだけ**。ディレクトリごと消すと `seed/README.md` (リポジトリに入っている)
      // まで巻き添えになり、デプロイのたびに作業ツリーが汚れる。
      // 実測 (2026-08-20, デモ環境): `D backend/seed/README.md` が出ていた
      if (!args.project) for (const rel of seedableFiles(SEED)) rmSync(path.join(SEED, rel), { force: true });
      for (const rel of dbs) {
        const to = path.join(SEED, rel);
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(path.join(DATA, rel), to);
        matchOwner(to, SEED, DATA);
      }
      say(`seed を更新しました (${dbs.length}件)。`);
    } else {
      const seeds = existsSync(SEED)
        ? readdirSync(SEED, { recursive: true })
            .map(String)
            .filter((f) => isSeedable(f) && matchesProject(f, args.project))
        : [];
      const doomed = readdirSync(DATA, { recursive: true })
        .map(String)
        .filter((f) => isResettable(f) && matchesProject(f, args.project));
      if (args.project && seeds.length === 0) {
        // 絞ったのに戻すものが無い = 採る前に戻そうとしている。消すだけになるので止める
        say(`${args.project} の seed がありません。先に --snapshot で採ってください。`);
        process.exit(1);
      }
      const what = seeds.length > 0 ? `seed の ${seeds.length}件` : "空の板";
      if (!args.yes && !(await confirm(`いまの ${doomed.length}件を捨てて ${what} に戻します。`))) {
        say("やめました。");
        process.exit(0);
      }
      for (const rel of doomed) rmSync(path.join(DATA, rel), { force: true });
      for (const rel of seeds) {
        const to = path.join(DATA, rel);
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(path.join(SEED, rel), to);
        matchOwner(to, DATA, DATA);
      }
      say(`リセットしました (${doomed.length}件を削除 / ${seeds.length}件を復元)。`);
    }
  } finally {
    // **止めたものは必ず起こす。**途中で失敗しても、板が落ちたままにはしない
    if (!service("start", args.service)) say(`${SERVICE} の起動に失敗しました。手で確認してください。`);
  }
}

// import されたとき (テスト) は動かさない
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
