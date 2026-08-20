import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildTools, TOOL_LABELS } from "./chat.js";

// #229: **道具の表示名が、実際の道具立てと合っているか**の番人。
//
// 実際にこう壊れていた:
//   - 進捗表示 (backend) と trace のチップ (frontend) に `set_view` が載っていた。
//     そんな道具は無い (execTool の switch にも buildTools にも出てこない)
//   - frontend にはさらに `compact_archive` / `get_task_details` が残っていた。
//     #200 で要約カードを撤去したときの取り残し
//   - 逆に `query_log` など4本が frontend に無く、**画面に生の英語名が出ていた**
//     (`TOOL_LABELS[t.tool] ?? t.tool` のフォールバックが働くので、誰も気づかない)
//
// #218 の番人はプロンプトを見ているが、**画面に出るラベルは見ていなかった。**
// 「撤去したのに気づけない」の別の面なので、同じやり方で機械に見張らせる。
//
// **正解は buildTools() が持っている。**道具を増減すればそちらが動くので、
// 表のほうが取り残されたときにここが鳴る。
// SDKの型は function 以外の道具も許すユニオンなので、function だけを取る
const toolNames = () =>
  new Set(buildTools([]).flatMap((t) => (t.type === "function" ? [t.function.name] : [])));

/** frontend の表はソースから読む。**あちらにユニットの基盤が無い** (Playwright だけ) ので、
 * テストのために vitest を持ち込むより、1つのオブジェクトリテラルを読むほうが軽い。
 * 抽出できなければ落とす — 黙って0件になると「揃っている」と誤読される */
function frontendLabelKeys(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "..", "..", "frontend", "src", "components", "Chat.tsx");
  const src = fs.readFileSync(file, "utf-8");
  const block = /const TOOL_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, `${file} から TOOL_LABELS を読めない。定義の書き方が変わった可能性がある`);
  const keys = [...block[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 0, "frontend の TOOL_LABELS が空に見える (抽出に失敗している)");
  return keys;
}

for (const [where, keys] of [
  ["進捗表示 (backend)", Object.keys(TOOL_LABELS)],
  ["trace のチップ (frontend)", frontendLabelKeys()],
] as const) {
  test(`${where} に、存在しない道具が載っていない`, () => {
    const names = toolNames();
    const ghosts = keys.filter((k) => !names.has(k));
    assert.deepEqual(ghosts, [], `${where} に実在しない道具がある: ${ghosts.join(", ")}`);
  });

  test(`${where} が、実在する道具を取りこぼしていない`, () => {
    const missing = [...toolNames()].filter((n) => !keys.includes(n));
    // 取りこぼすと画面には生の英語名が出るだけで落ちない。だから機械に見張らせる
    assert.deepEqual(missing, [], `${where} に足りない道具がある: ${missing.join(", ")}`);
  });
}
