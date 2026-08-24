import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// #247: 出力先を差し替えられるようにする。**テストが実ログに混ざると、この記録で数えたい
// 「どのツールが呼ばれているか」が狂う** (テストの sync_board と本物の sync_board は見分けが付かない)
const LOG_DIR = process.env.CHATBAN_LOG_DIR ?? "logs";
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
