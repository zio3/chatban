// 自前計測(llm_calls)のコストレポート: purpose別・モデル別・ルーティング先別
import Database from "better-sqlite3";
import { join } from "node:path";
// #179: llm_calls は data/chatban-admin.db (管理DB) へ移っている。
// 旧構成の単一 chatban.db を読んでいたころの名残で、そのままでは
// 「ファイルが無くて失敗」か「凍結された古いデータを現在値として集計」になる (自動レビュー指摘)
const ADMIN_DB = process.env.CHATBAN_ADMIN_DB ?? join(process.env.CHATBAN_DATA_DIR ?? "data", "chatban-admin.db");
const db = new Database(ADMIN_DB, { readonly: true });

const total = db.prepare(
  "SELECT COUNT(*) c, SUM(prompt_tokens) pt, SUM(completion_tokens) ct, CAST(AVG(elapsed_ms) AS INT) avgMs FROM llm_calls"
).get();
console.log(`TOTAL: ${total.c} calls, in=${total.pt} tk, out=${total.ct} tk, avg=${total.avgMs}ms\n`);

console.log("--- purpose別 ---");
for (const r of db.prepare(
  "SELECT purpose, COUNT(*) c, SUM(prompt_tokens) pt, SUM(completion_tokens) ct, CAST(AVG(elapsed_ms) AS INT) avgMs FROM llm_calls GROUP BY purpose ORDER BY pt DESC"
).all()) {
  console.log(`${r.purpose.padEnd(18)} ${String(r.c).padStart(3)}回  in=${String(r.pt).padStart(7)}  out=${String(r.ct).padStart(6)}  avg=${r.avgMs}ms`);
}

console.log("\n--- 実ルーティング先別 ---");
for (const r of db.prepare(
  "SELECT COALESCE(routed_model,'?') m, COUNT(*) c, SUM(prompt_tokens) pt, SUM(completion_tokens) ct, CAST(AVG(elapsed_ms) AS INT) avgMs FROM llm_calls GROUP BY routed_model ORDER BY pt DESC"
).all()) {
  console.log(`${r.m.padEnd(28)} ${String(r.c).padStart(3)}回  in=${String(r.pt).padStart(7)}  out=${String(r.ct).padStart(6)}  avg=${r.avgMs}ms`);
}
