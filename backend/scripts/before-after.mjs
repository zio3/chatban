// アーカイブ実装(10:45頃)前後で、チャット1呼び出しの入力トークンがどう変わったか
import Database from "better-sqlite3";
import { join } from "node:path";
// #179: llm_calls は data/chatban-admin.db (管理DB) へ移っている。
// 旧構成の単一 chatban.db を読んでいたころの名残で、そのままでは
// 「ファイルが無くて失敗」か「凍結された古いデータを現在値として集計」になる (自動レビュー指摘)
const ADMIN_DB = process.env.CHATBAN_ADMIN_DB ?? join(process.env.CHATBAN_DATA_DIR ?? "data", "chatban-admin.db");
const db = new Database(ADMIN_DB, { readonly: true });
const rows = db
  .prepare(
    `SELECT CASE WHEN created_at < '2026-08-09 10:45' THEN 'before (Done常駐)' ELSE 'after (アーカイブ後)' END period,
            COUNT(*) c, CAST(AVG(prompt_tokens) AS INT) avgPt, MIN(prompt_tokens) minPt, MAX(prompt_tokens) maxPt
     FROM llm_calls WHERE purpose = 'chat' GROUP BY period ORDER BY period DESC`
  )
  .all();
for (const r of rows) console.log(`${r.period}: ${r.c}回  avg入力=${r.avgPt}tk (min=${r.minPt} / max=${r.maxPt})`);
