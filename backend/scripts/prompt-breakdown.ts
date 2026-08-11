// 1回の対話リクエストで、入力トークンを何が食っているかの内訳。
//
// 「入力が多い」はメトリクスから分かるが、何が多いかはソースを眺めても分からない。
// 実物を組み立てて数える。旧 prompt-breakdown.mjs はDBから近似を作っていて、
// lane(#107で廃止)を参照したまま古くなっていたので、実物を測る形に置き換えた。
//
//   使い方: cd backend && npx tsx scripts/prompt-breakdown.ts [projectId]
import { buildSystemPrompt, tools } from "../src/chat.js";
import { withProject } from "../src/store.js";

const projectId = Number(process.argv[2] ?? 1);

// 日本語混じりのGPT系トークナイザの実測比 (#49: 6.3k字 → 3.7k tk 前後)。
// 正確な値はAPIのusageで見る。ここは内訳の比率を見るための概算
const TK = 1.7;
const tk = (s: string) => Math.round(s.length / TK);

function row(name: string, s: string, note = "") {
  console.log(`${name.padEnd(28)}${String(s.length).padStart(7)} 字  ~${String(tk(s)).padStart(5)} tk  ${note}`);
}

withProject(projectId, () => {
  const sys = buildSystemPrompt(undefined, "zio", "board", false);
  const toolsJson = JSON.stringify(tools);

  console.log(`\n=== project ${projectId} / 1リクエストの入力内訳 ===\n`);

  // システムプロンプトを見出しで割る。動的セクション(索引・履歴・カード)がどれだけ
  // 占めているかが、そのままボードの成長コストになる
  const sections = sys.split(/\n(?=## )/);
  console.log("[システムプロンプト]");
  for (const sec of sections) {
    const head = sec.startsWith("## ") ? sec.slice(0, sec.indexOf("\n")).trim() : "(冒頭)";
    row(`  ${head}`, sec);
  }
  row("  --- 小計", sys);

  console.log("\n[ツール定義] (毎回そのまま送られる隠れ固定費)");
  for (const t of tools) {
    const fn = (t as any).function;
    row(`  ${fn.name}`, JSON.stringify(fn));
  }
  row("  --- 小計", toolsJson);

  const total = sys.length + toolsJson.length;
  console.log(`\n合計 ${total} 字 (~${Math.round(total / TK)} tk)`);
  console.log(
    `  システムプロンプト ${Math.round((sys.length / total) * 100)}% / ツール定義 ${Math.round((toolsJson.length / total) * 100)}%`
  );
  console.log("\n※ 実際のリクエストにはこれ + 会話履歴 + ユーザー発言が乗る。");
  console.log("※ ツールを1回呼ぶごとに、ツール結果と assistant メッセージが積まれて次のroundへ送られる。");
});
