# ChatBan — 会話がそのままタスク管理になる

**AI HACK 2026 提出作品。** かんばんとチャットの二層UIで、タスクの登録・割り振り・完了までを会話で回すタスク管理ツールです。AIは提案するだけ、確定はすべて人間 — human-in-the-loop を割り振り・完了検収・タスク登録の全フローに貫いています。

![ボード](docs/evidence/board-review-badges.jpg)

## コンセプト

- **タスクの新規作成はチャット専用** — UIに作成フォームはありません。「ログイン画面のバグ直さないと」と話すとカードが生えます。スクショやPDFを貼って話すこともできます(原本は保存されず、AIが読んだ意味だけが記録に残る)
- **AIはレコメンドのみ、確定は人間** — 割り振りはAIが負荷と実績を根拠に提案し、人間が承認。完了も「報告→Review→人間の検収チェック」を必ず通り、チャットからDoneへ直行する経路はコードレベルで存在しません
- **Doneは置き場ではなく蒸留装置** — 検収されたタスクは即アーカイブされ、AIが要約カードに蒸留します。却下した(=やらないと決めた)タスクも理由ごと要約に残ります。36タスクが5行に畳まれる様子は圧巻です
- **会話が構造の代わり** — ステータスは固定4列。優先度・タグ・サブタスクはありません。「これ上にして」「#11は#14待ち」と言えば済むものは属性にしない

## コストの話 (審査観点)

![コストメーター](docs/evidence/cost-meter.png)

**丸1日フル開発+ドッグフーディングで395回・2.0Mトークン → $2.88。** これは偶然ではなくコスト工学の結果です:

- 対話は `openai/gpt-5.4-mini` 固定 + 自動プロンプトキャッシュ (実測85%減)
- ボード状態は「基準スナップショット+差分イベント追記」でプレフィックスを安定させ、キャッシュTTL切れの瞬間に再ベースライン
- 完了はバッチ検収で要約再生成をまとめて1回に
- 品質が肝で非同期の要約は `orcarouter/auto`、定型はコスト優先ルーティング

1ターン0.2〜0.3円・応答0.9〜1.5秒。詳細は [docs/cost-engineering-log.md](docs/cost-engineering-log.md) (8円→0.2円の実測実録)。

## 技術スタック

| 層 | 技術 |
|---|---|
| フロント | Vite + React 19 + TypeScript + Tailwind CSS v4 + dnd-kit + Socket.IO |
| バック | Express + better-sqlite3 + OpenAI SDK (→ [OrcaRouter](https://www.orcarouter.ai)) |
| 外部連携 | MCPサーバー内蔵 (Claude Code等からボードを直接操作可能) |
| テスト | Playwright E2E |

アーキテクチャの全体像は [docs/architecture.md](docs/architecture.md)。

## 起動方法

前提: Node.js 20+ / OrcaRouter APIキー

```powershell
# APIキー設定 (どちらか)
$env:ORCAROUTER_API_KEY = "sk-orca-..."
# または ~/.orcarouter/apikey.txt に1行で保存

# 依存関係
cd backend; npm install; cd ../frontend; npm install; cd ..

# 起動 (Windows: DBバックアップ+両サーバー+ヘルスチェック)
.\start-dev.ps1

# 手動起動の場合
cd backend; npm run dev    # http://localhost:8787
cd frontend; npm run dev   # http://localhost:5173 (こちらを開く。/api と /socket.io は8787へproxy)
```

モデルは env で差し替え可能 (`provider/model` 形式):
- `ORCA_MODEL_MAIN` — 対話・割り振り判断 (default: `openai/gpt-5.4-mini-2026-03-17`)
- `ORCA_MODEL_ARCHIVE` — 要約の要素分解 (default: `orcarouter/auto`)
- `ORCA_MODEL_CHEAP` — 定型処理 (default: `orcarouter/fusion-mini`)
- `ORCA_BASE_URL` — 1行でプロバイダ差し替え (default: `https://www.orcarouter.ai/v1`)

## テスト

```bash
cd frontend
npm run test:e2e   # Playwright (D&D・検収フロー等のE2E。LLM呼び出しなし)
```

E2Eは専用ポート(backend:8799 / frontend:5199)と専用DB(e2e-test.db)で動くため、開発サーバーと共存できます。

## MCP連携 (ドッグフーディング)

ChatBan自体の開発タスクは、ChatBanのボードで管理しました。Claude Codeが内蔵MCPサーバー (`POST /mcp`) 経由でタスクを拾い、実装し、Reviewに置き、人間が検収する — 「作っているツールで、作っているツールのタスクを管理する」構図です。

```json
// .mcp.json
{ "mcpServers": { "chatban": { "type": "http", "url": "http://localhost:8787/mcp" } } }
```

設計方針として、内蔵チャットは安い定型操作に徹し、横断的な検討・実装はMCP越しの外部エージェント(あなたのClaude)に委ねます。

## 設計判断の記録

このリポジトリは「作った機能」と同じくらい「**作らないと決めた機能**」を大事にしています。カスタムステータス、カテゴリ別チャット、登録承認UI、アプリ内音声入力 — いずれも検討の末に理由つきで却下し、その判断自体がDoneの要約カードに蒸留されています。経緯は各ドキュメントと、ボードのアーカイブに実録として残っています。

---

開発実録: 実装期間は実質1日 (2026-08-09)。この日の全コミット・全会話・全LLM呼び出しがこのリポジトリと chatban.db に記録されています。
