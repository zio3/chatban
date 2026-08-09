// 一回限りの移行: 既存の未アーカイブDoneタスクをアクティブカードに合流させ、1回だけ再要約する
import { regenerateCard } from "../src/archive.js";
import { assignTaskToCard, getOrCreateActiveCard, listTasks } from "../src/db.js";

const done = listTasks().filter((t) => t.status === "done");
if (done.length === 0) {
  console.log("no unarchived done tasks");
  process.exit(0);
}
const card = getOrCreateActiveCard();
for (const t of done) assignTaskToCard(t.id, card.id);
console.log(`assigned ${done.length} tasks to card#${card.id}, regenerating...`);
const result = await regenerateCard(card.id);
console.log(`card#${card.id}: "${result?.title}"`);
for (const e of result?.elements ?? []) console.log(`  - ${e.text}`);
