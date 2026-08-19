#!/usr/bin/env node
/**
 * 公開デモへ反映する (#214)。**VPS の上で実行する。**
 *
 *   sudo node backend/scripts/deploy-demo.mjs          反映する (確認あり)
 *   sudo node backend/scripts/deploy-demo.mjs --yes    確認なし
 *   sudo node backend/scripts/deploy-demo.mjs --no-service  サービスを触らない (手元での確認用)
 *
 * **接続情報を持たない。**ssh も鍵もホスト名も出てこないので、公開リポジトリに置いても
 * デモ環境の在り処が漏れない (リポジトリはPublic)。宛先を知っているのは実行する人だけ。
 *
 * **順番を人間に守らせない**のがこのスクリプトの全部で、reset-demo.mjs と同じ理由で書いてある。
 * 手でやったとき (2026-08-20, #213の反映) に実際に踏んだのは:
 *   - `npm ci --omit=dev` にすると **tsx が入らずサービスが起動しない** (tsx は devDependency で、
 *     unit は `tsx src/index.ts` を実行する)。だから **devDependencies ごと入れる**
 *   - `version.txt` を手で置いていたので **ビルドで消えた** → #214 でビルドの副産物にした。
 *     ここでは作らない。作らないことが正しい (二重に作ると、どちらが本物か分からなくなる)
 *
 * **Nodeの標準機能だけで書く** (reset-demo.mjs / setup.mjs と同じ)。
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVICE = process.env.CHATBAN_SERVICE ?? "chatban";
/** ヘルスチェックの宛先。**localhost を見る** — 外から見ると Caddy のキャッシュや
 * 別のバックエンドを見てしまい、「起動したこと」の確認にならない */
const HEALTH = process.env.CHATBAN_HEALTH_URL ?? "http://127.0.0.1:8080/api/board";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const touchService = !args.includes("--no-service");

main().catch((e) => {
  console.error(`\n失敗: ${e.message}`);
  process.exit(1);
});

async function main() {
  const owner = repoOwner();
  console.log(`反映先: ${ROOT}`);
  console.log(`サービス: ${touchService ? SERVICE : "(触らない)"}`);
  console.log(`実行ユーザー: ${owner ? `${owner.name} (ファイルの持ち主に合わせる)` : "そのまま"}`);
  if (!yes) await confirm();

  // 取得は「進める」だけにする。--ff-only なので、手で直したものがあれば**ここで止まる**。
  // マージやリベースを自動でやると、デモ環境の上で衝突を解く羽目になる
  step("git", ["pull", "--ff-only"], ROOT, owner);

  // 依存は本番でも devDependencies ごと入れる (上のコメントの理由)
  step("npm", ["install"], path.join(ROOT, "backend"), owner);
  step("npm", ["install"], path.join(ROOT, "frontend"), owner);
  step("npm", ["run", "build"], path.join(ROOT, "frontend"), owner);

  if (touchService) step("systemctl", ["restart", SERVICE], ROOT, null);

  const sha = capture("git", ["rev-parse", "HEAD"], ROOT, owner);
  if (touchService) await health();
  console.log(`\n反映しました: ${sha}`);
  console.log(`確認: /version.txt と GET /api/board (attachments が false なら DEMO_MODE が効いている)`);
}

/** ファイルの持ち主。root で走らせても、リポジトリを root 所有にしてしまわないため。
 * root でないなら自分のままでよいので null を返す */
function repoOwner() {
  if (process.getuid?.() !== 0) return null;
  const { uid, gid } = statSync(ROOT);
  if (uid === 0) return null;
  return { uid, gid, name: `uid=${uid}` };
}

function step(cmd, cmdArgs, cwd, owner) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(" ")}   (${cwd})`);
  // **sudo は PATH を捨てる** (secure_path)。node を /opt/node/bin のような場所に置いていると、
  // そのままでは npm が見つからない (実測: `sudo: npm: command not found`)。
  // 呼んだ側の PATH をそのまま渡す — このスクリプトを起動できた PATH なら npm も同じ場所にある
  const r = owner
    ? spawnSync("sudo", ["-u", `#${owner.uid}`, "-H", "env", `PATH=${process.env.PATH}`, cmd, ...cmdArgs], {
        cwd,
        stdio: "inherit",
      })
    : spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
  if (r.error) throw new Error(`${cmd} を実行できない: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} が失敗した (exit ${r.status})`);
}

/** 持ち主に合わせて実行する。**root のまま git を叩くと dubious ownership で拒否される**
 * (実測: 反映は成功しているのに `反映しました: (不明)` と出た) */
function capture(cmd, cmdArgs, cwd, owner) {
  const argv = owner ? ["-u", `#${owner.uid}`, "-H", cmd, ...cmdArgs] : cmdArgs;
  const r = spawnSync(owner ? "sudo" : cmd, argv, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "(不明)";
}

/** 起動を待つ。**再起動が成功したことと、応答が返ることは別**なので、
 * systemctl の戻り値だけで「反映できた」と言わない */
async function health() {
  for (let i = 1; i <= 20; i++) {
    try {
      const res = await fetch(HEALTH);
      if (res.ok) {
        const board = await res.json();
        console.log(`\nヘルスチェック ok: ${HEALTH}`);
        console.log(`  attachments=${board.attachments} llmRefused=${board.llmRefused} tasks=${board.tasks?.length}`);
        return;
      }
    } catch {
      // まだ起動していないだけ。待つ
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`起動を確認できない (${HEALTH})。journalctl -u ${SERVICE} -n 50 を見ること`);
}

async function confirm() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question("反映する? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (a !== "y" && a !== "yes") {
    console.log("やめた");
    process.exit(0);
  }
}
