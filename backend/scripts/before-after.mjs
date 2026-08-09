// アーカイブ実装(10:45頃)前後で、チャット1呼び出しの入力トークンがどう変わったか
import Database from "better-sqlite3";
const db = new Database("chatban.db", { readonly: true });
const rows = db
  .prepare(
    `SELECT CASE WHEN created_at < '2026-08-09 10:45' THEN 'before (Done常駐)' ELSE 'after (アーカイブ後)' END period,
            COUNT(*) c, CAST(AVG(prompt_tokens) AS INT) avgPt, MIN(prompt_tokens) minPt, MAX(prompt_tokens) maxPt
     FROM llm_calls WHERE purpose = 'chat' GROUP BY period ORDER BY period DESC`
  )
  .all();
for (const r of rows) console.log(`${r.period}: ${r.c}回  avg入力=${r.avgPt}tk (min=${r.minPt} / max=${r.maxPt})`);
