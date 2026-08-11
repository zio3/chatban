// モデルカタログを単価順に見る。比較対象を選ぶとき用。
//   npx tsx scripts/list-models.ts [絞り込み語]
import { fetchModelCatalog } from "../src/llm.js";

const filter = process.argv[2]?.toLowerCase();
const all = await fetchModelCatalog();
const rows = all
  .filter((m) => m.inputPerM != null && m.outputPerM != null)
  .filter((m) => !filter || m.id.toLowerCase().includes(filter))
  // アーカイブ要約は出力が2,800tk前後なので、出力単価で効く
  .sort((a, b) => (a.outputPerM ?? 0) - (b.outputPerM ?? 0));

console.log(`${all.length}件中 ${rows.length}件 (出力単価の安い順)\n`);
console.log(`${"model".padEnd(42)}${"in $/M".padStart(8)}${"out $/M".padStart(9)}   ctx`);
for (const m of rows.slice(0, 30)) {
  console.log(
    `${m.id.padEnd(42)}${(m.inputPerM ?? 0).toFixed(2).padStart(8)}${(m.outputPerM ?? 0).toFixed(2).padStart(9)}   ${m.contextLength ?? "?"}`
  );
}
