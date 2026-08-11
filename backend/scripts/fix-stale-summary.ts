// Done要約カードに残った「検収待ち」等の途中状態を、要約し直して消す。
//
// summary は「いま何が起きているか」を書く欄なので、Doneに入った時点で中身が過去のものになる。
// 要約の材料にそのまま渡していたため、「完了し、現在は検収待ちの状態である」という要素が
// 生成されていた。プロンプトとキー名を直したので、既存カードを作り直す。
//
//   確認だけ: npx tsx scripts/fix-stale-summary.ts
//   実際に直す: npx tsx scripts/fix-stale-summary.ts --fix
import { regenerateCard } from "../src/archive.js";
import { listSummaryCards } from "../src/db.js";
import { listProjects, withProject } from "../src/store.js";

const STALE = /検収待ち|レビュー中|承認待ち|検収を待|レビューを待/;
const doFix = process.argv.includes("--fix");

const targets: { projectId: number; projectName: string; cardId: number; title: string; text: string }[] = [];

for (const p of listProjects()) {
  try {
    withProject(p.id, () => {
      for (const card of listSummaryCards()) {
        for (const el of card.elements) {
          if (STALE.test(el.text)) {
            targets.push({ projectId: p.id, projectName: p.name, cardId: card.id, title: card.title, text: el.text });
          }
        }
      }
    });
  } catch (e: any) {
    console.log(`project ${p.id} (${p.name}): 読めませんでした — ${e?.message ?? e}`);
  }
}

if (targets.length === 0) {
  console.log("途中状態が残っている要約カードはありません");
  process.exit(0);
}

console.log(`${targets.length}件の要素に途中状態が残っています:\n`);
for (const t of targets) {
  console.log(`  project ${t.projectId} (${t.projectName}) / card#${t.cardId} 「${t.title}」`);
  console.log(`    ${t.text}\n`);
}

if (!doFix) {
  console.log("--fix を付けると、これらのカードを要約し直します (LLM呼び出しが走ります)");
  process.exit(0);
}

const cards = [...new Map(targets.map((t) => [`${t.projectId}:${t.cardId}`, t])).values()];
for (const t of cards) {
  await withProject(t.projectId, async () => {
    console.log(`再生成中: project ${t.projectId} / card#${t.cardId} …`);
    const after = await regenerateCard(t.cardId);
    for (const el of after?.elements ?? []) console.log(`    ${STALE.test(el.text) ? "!!" : "OK"} ${el.text}`);
  });
}
console.log("\n完了");
