# ChatBan アーキテクチャ / 技術スタック

作成: 2026-08-09 (Day2終盤時点) / AI HACK 2026 提出作品
「会話がそのままタスク管理になる」かんばん+チャットの二層UI。AIはレコメンドのみ、確定は人間 (human-in-the-loop)。

## 全体構成

```
┌─ ブラウザ (React SPA) ──────────────────────────────┐
│  Board(かんばん4列) / Chat(メイン) / TaskDetailPanel(タスクチャット)  │
│  MetricsView(📊) / AuditView(📜)                     │
└──────┬───────────────────────┬──────────────────────┘
       │ /api (REST)           │ /socket.io (リアルタイム反映)
┌──────▼───────────────────────▼──────────────────────┐
│  backend: Express + Socket.IO (port 8787)            │
│  ├ chat.ts      LLM tool useループ (10ツール)         │
│  ├ promptState  イベントログ型プロンプト+TTL再ベースライン │
│  ├ archive.ts   Doneアーカイブ→要約カード蒸留          │
│  ├ mcp.ts       MCPサーバー (POST /mcp, Streamable HTTP) │
│  └ db.ts        better-sqlite3 (chatban.db)          │
└──────┬───────────────────────┬──────────────────────┘
       │ OpenAI SDK             │ MCP (Claude Code等の外部エージェント)
┌──────▼────────────┐   「横断的な検討・実装はBYO Agent」
│  OrcaRouter (LLM)  │   ドッグフーディング: ChatBan自体の改修タスクを
│  base_url差し替えのみ │   ChatBanのボードでMCP経由管理
└───────────────────┘
```

## 技術スタック

| 層 | 技術 | 選定理由 |
|---|---|---|
| フロント | Vite + React 19 + TypeScript | AIで書きやすい+HMRの応答性 (VibeCoding適性) |
| スタイル | Tailwind CSS v4 | クラス直書きでAIの生成・修正が速い |
| D&D | dnd-kit | かんばんの列間移動・並び替え |
| リアルタイム | Socket.IO | ボード変更・ツール進捗・アーカイブ再生成の逐次配信 |
| バック | Express + tsx watch | 最小構成、ホットリロード |
| DB | better-sqlite3 (単一ファイル) | 同期APIで簡潔。マイグレーションはALTER+try/catch流儀 |
| LLM | OpenAI SDK → OrcaRouter | OpenAI互換。モデルIDは `provider/model` 形式必須 |
| MCP | @modelcontextprotocol/sdk | Streamable HTTP (stateless、リクエスト毎に接続構築) |
| E2E | Playwright | 専用ポート8799/5199+専用DBで開発サーバーと共存 |

## LLMモデル戦略 (用途別、Day2実測で決定)

| 用途 | モデル | 理由 |
|---|---|---|
| 対話 (chat) | `openai/gpt-5.4-mini` 固定 | 応答速度が生命線+自動キャッシュが実額に効く(85%減) |
| 要約分解 (archive-decompose) | `orcarouter/auto` | 品質が肝・非同期でレイテンシ許容(30秒OK)→ルーティング委任 |
| 定型 (archive-title) | `orcarouter/fusion-mini` | コスト優先ルーティング |

env `ORCA_MODEL_MAIN` / `ORCA_MODEL_ARCHIVE` / `ORCA_MODEL_CHEAP` で上書き可。
APIキー: env `ORCAROUTER_API_KEY` または `~\.orcarouter\apikey.txt` (1行)。**値をログ・チャットに出さない**。
全LLM呼び出しは `llm_calls` テーブルに記録 (purpose/model/routed_model/tokens/cached/elapsed) → 📊コストタブと `/api/metrics` で集計。

## プロンプト設計 (コスト工学、詳細は cost-engineering-log.md)

- **静的前置・動的後置**: 人格/行動ルール/設計思想を先頭固定 (キャッシュはプレフィックス一致)
- **イベントログ型 (#50)**: ボード状態=基準スナップショット(バイト不変)+差分イベント追記。TTL5分/40件/日付変化で再ベースライン
- **索引+遅延詳細**: 常駐はタスク索引(id/title/status/assignee/lane/due/dep/rejected)のみ。詳細は `get_task_details` で取得
- 結果: 1ターン0.2〜0.3円 / 0.9〜1.5秒 / キャッシュヒット86%+

## データモデル (主要テーブル)

- `tasks`: title/status(todo・inprogress・review・done固定4列)/assignee/reason/context(経緯メモ)/lane(demo・later)/due/blocked_by(依存)/rejected(却下)/sort/archived/summary_card_id
- `summary_cards`: Done要約カード (elements JSON, settled=過去ログ化済み)
- `chat_messages`: 会話永続化 (task_id NULLがメイン、値ありがタスクチャット)
- `proposals` + `assignment_history`: 割り振り提案とその履歴 (レコメンド根拠の学習素材)
- `llm_calls`: 全LLM呼び出しの計測
- `project_context`: チーム共通の前提 (プロンプトに常駐)

## 状態フロー (退場ゲートは1つ)

```
チャットで登録 (UIに新規作成フォームは無い)
   ↓
todo → inprogress → review ←─ 完了報告も却下(rejected)もここに集まる
                     │  人間の検収 (カードのチェック→「検収済みN件をDoneへ」一括 / チャット承認)
                     ▼
                   done → 自動アーカイブ → アクティブ要約カードに合流 (バッチ: N件でも再生成1回)
                            ↓ 🧹整頓 (compact_archive)
                          settled過去ログ (常に生タスクから再要約=薄まらない)
```

- DoneへのD&Dは禁止 (Doneは「置き場」でなく「検収の結果」)
- 割り振り: AIが propose_assignments → 人間が承認/却下 (完了検収と対称のhuman-in-the-loop)

## インフラ / 開発運用

- **ローカル単機**: backend 8787 / frontend 5173 (Viteが /api と /socket.io を8787へproxy)。クラウドデプロイなし (ハッカソン提出はローカルデモ)
- **スマホ実機**: vite `host: true` で `http://<PCのIP>:5173` からアクセス可 (#64)
- 起動: `.\start-dev.ps1` (DBバックアップ20世代→両サーバー起動→ヘルスチェック)。**起動順序: backend → Claude Code** (chatban MCPの接続のため)
- E2E: `cd frontend; npm run test:e2e` (8799/5199, e2e-test.db, AUTO_ARCHIVE=0で完了フック無効)
- ログ: `backend/logs/chatban-YYYY-MM-DD.log` (リクエスト/LLM往復/ツール実行/切断/再ベースライン)
- DB直接編集は禁止 (REST/MCP経由 — Socket.IO配信と履歴記録が飛ぶため)
- リポジトリ: github.com/zio3/chatban (**8/15提出直前までPrivate**。コミット毎push=スナップショット運用)

## 外部エージェント連携 (MCP)

`.mcp.json` で `http://localhost:8787/mcp` に接続。ツール: list_tasks / create_tasks / update_tasks / delete_tasks / propose_assignments / list_members / get_project_context / update_project_context / get_metrics。
設計方針: **内蔵チャットは安い定型操作に徹し、横断的な統合判断は使う人のエージェント(BYO Agent)に委ねる** (#55却下の決定)。
