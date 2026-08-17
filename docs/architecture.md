# ChatBan アーキテクチャ / 技術スタック

更新: 2026-08-17 / AI HACK 2026 提出作品 (ハッカソン後も個人利用のツールとして更新中)
「会話がそのままタスク管理になる」かんばん+チャットの二層UI。人間の確定が要るのは影響の大きい操作だけで、Doneへ至る経路は人間の検収ただ1本 (詳細は docs/security.md §6)。

## 全体構成

```
┌─ ブラウザ (React SPA) ─────────────────────────────────────┐
│  /p/<projectId> が表示中のプロジェクトを持つ (#97)          │
│  Board(かんばん4列) / Chat(常設) / TaskDetailPanel(タスクチャット) │
│  📋前提 / 📊コスト / 📜監査 / 🗑ゴミ箱 / ⚙設定               │
└──────┬────────────────────────────┬────────────────────────┘
       │ /api (REST)                │ /socket.io
       │ X-ChatBan-Project ヘッダ    │ ?project=<id> でroom参加
┌──────▼────────────────────────────▼────────────────────────┐
│  backend: Express + Socket.IO (port 8787)                   │
│  ├ chat.ts      LLM tool useループ (14ツール)                │
│  ├ promptState  イベントログ型プロンプト+TTL再ベースライン     │
│  ├ archive.ts   Doneアーカイブ→要約カード蒸留 (3段階の粒度)   │
│  ├ store.ts     プロジェクト=SQLiteファイル / 処理単位スコープ │
│  ├ mcp.ts       MCPサーバー (POST /mcp/:projectId)           │
│  └ db.ts        アクティブなプロジェクトDBへの操作            │
└──────┬────────────────────────────┬────────────────────────┘
       │ OpenAI SDK                  │ MCP (Claude Code等の外部エージェント)
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
| ルーティング | なし (`location.pathname` を読むだけ) | `/p/<id>` の1形式しかないのでReact Routerは過剰 |
| バック | Express + tsx watch | 最小構成、ホットリロード |
| DB | better-sqlite3 (プロジェクトごとに1ファイル) | 同期APIで簡潔。マイグレーションはALTER+try/catch流儀 |
| LLM | OpenAI SDK → OrcaRouter | OpenAI互換。モデルIDは `provider/model` 形式必須 |
| MCP | @modelcontextprotocol/sdk | Streamable HTTP (stateless、リクエスト毎に接続構築) |
| E2E | Playwright | 専用ポート8799/5199+専用データディレクトリで開発サーバーと共存 |

## プロジェクト = SQLiteファイル (#86)

`project_id` 列で分けるのではなく、**ファイルごと分離**している。

```
backend/data/
  chatban-admin.db          projects / settings / llm_calls(+project_id)
  projects/<id>-<名前>.db   tasks / summary_cards / chat_messages / project_context
  trash/                    削除したプロジェクトの退避先 (実体は消さない)
```

理由:

- **タスクの #ID がプロジェクトごとに1から始まる**。#IDは会話の語彙(「#7を後回し」)なので、
  2桁で収まることが手触りに直結する。通し番号だと #247 になり口に出せなくなる
- 全クエリに `WHERE project_id` を書く必要がない = **絞り忘れが構造的に起きない**。
  混ざったボード索引をLLMが読むと誤った提案をするが、人間はそれに気づけない
- 複製・削除・受け渡しがファイル操作で済む (デモ用に作って捨てるのが楽)
- 実録データと他案件が物理的に別ファイルになり、公開時の混入リスクを管理しやすい

`llm_calls` だけ管理DBに置く。コストは口座単位で見るのが正しく、プロジェクト別内訳も出せる。
スキーマは `ensureProjectSchema()` がDBを開くたびに流すので、新規作成と既存の移行が同じ経路を通る。

### 「いまどのプロジェクトか」は接続が決める

サーバーに隠れた「表示中のプロジェクト」を持たない。入口ごとに接続が対象を宣言する:

| 入口 | 決め方 |
|---|---|
| ブラウザ | URL `/p/<id>`。タブごとに別プロジェクトを開ける・F5で戻らない・URLを渡せる |
| MCP (エージェント) | 接続URL `/mcp/<projectId>`。ツール引数には出さない (引数が増えるほどLLMは迷う) |
| curl・スクリプト | `X-ChatBan-Project` ヘッダ。無ければ既定プロジェクト |

サーバー側は `AsyncLocalStorage` で処理単位のスコープを持つ (`withProject(id, fn)` / `currentProjectId()`)。
**非同期フックはリクエスト終了後に走る**ので、呼ばれた時点のIDを捕まえて中で入り直す —
これをやらないと「プロジェクト3のタスクを完了 → プロジェクト1の要約カードに合流」という静かな事故が起きる。
Socket.IOの配信もプロジェクト単位のroomへ送る。

## LLMモデル戦略 (用途別)

| 用途 | モデル | 理由 |
|---|---|---|
| 対話 (chat / suggest) | `openai/gpt-5.4-mini-2026-03-17` 固定 | 応答速度が生命線 + 自動キャッシュが実額に効く |
| 要約の要素分解 (archive-decompose) | `orcarouter/auto` | 品質が肝・非同期でレイテンシ許容(60〜80秒)→ルーティング委任 |
| 定型 (archive-title) | `orcarouter/fusion-mini` | コスト優先ルーティング。20秒でタイムアウトさせる |

- **⚙設定タブから実行時に切り替えられる** (#88)。`getModel(slot)` が呼び出しごとにDBを引くので再起動不要
- 対話モデルは**日付つきスナップショットIDで固定する**。キャッシュはモデルごとに別物なので、
  エイリアスや `orcarouter/auto` だとキャッシュが乗らない
- 埋め込みモデルも同じ理由で固定が必要(モデルが変わるとベクトル空間が変わり、既存インデックスが無意味になる)。
  `orcarouter/auto` が embeddings を対象外にしているのは制限ではなく正しい設計
- env `ORCA_MODEL_MAIN` / `ORCA_MODEL_ARCHIVE` / `ORCA_MODEL_CHEAP` で既定値を上書き可
- APIキー: env `ORCAROUTER_API_KEY` または `~\.orcarouter\apikey.txt` (1行)。**値をログ・チャットに出さない**
- 全LLM呼び出しは `llm_calls` に記録 (purpose/model/routed_model/tokens/cached/elapsed/project_id)

## プロンプト設計 (コスト工学、詳細は cost-engineering-log.md)

- **静的前置・動的後置**: 人格/行動ルール/設計思想を先頭固定 (キャッシュはプレフィックス一致)
- **イベントログ型 (#50)**: ボード状態=基準スナップショット(バイト不変)+差分イベント追記。
  TTL5分/40件/日付変化で再ベースライン
- **索引+遅延詳細**: 常駐はタスク索引のみ。詳細は `query_log` で必要な列だけ取得
- **メタ情報は動的末尾に置く**: 発言者(#95)・いま見ている画面(#93)。
  本文に混ぜるとLLMがタスクのタイトルへ書き写す事故が起きたため、「書き写すな」と添えて末尾に置く。
  末尾ならキャッシュのプレフィックスを崩さない
- 結果: 1ターン0.2〜0.3円 / 0.9〜1.5秒

## データモデル (プロジェクトDB)

- `tasks`: title / status(todo・inprogress・review・done固定4列) /
  **summary**(いまどうなっているか。カードに出る) /
  context(経緯メモ) / **context_version**(経緯メモの楽観ロック) / due / blocked_by(依存) / rejected(却下) /
  sort / archived / summary_card_id / **trashed_at**(ゴミ箱)
- `summary_cards`: Done要約カード (elements JSON, settled=過去ログ化済み)
- `chat_messages`: 会話永続化 (task_id NULLがメイン、値ありがタスクチャット)
- `project_context`: そのプロジェクトの前提 (プロンプトに常駐)

#179 で担当者・割り振りを廃止し (個人利用に特化)、`tasks.assignee` / `assign_reason` と
`members` / `proposals` / `assignment_history` は**列・テーブルごと落とした**。
読まないだけにして残すと、SQL窓口を広げた誰かが集計に使い、廃止したはずの軸が復活する。

かつて `assign_reason` と `summary` を分けていたのは、以前 `reason` 1つに「なぜこの担当か」と
「実装完了 (commit xxx)」が混ざり、カードが読めなくなったため。
原因はMCP側のツール契約に `reason` の説明が無く、**エージェントから見て用途不明の文字列欄**
だったこと。担当者ごと消えたので欄も無くなったが、教訓のほうは残る —
ツール契約のdescriptionはエージェントにとってのUIラベルにあたる。

## 状態フロー (退場ゲートは1つ)

```
チャットで登録 (UIに新規作成フォームは無い)
   ↓
todo → inprogress → review ←─ 完了報告も却下(rejected)もここに集まる
  (ゆるい箱)          │  人間の検収 (チェック→「検収済みN件をDoneへ」一括)
                      ▼
                    done → 自動アーカイブ → 要約カードに蒸留
                             ↓
                     [削除] → 🗑ゴミ箱 (復元可。実体を消せるのはゴミ箱画面から)
```

- **4列は同じ重みではない**: Todo/Inprogressは「人間がステータスを気にしたいときに振り分ける箱」程度。
  Reviewは退場ゲート、Doneは人間の検収のみ (チャットからdoneへ直行する経路はコードで塞いである)
- **DoneへのD&Dは禁止、Doneからの持ち出しも禁止**。検収後アーカイブ完了まで15〜30秒あり、
  その間に持ち出すと「todoなのにボードから消える」幽霊タスクができるため
- **削除は論理削除**。自然言語UIでは解釈ミスが必ず起きる(「消せますか?」がタスク削除と解釈された)ので、
  間違えないようにするのではなく**間違えても取り返しがつく**形にした

## Doneアーカイブの粒度 (#105)

粒度が時間とともに粗くなる3段構え:

| いつ | 粒度 | タイトル | 引き金 |
|---|---|---|---|
| 直近 | 検収バッチごと | 内容ラベル(「プロジェクト分離まわり」) | 検収を押すたび |
| 1日経過 | その日1枚 | 日付ラベル(「8/10の完了」) | 次の完了時に自動 |
| 任意 | 全部で1枚 (settled) | 日付ラベル | 手動整頓 (`compact_archive`) |

- 人間が「このまとまりを完了にする」と決めた単位がそのまま粒度になり、恣意的な閾値がない
- **分けるのは後からできないが統合はできる**ので細かい側に倒す
- 再要約は常にカード配下のタスク原本から行う → 劣化コピー問題が構造的に起きない。
  `context`(経緯メモ)も渡すので「なぜそうしたか」が要約に残る
- 要素を先に保存してからタイトルを付ける。**高い処理(要素分解)の成果を、
  安い処理(タイトル生成)の成否に人質に取らせない**

## 日時の扱い (#108)

日時は**オフセットを持たない文字列** (`2026-08-10 21:12:06`) で保存している。SQLite には
DateTimeOffset に相当する型が無く (TEXT/INTEGER/REAL/BLOB/NULL のみ)、日時はただの文字列なので、
**全レコードが同じ基準であることをアプリ側が保証する**しかない。オフセット付きで書けば SQLite の
日付関数は正しく解釈するが、`ORDER BY` や `WHERE` は素の文字列比較なので、基準が混ざると壊れる
(LLMにSQLを書かせる設計では致命的)。

基準を決めているのは**プロセス起動時のタイムゾーン**で、起動後は変えられない。
`process.env.TZ` を後から書き換えると **JS側だけ変わり、SQLite の `datetime('now','localtime')`
は変わらない** ため、同じ行の隣り合う列が8時間ずれる — UTC運用より悪い状態になる。

さらに Windows では **SQLite(MSVC)と Node が別の TZ 形式を要求する**:

| `TZ` | SQLite | Node |
|---|---|---|
| `Asia/Tokyo` | +01:00 ✗ (IANA名を解さず誤パース) | +09:00 ✓ |
| `JST-9` | +09:00 ✓ | +00:00 ✗ |
| 未設定 | +09:00 ✓ | +09:00 ✓ |

つまり **Windows は「TZ を設定しない」が正解、Linux は `TZ=Asia/Tokyo` が正解**と真逆になる。

時刻生成をJS側の1関数へ寄せる案もあったが、18箇所の書き換えは提出直前には重い。
**「直す」のではなく「壊れた状態で動かさない」**を選び、起動時に SQLite と JS の両方で
オフセットを測り、想定 (既定 `+09:00`、`CHATBAN_TZ_OFFSET` で変更可) と違えば
理由と直し方を出して `process.exit(1)` する (`backend/src/timezone.ts`)。

## チャットのツール (13)

`create_tasks` / `update_tasks` / `delete_tasks`(ゴミ箱行き) / `restore_tasks` /
`update_task_context` / `reorder_tasks` /
`search_tasks` / `query_log` / `compact_archive` / `update_project_context` / `set_view`

**読み取りは `query_log` (SQL) に寄せている (#108)**。人間のWebUIは画面が決まっているので
固定のクエリ関数を使うが、チャット/MCPは「何をどう見たいか」が毎回違うのでSQLを組ませる。
`get_task_details` / `get_activity` / `list_*` は廃止した — 同じものが
`SELECT ... FROM tasks WHERE id=112` や `ORDER BY updated_at DESC` で引ける。
一覧を専用ツールで返すと経緯メモが全文ついてきて重い (実測18,553字。SQLなら3,334字)

**「判断はLLM、整合性はコード」** という形が繰り返し現れる:

- `reorder_tasks` は**LLMが決めた順番(ID列)** を受け取る。ソートキーを渡す方式では
  「重要そうな順」「軽そうな順」が表現できないため。書き忘れ/重複/他列のIDはコードが正規化する
- `search_tasks` は**LLMが表記ゆれを展開した複数語** を受け取ってOR検索する。
  「DBを分ける」と「ファイル分離」が近いことを知っているのはLLMなので、
  埋め込みインデックスを外に持つ必要がない

安全装置はプロンプトでなくツール契約に書く:
`update_tasks` は done 指定を review へ強制変換し、実際に値が変わったフィールドだけを通す
(全フィールドをエコーバックするモデルだと既存値が壊れるため)。

## インフラ / 開発運用

- **ローカル単機**: backend 8787 / frontend 5173 (Viteが /api と /socket.io を8787へproxy)
- **スマホ実機**: Tailscale経由 `https://<machine>.ts.net/` (tailnet内のみ)。
  Viteは `host: true` なのでtailnet IP直打ちでも届く
- 起動: `.\start-dev.ps1` (data/配下を世代バックアップ→両サーバー起動→ヘルスチェック)。
  **起動順序: backend → Claude Code** (chatban MCPの接続のため)
- **バックアップはSQLiteのオンラインバックアップAPI経由** (`backend/scripts/backup-data.mjs`)。
  WALモードではファイルコピーだと直近の書き込みが落ちる
- E2E: `cd frontend; npm run test:e2e` (8799/5199, `e2e-data/`, AUTO_ARCHIVE=0)。
  実行前に `e2e/clean-db.mjs` がデータを消す (残すとタスクが積み上がりD&Dの座標がずれる)
- ログ: `backend/logs/chatban-YYYY-MM-DD.log` (リクエスト/LLM往復/ツール実行/切断/再ベースライン)
- 分析スクリプト: `scripts/cost-estimate.mjs` (自前コスト概算 vs 公式請求) /
  `scripts/billing-probe.mjs` (カタログ単価が実額と一致するかの検証)
- DB直接編集は禁止 (REST/MCP経由 — Socket.IO配信と履歴記録が飛ぶため)
- リポジトリ: **8/15提出直前までPrivate**。コミット毎push=スナップショット運用

## 外部エージェント連携 (MCP)

```json
// .mcp.json — プロジェクトごとにエントリを分けられる
{ "mcpServers": {
  "chatban": { "type": "http", "url": "http://localhost:8787/mcp/1" }
} }
```

ツール (10): `sync_board` / `create_tasks` / `update_tasks` / `delete_tasks` /
`restore_tasks` / `reorder_tasks` / `search_tasks` /
`query_log` / `get_project_context` / `update_project_context`

- `sync_board` が手持ちの認識を最新に合わせる口 (#150/#187)。**同期トークン**を渡すと
  そこからの差分だけが返り、渡さなければ全件。トークンが失効していても失敗せず、黙って全件に落ちる。
  書き込み系にも `sync_token` を渡せて、その応答に `boardChanges` が相乗りする —
  **間違えているエージェントは差分を取りに行こうと思っていない**ので、必ず通る書き込みに載せる
- プロジェクトの前提情報は `projectContextVersion` (版) だけが返る。本文は `get_project_context`。
  3,000字級の本文がボードを取るたびに乗っていた (#186/#187)
- プロジェクト未指定 (`POST /mcp`) は **400**。フォールバックすると事故の原因が残り続けるため。
  MCPの接続失敗はクライアント側で潰れて見えなくなるので、直し方と利用可能プロジェクト一覧を
  サーバーログとレスポンスの両方に出す
- `get_project_context` が接続の足場 — 対象プロジェクト(接続URLで固定)と前提情報を返す。
  SQL窓口はプロジェクトDBしか見えないので、どのプロジェクトに向いているかはここでしか確認できない
- 設計方針: **内蔵チャットは安い定型操作に徹し、横断的な統合判断は使う人のエージェント(BYO Agent)に委ねる**
  (#55却下の決定)
