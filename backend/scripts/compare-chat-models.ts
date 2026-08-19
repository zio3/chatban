// 対話モデル (main) を安いモデルに置き換えられるか (#210)。
//
// 問い (zio): 「Lunaで、チャットもこなせない?」
//
// **測るのは文章の出来ではなくツール呼び出し。**#190 の実測で、小さいモデルが最初に壊れるのは
// create_tasks で、壊れ方が「呼んでいないのに『登録しました』と報告する」という一番たちの悪い形だった。
// 文章だけ読むと通っているように見えるので、tool_calls が出たかどうかを機械で判定する。
//
// Luna はツール併用時 reasoning_effort='none' になる (llm.ts の NEEDS_REASONING_NONE) =
// **思考なしで動く**。対話はどのツールを呼ぶかを判断する経路なので、そこが効くかを見る。
//
// DBは書き換えない。ツールは**定義だけ渡して実行しない** (round 1 の tool_calls だけ見る)。
// プロンプトは本番と同じ buildSystemPrompt / buildTools から作る (二重管理を避ける)。
//
//   npx tsx scripts/compare-chat-models.ts [projectId] [--models a,b] [--n 5]
import { buildSystemPrompt, buildTools } from "../src/chat.js";
import { chatCompletion } from "../src/llm.js";
import { withProject, customLanes } from "../src/store.js";

const arg = (flag: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const projectId = Number(process.argv[2]?.startsWith("--") ? 1 : (process.argv[2] ?? 1));
const MODELS = (arg("--models") ?? "gpt-5.4-mini-2026-03-17,gpt-5.6-luna").split(",");
const N = Number(arg("--n") ?? 5);

/** expect: 呼ぶべきツール名。null は「呼ばないのが正解」(相談を勝手にタスク化しないか) */
const CASES: { label: string; user: string; expect: string | null }[] = [
  { label: "登録", user: "Chromebookで白飛びして読めない件、タスクに積んで", expect: "create_tasks" },
  { label: "完了報告", user: "#208 終わりました", expect: "update_tasks" },
  { label: "並べ替え", user: "#183 を todo の一番上に持ってきて", expect: "reorder_tasks" },
  { label: "集計", user: "今月どれくらい終わった? 件数だけ知りたい", expect: "query_log" },
  { label: "相談", user: "かんばんの列って4つで足りてると思う? どう思う?", expect: null },
];

interface Run { ok: boolean; called: string[]; args: string; sec: number; text: string; error?: string }

const results = await withProject(projectId, async () => {
  const system = buildSystemPrompt(undefined, "board");
  const tools = buildTools(customLanes());
  const acc: { model: string; case: string; runs: Run[] }[] = [];
  for (const model of MODELS) {
    for (const c of CASES) {
      const runs: Run[] = [];
      for (let i = 0; i < N; i++) {
        const t0 = Date.now();
        try {
          const res = await chatCompletion("compare-chat", model, {
            messages: [
              { role: "system", content: system },
              { role: "user", content: c.user },
            ],
            tools,
          });
          const msg = res.choices[0].message;
          const called = (msg.tool_calls ?? []).map((t: any) => t.function?.name).filter(Boolean);
          runs.push({
            ok: c.expect === null ? called.length === 0 : called.includes(c.expect),
            called,
            args: (msg.tool_calls ?? []).map((t: any) => t.function?.arguments ?? "").join(" | ").slice(0, 300),
            sec: (Date.now() - t0) / 1000,
            text: (typeof msg.content === "string" ? msg.content : "").slice(0, 160),
          });
        } catch (e: any) {
          runs.push({ ok: false, called: [], args: "", sec: (Date.now() - t0) / 1000, text: "", error: e?.message ?? String(e) });
        }
      }
      acc.push({ model, case: `${c.label} (期待: ${c.expect ?? "呼ばない"})`, runs });
      const hit = runs.filter((r) => r.ok).length;
      console.log(`${model.padEnd(28)} ${c.label.padEnd(6)} ${hit}/${N}  ${(runs.reduce((a, r) => a + r.sec, 0) / N).toFixed(1)}秒`);
    }
  }
  return acc;
});

console.log("\n=== 内訳 ===");
for (const r of results) {
  console.log(`\n## ${r.model} / ${r.case}`);
  for (const [i, run] of r.runs.entries()) {
    const mark = run.ok ? "OK " : "NG ";
    console.log(`  ${mark}${i + 1}: called=[${run.called.join(",")}] ${run.sec.toFixed(1)}秒${run.error ? ` ERROR=${run.error}` : ""}`);
    // 呼べているだけでは足りない。引数がボードの実物に合っているかまで見る (#190)
    if (run.args) console.log(`     引数: ${run.args}`);
    // NGのときだけ本文を出す。「呼んでいないのに登録したと報告する」壊れ方はここに出る
    if (!run.ok && run.text) console.log(`     本文: ${JSON.stringify(run.text)}`);
  }
}
