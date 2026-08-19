#!/usr/bin/env node
/**
 * ChatBan のセットアップ (#192)。README の手順1〜3をこれ1本にまとめたもの。
 *
 *   node setup.mjs              対話。依存導入 → 宛先を選んで config.json を作る → キーの置き場を案内
 *   node setup.mjs --provider openai   対話なし (宛先を引数で決める)
 *   node setup.mjs --check      設定が実際に通るか確かめるだけ (LLMへ小さく投げる)
 *
 * **Nodeの標準機能だけで書く。**依存を入れる前に動く必要があるので、npm パッケージを import しない。
 * `.mjs` にしてあるのは、ルートに package.json が無く `type: module` を宣言できないため。
 *
 * **キーは扱わない (2026-08-18 zio判断)。**このスクリプトがやるのは config.json を置くところまでで、
 * キーの中身は受け取らない (置き場所を表示するだけ)。#184 で Codex に10周指摘されたのは全部
 * 「キーを受け取って書く」の周辺 (仮ファイルの後始末、権限、リダイレクトの先出しtruncate、空判定) で、
 * **受け取らなければその穴は最初から無い**。利便性は下がるが、増えるのは人間の1操作だけ。
 */
import { spawn } from "node:child_process";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** better-sqlite3 のビルド済みバイナリと、backend/frontend の実装が前提にしている下限 */
export const MIN_NODE_MAJOR = 20;

/** 見本 (backend/examples/) と一対一。ここに並べた順で番号が振られる。
 *
 * **見本が消えたらここも直す。**#202 で `config.local.json` (Ollama) が削除されたとき、
 * ここに ollama が残っていたので `--provider ollama` が必ず「見本が見つかりません」で落ちた。
 * 並行した2つのPRがそれぞれ自分の中では正しく、gitも衝突として検出しない形だったので、
 * **setup.test.ts で実ファイルの存在を確かめる**ようにしてある (次は同じ形で気づける) */
export const PROVIDERS = [
  { key: "openai", label: "OpenAI", file: "config.openai.json", note: "実測済み。キーが要ります" },
  { key: "anthropic", label: "Anthropic", file: "config.anthropic.json", note: "キーが要ります。プロンプトキャッシュが効きます" },
  { key: "orcarouter", label: "OrcaRouter", file: "config.orcarouter.json", note: "1つのキーで多くのモデル。無料枠は429で埋まります" },
];

/** `~/...` をホームディレクトリへ展開する。backend/src/config.ts の同名関数と同じ規則。
 * **わざと2箇所に書いている** — このスクリプトは依存導入の前に動くので、backend のコードを import できない。
 * 挙動がズレると「案内されたパスに置いたのに読まれない」という分かりにくい失敗になるので、テストで固める */
export function expandHome(p, home = homedir()) {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/** 実行中のNodeが要件を満たすか。`v22.16.0` / `22.16.0` のどちらの書き方でも見る */
export function isSupportedNode(version, min = MIN_NODE_MAJOR) {
  const m = /^v?(\d+)\./.exec(String(version));
  return m ? Number(m[1]) >= min : false;
}

/** 宛先の選択を解釈する。番号 (`1`) でも名前 (`openai`) でも通す。
 * **決められなかったときは null を返し、呼び出し側が聞き直す** — 曖昧な入力を既定値へ倒さない
 * (「Enterで既定」にすると、読まずに進んだ人がキーの要る構成を引く) */
export function parseProviderChoice(input, providers = PROVIDERS) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const i = Number(s) - 1;
    return i >= 0 && i < providers.length ? providers[i] : null;
  }
  return providers.find((p) => p.key === s) ?? null;
}

/** config.json を読んで、キーの状態を判定する。
 * - `not-needed`: apiKey が直に書いてある (キーをファイルに逃がさない書き方)
 * - `present` / `missing`: apiKeyFile の指す先があるか
 * - `unknown`: どちらも無い (見本を編集して壊した場合。ここでは直さず、check に任せる) */
export function keyStatus(config, exists = existsSync, home = homedir()) {
  if (config?.apiKey) return { kind: "not-needed" };
  if (!config?.apiKeyFile) return { kind: "unknown" };
  const file = expandHome(config.apiKeyFile, home);
  return { kind: exists(file) ? "present" : "missing", file };
}

/** 引数の解釈。未知のフラグは黙って捨てない (打ち間違いに気づけないため) */
export function parseArgs(argv) {
  const out = { check: false, provider: null, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--provider") out.provider = argv[++i] ?? "";
    else if (a.startsWith("--provider=")) out.provider = a.slice("--provider=".length);
    else out.unknown.push(a);
  }
  return out;
}

const USAGE = `使い方:
  node setup.mjs                    対話でセットアップする
  node setup.mjs --provider openai  宛先を指定して対話なしで進める
  node setup.mjs --check            設定が通るか確かめる (LLMへ小さく投げます)

宛先: ${PROVIDERS.map((p) => p.key).join(" / ")}`;

function say(s = "") {
  process.stdout.write(s + "\n");
}

/** 子プロセスを走らせて、終了コードを返す。**出力はそのまま流す** —
 * npm の進捗やエラーを握り潰すと、失敗したときに何が起きたか分からなくなる */
function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    // Windows の npm は npm.cmd なので shell 経由でないと ENOENT になる。
    // 引数は固定文字列だけなので、シェルに渡して困るものは無い
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function installDeps() {
  for (const dir of ["backend", "frontend"]) {
    const at = path.join(ROOT, dir);
    if (existsSync(path.join(at, "node_modules"))) {
      say(`  ${dir}: 依存は入っています (入れ直すなら node_modules を消してから)`);
      continue;
    }
    say(`  ${dir}: npm install ...`);
    const code = await run("npm", ["install"], at);
    if (code !== 0) {
      say(`\n  ${dir} の npm install が失敗しました (終了コード ${code})。上の出力を見てください。`);
      return false;
    }
  }
  return true;
}

/** 宛先を決める。**引数で渡された場合の検証は main が先に済ませてある** —
 * ここで見ると、打ち間違いを npm install が終わってから怒ることになる (実機で踏んだ) */
async function chooseProvider(given) {
  if (given) return given;
  if (!process.stdin.isTTY) {
    say("対話できない環境なので、宛先を引数で渡してください: node setup.mjs --provider openai");
    return null;
  }
  say("\nどの宛先を使いますか?");
  for (const [i, p] of PROVIDERS.entries()) say(`  ${i + 1}) ${p.label} — ${p.note}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // 3回まで聞き直す。無限に聞くと、パイプ越しに走らせたときに止まらなくなる
    for (let i = 0; i < 3; i++) {
      const answer = await rl.question("> ");
      const p = parseProviderChoice(answer);
      if (p) return p;
      say("番号か名前で答えてください。");
    }
    return null;
  } finally {
    rl.close();
  }
}

/** config.json を用意する。**既にあれば絶対に触らない** —
 * 中に自分で書いたキーやモデルIDが入っている可能性があり、上書きは取り返しがつかない */
async function ensureConfig(givenProvider) {
  const dest = path.join(ROOT, "backend", "config.json");
  if (existsSync(dest)) {
    say("  backend/config.json は既にあります (触りません)");
    return true;
  }
  const provider = await chooseProvider(givenProvider);
  if (!provider) return false;
  const src = path.join(ROOT, "backend", "examples", provider.file);
  if (!existsSync(src)) {
    say(`  見本が見つかりません: ${src}`);
    return false;
  }
  copyFileSync(src, dest);
  say(`  backend/config.json を作りました (${provider.label} の見本から)`);
  return true;
}

function readConfig() {
  const dest = path.join(ROOT, "backend", "config.json");
  try {
    return JSON.parse(readFileSync(dest, "utf8"));
  } catch {
    return null;
  }
}

/** キーの置き場を案内する。**受け取らない。**中身を聞かないので、
 * 端末のエコーもシェル履歴も仮ファイルも関わらない (#184 の指摘10件はすべてこの周辺だった) */
function reportKey(config) {
  const st = keyStatus(config);
  if (st.kind === "not-needed") {
    say("  APIキーは要りません (設定に直接書いてあります)");
    return true;
  }
  if (st.kind === "unknown") {
    say("  apiKey も apiKeyFile も設定に見当たりません。backend/config.json を見直してください");
    return false;
  }
  if (st.kind === "present") {
    say(`  APIキーのファイルがあります: ${st.file}`);
    return true;
  }
  say(`\n  APIキーをこのファイルに1行で置いてください:\n    ${st.file}`);
  say("  (このスクリプトはキーを受け取りません。置いたら node setup.mjs --check で確かめられます)");
  return false;
}

function reportNext(keyReady) {
  say("\n次にやること:");
  if (!keyReady) say("  1. 上のパスにAPIキーを置く");
  say(`  ${keyReady ? "1" : "2"}. node setup.mjs --check   ← 宛先・キー・モデルIDが揃っているか確かめる`);
  if (process.platform === "win32") {
    say(`  ${keyReady ? "2" : "3"}. .\\start-dev.ps1          ← 起動`);
  } else {
    say(`  ${keyReady ? "2" : "3"}. 別々のターミナルで cd backend && npm run dev / cd frontend && npm run dev`);
  }
  say("\n起動したら http://localhost:5173 を開きます (8787 はAPI側です)。");
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    say(USAGE);
    return 0;
  }
  if (args.unknown.length) {
    say(`知らない引数です: ${args.unknown.join(" ")}\n\n${USAGE}`);
    return 1;
  }
  // 宛先の綴りは、時間のかかる処理に入る前に見る。
  // 依存導入 (数分) のあとで「分かりません」と言うと、打ち直しにその時間ぶん付き合わせることになる
  const provider = args.provider === null ? null : parseProviderChoice(args.provider);
  if (args.provider !== null && !provider) {
    say(`宛先 "${args.provider}" が分かりません。${PROVIDERS.map((x) => x.key).join(" / ")} のどれかです。`);
    return 1;
  }
  if (!isSupportedNode(process.version)) {
    say(`Node ${MIN_NODE_MAJOR} 以上が要ります (いまは ${process.version})。https://nodejs.org から入れてください。`);
    return 1;
  }
  // ルート以外から実行されるとパスが全部ずれるので、ここで気づかせる
  if (!existsSync(path.join(ROOT, "backend", "package.json"))) {
    say("リポジトリのルートに setup.mjs が見当たりません。clone したディレクトリで実行してください。");
    return 1;
  }

  if (args.check) {
    if (!existsSync(path.join(ROOT, "backend", "config.json"))) {
      say("backend/config.json がありません。先に node setup.mjs を実行してください。");
      return 1;
    }
    say("設定を確かめます (設定されたモデルへ小さなリクエストを投げます)...\n");
    return await run("npx", ["tsx", "scripts/check-config.ts"], path.join(ROOT, "backend"));
  }

  say(`ChatBan のセットアップ\n  Node ${process.version} OK\n`);
  if (!(await installDeps())) return 1;
  if (!(await ensureConfig(provider))) return 1;
  const config = readConfig();
  if (!config) {
    say("  backend/config.json を読めませんでした (JSONとして壊れています)");
    return 1;
  }
  reportNext(reportKey(config));
  return 0;
}

// テストから import したときに main が走らないようにする (Node 20 に import.meta.main は無い)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
