# ChatBan — プロジェクトガイド

AI HACK 2026 提出作品。「会話がそのままタスク管理になる」かんばん+チャットの二層UI。
AIはレコメンドのみ、確定は人間承認 (human-in-the-loop)。提出締切: 2026-08-15 15:00。

## 構成とポート

```
backend/   Express + Socket.IO + better-sqlite3 (port 8787)
           OpenAI SDK (base_url=OrcaRouter) の tool use ループ — src/chat.ts
           MCPサーバー (Streamable HTTP) — src/mcp.ts → POST /mcp
           全LLM呼び出しを llm_calls テーブルに記録 — GET /api/metrics
frontend/  Vite + React + TS + Tailwind v4 + dnd-kit (port 5173、/api と /socket.io は8787へproxy)
```

E2E専用: backend 8799 / frontend 5199 / DB e2e-test.db (開発サーバーと共存可)

## 起動・テスト

```powershell
.\start-dev.ps1                        # DBバックアップ→両サーバー起動→ヘルスチェック
cd frontend; npm run test:e2e          # Playwright E2E (LLM呼び出しなし)
cd backend; npx tsc --noEmit           # 型チェック (frontendも同様)
```

- **起動順序: backend → Claude Code**。chatban MCP (.mcp.json) はセッション起動時にbackendが生きていないと接続失敗する
- devサーバーはClaude Codeのバックグラウンドで飼わない (セッション再起動で道連れになる)。start-dev.ps1で独立起動
- backendの再起動はプロセスツリーごと止めること。ポートのListenプロセスだけ殺すとtsx watchの親が残りEADDRINUSEループになる

## APIキー・モデル

- OrcaRouter APIキー: 環境変数 `ORCAROUTER_API_KEY` または `~\.orcarouter\apikey.txt` (1行)。**キーの値をチャットやログに出さない**
- モデルは用途別 (Day2実測で決定): 対話=`anthropic/claude-haiku-4.5`固定 / 要約分解=`orcarouter/auto` / 定型=`orcarouter/fusion-mini`。env `ORCA_MODEL_MAIN` / `ORCA_MODEL_ARCHIVE` / `ORCA_MODEL_CHEAP` で上書き可
- モデルIDは `provider/model` 形式必須 (`gpt-4o-mini` 等は model_not_found)

## 開発運用 (ドッグフーディング)

- **ChatBan自体の改修タスクは ChatBan のボードで管理する**。MCPツール (`mcp__chatban__*`) で登録→担当Claude→実装→done。障害級の問題だけチャット直
- **タスクdone = 1コミット**。コミットメッセージは `#<taskId> <要約>` 形式
- テストは頼まれなくても積極的に書く。実装がたまったら `test:e2e` を流す
- 委任割り振りは propose_assignments 経由 (人間の承認を待つ)。直接assigneeを書き換えるのは指名されたときだけ
- デバッグは `backend/logs/chatban-YYYY-MM-DD.log` (リクエスト/LLM往復/ツール実行/切断が全部残る)

## 注意

- DB (chatban.db) はSQLite直接編集しない。REST/MCP経由で操作する (Socket.IOブロードキャストと履歴記録が飛ぶため)
- chatban.db はドッグフーディングの実録データ (記事の一次資料)。start-dev.ps1 が起動時に backend/backup/ へ自動バックアップする
- リポジトリは提出直前 (8/15) にPublic化する。それまでに実データ・接続情報を混入させない
