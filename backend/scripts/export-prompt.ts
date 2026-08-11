// LLMへ実際に送っているプロンプトを、レビューしてもらえる1ファイルに書き出す。
//
// logs/last-request-chat.json は機械向けで読みにくいので、人(と別のLLM)が読んで
// 「削るならどこか」を判断できる形にする。中身は加工しない — 要約すると
// 判断材料が変わるので、実物をそのまま出す。
//
//   使い方: cd backend && npx tsx scripts/export-prompt.ts [projectId] [出力先]
import fs from "node:fs";
import { buildSystemPrompt, tools } from "../src/chat.js";
import { withProject } from "../src/store.js";

const projectId = Number(process.argv[2] ?? 9);
const outPath = process.argv[3] ?? "../../chatban-prompt-for-review.md";
const TK = 1.7; // 日本語混じりGPT系の実測比。正確な値はAPIのusage
const tk = (s: string) => Math.round(s.length / TK);

withProject(projectId, () => {
  const sys = buildSystemPrompt(undefined, "zio", "board", false);
  const toolList = tools.map((t: any) => ({ name: t.function.name, json: JSON.stringify(t.function, null, 2), chars: JSON.stringify(t.function).length }));
  const toolTotal = toolList.reduce((a, t) => a + t.chars, 0);
  const total = sys.length + toolTotal;

  const out: string[] = [];
  out.push("# ChatBan — 対話1回ぶんの入力プロンプト（実物）");
  out.push("");
  out.push("かんばん + チャットのタスク管理ツールで、チャット欄から自然言語でボードを操作できる。");
  out.push("以下は、ユーザーが1回発言したときにLLMへ実際に送っている全文（会話履歴とユーザー発言を除く）。");
  out.push("");
  out.push("**相談したいこと: 入力トークンを減らしたい。削れるところ・まとめられるところはどこか。**");
  out.push("");
  out.push("判断の材料として:");
  out.push("- モデルは `openai/gpt-5.4-mini` 固定。プロンプトキャッシュが効くよう、静的な内容を先頭に固定している");
  out.push("- ボードの索引は毎回変わる（タスクが増減する）。それ以外はほぼ不変");
  out.push("- ツール定義は毎ラウンド送り直される（ツールを1回呼ぶと2ラウンドになる）");
  out.push("- 実測で、この規模だと1回の発言で往復あわせて約19,000トークンを送っている");
  out.push("");
  out.push("## サイズの内訳");
  out.push("");
  out.push("| | 字数 | 概算トークン | 割合 |");
  out.push("|---|---:|---:|---:|");
  out.push(`| システムプロンプト | ${sys.length} | ~${tk(sys)} | ${Math.round((sys.length / total) * 100)}% |`);
  for (const t of [...toolList].sort((a, b) => b.chars - a.chars)) {
    out.push(`| ツール定義: ${t.name} | ${t.chars} | ~${tk("x".repeat(t.chars))} | ${Math.round((t.chars / total) * 100)}% |`);
  }
  out.push(`| **合計** | **${total}** | **~${Math.round(total / TK)}** | |`);
  out.push("");
  out.push("---");
  out.push("");
  out.push("## システムプロンプト（全文）");
  out.push("");
  out.push("```");
  out.push(sys);
  out.push("```");
  out.push("");
  out.push("---");
  out.push("");
  out.push("## ツール定義（全文）");
  out.push("");
  out.push("OpenAI互換の function calling。`description` がそのままトークンになる。");
  out.push("");
  for (const t of toolList) {
    out.push(`### ${t.name} （${t.chars}字）`);
    out.push("");
    out.push("```json");
    out.push(t.json);
    out.push("```");
    out.push("");
  }

  fs.writeFileSync(outPath, out.join("\n"), "utf-8");
  console.log(`書き出しました: ${outPath}`);
  console.log(`  システムプロンプト ${sys.length}字 / ツール定義 ${toolTotal}字 / 合計 ${total}字 (~${Math.round(total / TK)} tk)`);
});
