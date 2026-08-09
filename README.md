# ChatBan — 会話がそのままタスク管理になる

AI HACK 2026 提出作品。チャット(下)とかんばんボード(上)の二層UI。
「候補挙げて」「登録して」「残りいい感じに振っといて」が通じる。
AIはレコメンドのみ、確定は人間承認 (human-in-the-loop)。

## 構成

```
backend/   Express + Socket.IO + better-sqlite3
           OpenAI SDK (base_url = OrcaRouter) の tool use ループ
           LLM呼び出しは全件 llm_calls テーブルに記録 (/api/metrics)
frontend/  Vite + React + TS + Tailwind v4 + dnd-kit + socket.io-client
```

## 起動

APIキー: 環境変数 `ORCAROUTER_API_KEY`、または `~/.orcarouter/apikey.txt` に配置。

```bash
cd backend && npm i && npm run dev    # http://localhost:8787
cd frontend && npm i && npm run dev   # http://localhost:5173 (api/wsは8787へproxy)
```

## テスト

```bash
cd frontend && npm run test:e2e   # Playwright (ボードのD&D・更新フローのスモークE2E)
```
E2Eは専用ポート(backend:8799 / frontend:5199)と専用DB(e2e-test.db)で動くため、開発サーバーと共存できる。

モデルは環境変数で差し替え可能:
- `ORCA_MODEL_MAIN` (default: `anthropic/claude-sonnet-5`) — 対話・割り振り判断
- `ORCA_MODEL_CHEAP` (default: `deepseek/deepseek-v4-flash-free`) — 定型処理用
- `ORCA_BASE_URL` (default: `https://www.orcarouter.ai/v1`) — 1行でプロバイダ差し替え
