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
- モデルは用途別: 対話=`openai/gpt-5.4-mini-2026-03-17`固定 / 要約分解=`orcarouter/auto` / 定型=`orcarouter/fusion-mini`。env `ORCA_MODEL_MAIN` / `ORCA_MODEL_ARCHIVE` / `ORCA_MODEL_CHEAP` で上書き可。**実行時の切り替えは⚙設定タブから** (#88、再起動不要)
- 対話モデルは**日付つきスナップショットIDで固定する**。プロンプトキャッシュはモデルごとに別物なので、エイリアスや`orcarouter/auto`だとキャッシュが乗らない (「プレフィックスを安定させる」だけでは足りず「モデルを固定する」が対になる)
- モデルIDは `provider/model` 形式必須 (`gpt-4o-mini` 等は model_not_found)

## 開発運用 (ドッグフーディング)

- **ChatBan自体の改修タスクは ChatBan のボードで管理する**。MCPツール (`mcp__chatban__*`) で登録→実装→review。障害級の問題だけチャット直
- **担当者は責任を持つ人間。Claudeを担当者にしない**。依頼元の人間を担当者のままにし、実装したのがClaudeであることは経緯メモに書く (「実装完了 (commit xxx)」)。AIは道具であって責任主体ではない — 「AIは提案、確定は人間」と同じ線引き
- **4列は同じ重みではない**: Todo/Inprogressは「人間がステータスを気にしたいときに振り分ける箱」程度の緩い扱い (着手のたびにInprogressへ動かさなくてよい。長くかかるものだけ置くと意味が出る)。Reviewは退場ゲート、Doneは人間の検収のみ
- **完了はreview検収経由 (#57)**: 実装が終わったら status=review に置く (doneにしない)。done は人間 (zio) の検収のみ。Doneは「置き場」でなく「検収の結果」
- **Reviewに置くとき検収エビデンスを経緯メモ(context)に添付する (#66/#92)**: 実測結果・コミットID・スクショ(docs/evidence/)・未検証項目の明示。人間は根拠を見て✓するだけにする
- **3つの欄を使い分ける (#92)**: `summary`=AIとユーザーに極力短く状況や次の判断を促す1行(カードに出る。Reviewなら `実装完了 (commit xxx)` のように確認先を添える) / `reason`=なぜこの担当か(パネルのみ) / `context`=経緯と検収エビデンスの詳細。**contextは末尾に「## 経過」を作っておく** — 前半を固定して経過だけ伸ばせば `context_append` で1行ずつ足せる(節で細かく構造化すると追記が節の外に付き、毎回全文を書き直すことになる)。reasonに進捗を書かない — 以前MCP側のツール契約にreasonの説明が無く、用途不明の文字列欄に見えたため進捗を書き込んで汚した。**ツール契約のdescriptionはエージェントにとってのUIラベル**であり、入口(チャット/MCP)で契約がズレると入口ごとに違う汚れ方をする
- **タスク1件 = 1コミット**。コミットメッセージは `#<taskId> <要約>` 形式
- テストは頼まれなくても積極的に書く。実装がたまったら `test:e2e` を流す
- 割り振りはその場で確定して一覧で報告する (#128で承認UIは廃止)。判断材料が足りないときだけチャットで案を出して聞く
- デバッグは `backend/logs/chatban-YYYY-MM-DD.log` (リクエスト/LLM往復/ツール実行/切断が全部残る)

## 将来案 (実装していない・思いつきの置き場)

- **Doneカードのまとめレンジを段階的に上げる (#105の延長)**: いまは「検収バッチごと → 1日経ったらその日1枚 → 手動整頓で全部1枚」の3段階。これを日→週→月→四半期→年と自動で上げていくと、何年運用しても常駐する要約カードの枚数が対数的にしか増えない。実装は `rollUpOldCards()` の日付グルーピングをレンジ可変にするだけ

## 注意

- DB (chatban.db) はSQLite直接編集しない。REST/MCP経由で操作する (Socket.IOブロードキャストと履歴記録が飛ぶため)
- chatban.db はドッグフーディングの実録データ (記事の一次資料)。start-dev.ps1 が起動時に backend/backup/ へ自動バックアップする
- リポジトリは提出直前 (8/15) にPublic化する。それまでに実データ・接続情報を混入させない
