// タスクのタイトルで全プロジェクトを横断検索する。どのプロジェクトの話か分からなくなったとき用。
//   npx tsx scripts/find-card.ts "外部FAQ"
import { listProjects, withProject } from "../src/store.js";
import { queryProjectData } from "../src/db.js";

const needle = process.argv[2] ?? "";
if (!needle) {
  console.log('使い方: npx tsx scripts/find-card.ts "検索語"');
  process.exit(1);
}

for (const p of listProjects()) {
  try {
    withProject(p.id, () => {
      const r = queryProjectData(
        `SELECT id, title, status, archived, substr(COALESCE(context,''),1,60) ctx FROM tasks WHERE title LIKE '%${needle.replace(/'/g, "''")}%' ORDER BY id`
      );
      if (r.rows.length > 0) {
        console.log(`\n=== project ${p.id} (${p.name}) — ${r.rows.length}件`);
        for (const row of r.rows as any[]) {
          console.log(`  #${row.id} ${row.title} [${row.status}${row.archived ? "/archived" : ""}]`);
          if (row.ctx) console.log(`      ${row.ctx}…`);
        }
      }
    });
  } catch (e: any) {
    console.log(`project ${p.id}: ${e?.message ?? e}`);
  }
}
