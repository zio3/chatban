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
  // #262: **`chat_messages` を外した。**行も表も残っているが、SQLの窓口からは引けない。
  //
  // > チャットの話から、絞るは不要。というかやりません。**ツールの思想にない方向ですね** (zio)
  //
  // **ここ1本で3か所に効く** — #168 の許可リスト (db.ts) / 説明の「引けるもの:」行 (chat.ts) /
  // ログの伏せ字 (mcpLog.ts)。**入口ごとに違う一覧を持たない**のが「MCPからだけ外す」案を
  // 採らなかった理由で、それを作ると CLAUDE.md が繰り返し事故と呼ぶ
  // 「入口で契約がズレると入口ごとに違う汚れ方をする」形を、自分から作ることになる。
  //
  // 会話をキーワードで引く経路は `search_cards` に残っている (db.ts の `chatHits`)。
  // 失うのは「時期や条件で絞る」だけ。
  "project_context",
];

/** #252: `PUBLIC_TABLES` に出てくる列名の全部。**ログにSQLを残すときの許可リスト**で使う
 * (`mcpLog.ts` の `redactSql` — ここに無い語は `?` に潰す)。
 *
 * **schemaの現物と合っているかは `publicColumns.test.ts` が pragma と突き合わせる。**
 * ズレても壊れはせず、**知らない語が `?` になって読みにくくなる**だけ (鈍る方に倒れる)。 */
// #262: `chat_messages` を外したので、その専用列 (card_id / content / role / trace / usage) も落とした。
// **この一覧は「引ける表の列」**であって、DBに在る列の一覧ではない。
export const PUBLIC_COLUMNS: readonly string[] = [
  "archived",
  "blocked_by",
  "checked_at",
  "context",
  "context_version",
  "created_at",
  "done_at",
  "done_day",
  "due",
  "id",
  "project_id",
  "rejected",
  "sort",
  "sort_key",
  "status",
  "summary",
  "text",
  "title",
  "trashed_at",
  "updated_at",
  "version",
];
