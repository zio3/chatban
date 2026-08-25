/** #252: **SQLの窓口が公開している表と列。**
 *
 * **ここは何もimportしない。**#168 の許可リスト (db.ts) と、ログにSQLを残すときの
 * 許可リスト (mcpLog.ts) の両方から参照される契約なので、片方に置くともう片方が
 * その重さごと引き込む。
 *
 * 実際そうなった (Codexレビュー P1): `mcpLog.ts` から `db.ts` を import した結果、
 * `db.ts` → `store.ts` の連鎖でモジュール評価時に**日常用の管理DBが開き**、
 * `ensureAdminSchema()` の移行 (古い設定の DELETE / 旧テーブルの DROP) が走りうる状態になった。
 * **ログ整形の純粋関数を1つ import しただけで、実データに移行がかかる。**
 *
 * だから定数だけを、DBを開かないここに置く。 */
export const PUBLIC_TABLES: readonly string[] = [
  "cards",
  "live_cards",
  "done_cards",
  "chat_messages",
  "project_context",
];

/** #252: `PUBLIC_TABLES` に出てくる列名の全部。**ログにSQLを残すときの許可リスト**で使う
 * (`mcpLog.ts` の `redactSql` — ここに無い語は `?` に潰す)。
 *
 * **schemaの現物と合っているかは `publicColumns.test.ts` が pragma と突き合わせる。**
 * ズレても壊れはせず、**知らない語が `?` になって読みにくくなる**だけ (鈍る方に倒れる)。 */
export const PUBLIC_COLUMNS: readonly string[] = [
  "archived",
  "blocked_by",
  "card_id",
  "checked_at",
  "content",
  "context",
  "context_version",
  "created_at",
  "done_at",
  "done_day",
  "due",
  "id",
  "project_id",
  "rejected",
  "role",
  "sort",
  "sort_key",
  "status",
  "summary",
  "text",
  "title",
  "trace",
  "trashed_at",
  "updated_at",
  "usage",
  "version",
];
