import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** #247/#253: **どこへ書くかを決める。**テストが実ログに混ざると、この記録で数えたい
 * 「どのツールが呼ばれているか」が狂う (テストの sync_board と本物の sync_board は
 * 見分けが付かない)。実測 2026-08-24: MCP呼び出し862件のうち728件がE2Eだった。
 *
 * **1件ずつ設定して回らない。**#247 では個々のテストに `CHATBAN_LOG_DIR` を書いたが、
 * 書き忘れたテストが実ログに書き続けていた (`test-model` や `reflect-key` の行が残っていた)。
 * 入口で塞ぐ。
 *
 * 判定に使う `NODE_TEST_CONTEXT` は **node の test runner が子プロセスに必ず立てる**もので、
 * `npm test` でも `npx tsx --test` でも効く。**npm script 側に書くと素通りされる** —
 * #194 で E2E のDB掃除を package.json に置いて実際に素通りした (56 → 112 → 224件と汚れた)。
 *
 * 出力先を `logs/` の下にするのは、`.gitignore` の `logs/` がそのまま効くから
 * (公開リポジトリなので、増やしたディレクトリが載らない形を選ぶ)。 */
export function resolveLogDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CHATBAN_LOG_DIR) return env.CHATBAN_LOG_DIR;
  return env.NODE_TEST_CONTEXT ? "logs/test" : "logs";
}

const LOG_DIR = resolveLogDir();
mkdirSync(LOG_DIR, { recursive: true });

function localParts(d = new Date()) {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`,
  };
}

// コンソールと logs/chatban-YYYYMMDD.log の両方に出す。チャット経路の追跡が目的
export function log(tag: string, message: string) {
  const { date, time } = localParts();
  const line = `[${date} ${time}] [${tag}] ${message}`;
  console.log(line);
  const file = join(LOG_DIR, `chatban-${date}.log`);
  try {
    appendFileSync(file, line + "\n");
  } catch {
    /* ログ書き込み失敗で本処理を落とさない */
  }
}
