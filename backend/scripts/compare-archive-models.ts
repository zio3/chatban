// アーカイブ要約を、どのモデルでやるのが妥当かの比較。
//
// 問い (zio): 「これ蒸留するだけだから、そんなに賢くないモデルでもよかったりしない?」
//             「ルーティングが時間かかってない?」
//
// 分かったこと (2026-08-11):
//  - ルーティング自体は遅くない。同じモデルに行き着けば直指定とほぼ同じ時間
//  - 遅さの正体は出力トークン。思考型は要素5個を書くのに3,000〜14,000tk 使う
//  - 質は速度に比例しない。中間帯(40〜60秒)が一番割に合わなかった
//  - deepseek(100秒/14,153tk) と orcarouter/auto(43〜80秒・毎回行き先が変わる) は候補から外した
//
// DBは書き換えない。buildDecomposeMessages で本番と同じ材料を作り、複数モデルへ
// 並列に投げて、時間と結果だけ集める (プロンプトの二重管理を避けるため関数を共有)。
//
//   npx tsx scripts/compare-archive-models.ts <projectId> <cardId,cardId,...> [--models a,b,c]
import fs from "node:fs";
import { buildDecomposeMessages } from "../src/archive.js";
import { getSummaryCard, tasksOfCard } from "../src/db.js";
import { chatCompletion } from "../src/llm.js";
import { withProject } from "../src/store.js";

const projectId = Number(process.argv[2] ?? 1);
const cardIds = (process.argv[3] ?? "6").split(",").map(Number);
const argModels = process.argv.includes("--models")
  ? process.argv[process.argv.indexOf("--models") + 1].split(",")
  : null;

const MODELS = argModels ?? [
  "openai/gpt-5.6-luna", // out $1.20 — 実測10秒/980tk。候補
  "openai/gpt-5.6-terra", // 同帯 — 実測9秒/757tk。候補
  "openai/gpt-5.4-mini-2026-03-17", // 現行の対話モデル (比較の基準)
  "openai/gpt-5-mini", // out $2.00 — 24秒/2,724tk
  "anthropic/claude-opus-4.8", // out $25.00 — 30秒/1,138tk。内容の正確さの上限を見る用
  "orcarouter/fusion-mini", // 現行の cheap スロット (比較の基準)
];

interface Run {
  model: string;
  sec: number;
  routed?: string | null;
  inTk?: number;
  outTk?: number;
  text?: string;
  error?: string;
}

const cards = await withProject(projectId, async () => {
  const acc: { id: number; title: string; taskCount: number; rejected: number; inputChars: number; messages: any[]; runs: Run[] }[] = [];
  for (const cardId of cardIds) {
    const card = getSummaryCard(cardId);
    if (!card) {
      console.log(`project ${projectId} に card#${cardId} がありません`);
      continue;
    }
    const tasks = tasksOfCard(cardId);
    const rejected = tasks.filter((t) => t.rejected).length;
    const { messages } = buildDecomposeMessages(tasks, card.elements.filter((e) => e.checked).map((e) => e.text));
    const inputChars = messages.reduce((a, m) => a + m.content.length, 0);

    console.log(`\n=== card#${cardId} 「${card.title}」 ${tasks.length}件 (却下${rejected}件) / 入力 ${inputChars}字`);
    const runs: Run[] = await Promise.all(
      MODELS.map(async (model) => {
        const t0 = Date.now();
        try {
          const res = await chatCompletion("probe-archive", model, { messages }, { timeoutMs: 300_000 });
          return {
            model,
            sec: (Date.now() - t0) / 1000,
            routed: (res as any).model ?? null,
            inTk: res.usage?.prompt_tokens ?? 0,
            outTk: res.usage?.completion_tokens ?? 0,
            text: res.choices[0].message.content ?? "",
          };
        } catch (e: any) {
          return { model, sec: (Date.now() - t0) / 1000, error: e?.message ?? String(e) };
        }
      })
    );
    runs.sort((a, b) => a.sec - b.sec);
    for (const r of runs) {
      if (r.error) {
        console.log(`  ${r.model.padEnd(32)}${r.sec.toFixed(1).padStart(7)}   NG: ${r.error.slice(0, 50)}`);
      } else {
        // 出力の妥当性をその場で機械チェックできる範囲だけ見る (質の判断は人間)
        let items: string[] = [];
        try {
          const t = r.text ?? "";
          items = JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1));
        } catch {
          /* 形式違反 */
        }
        const okForm = Array.isArray(items) && items.every((x) => typeof x === "string");
        const kyakka = items.filter((x) => typeof x === "string" && x.includes("【却下】")).length;
        const flag = !okForm ? " 形式NG" : rejected === 0 && kyakka > 0 ? ` 却下誤付与${kyakka}` : "";
        console.log(
          `  ${r.model.padEnd(32)}${r.sec.toFixed(1).padStart(7)}${String(r.outTk).padStart(8)}tk  ${okForm ? `${items.length}要素` : "-"}${flag}`
        );
      }
    }
    acc.push({ id: cardId, title: card.title, taskCount: tasks.length, rejected, inputChars, messages, runs });
  }
  return acc;
});

const out: string[] = [];
out.push(`# アーカイブ要約 モデル比較 — project ${projectId}`);
out.push("");
out.push("同じ材料を各モデルへ並列に投げた結果。材料の作り方は本番と同じ (buildDecomposeMessages を共有)。");
out.push("");
for (const c of cards) {
  out.push(`## card#${c.id}「${c.title}」 — ${c.taskCount}件 (却下${c.rejected}件) / 入力 ${c.inputChars}字`);
  out.push("");
  out.push("| model | 秒 | 出力tk | 実際に走ったモデル |");
  out.push("|---|---:|---:|---|");
  for (const r of c.runs) {
    out.push(r.error ? `| ${r.model} | ${r.sec.toFixed(1)} | | NG: ${r.error.slice(0, 60)} |` : `| ${r.model} | ${r.sec.toFixed(1)} | ${r.outTk} | ${r.routed ?? ""} |`);
  }
  out.push("");
  out.push("<details><summary>投げた材料</summary>");
  out.push("");
  for (const m of c.messages) {
    out.push(`**${m.role}** (${m.content.length}字)`);
    out.push("");
    out.push(m.role === "user" ? "```json" : "```");
    out.push(m.role === "user" ? JSON.stringify(JSON.parse(m.content), null, 2) : m.content);
    out.push("```");
    out.push("");
  }
  out.push("</details>");
  out.push("");
  for (const r of c.runs) {
    if (r.error) continue;
    out.push(`### ${r.model}  (${r.sec.toFixed(1)}秒 / ${r.outTk}tk)`);
    out.push("");
    out.push("```");
    out.push((r.text ?? "").trim());
    out.push("```");
    out.push("");
  }
  out.push("---");
  out.push("");
}
const dest = "C:/Users/info/Downloads/chatban-archive-model-comparison.md";
fs.writeFileSync(dest, out.join("\n"), "utf-8");
console.log(`\n結果: ${dest}`);
