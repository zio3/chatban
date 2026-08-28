# 公開デモの構成 (systemd)

公開デモ (https://chatban.zio3.net) を動かしている unit の**実物**です。
VPS の `/etc/systemd/system/` に置いてあるものと同じ内容を、ここで管理します。

## なぜリポジトリに置くか

**実装は表に出てよいものとして作る、という方針だからです** (2026-08-20)。
「見られたら困る設定」があるなら、それは設定の置き方のほうが間違っている、と考えます。

秘密はここに入りません。APIキーは `backend/config.json` (gitignore) にあり、unit は
それを知りません。ここにあるのはパス・ポート・既定値だけです。

**ここに書いてよくないもの**: 鍵・トークン・IPアドレス。
(ホスト名は README で公開しているデモのURLと同じなので、新たに何かを明かしてはいません)

## 中身

| ファイル | 役割 |
|---|---|
| `chatban.service` | 公開デモの本体。`DEMO_MODE=on` で公開デモの既定値が入る (#213) |
| `chatban-personal.service` | 個人運用の本体 (#268)。DEMO_MODE 無し・PORT=8787 |
| `chatban-reset.service` | 毎朝の処理。**デプロイ → 板のリセット** の順 (#214) |
| `chatban-reset.timer` | 05:00 JST |

## デプロイは pull 型

こちらから成果物を送りません。**VPS が GitHub から取ってきて、VPS の上でビルドします。**

```
手元 ── git push ──▶ GitHub ◀── git pull ── VPS ── npm install → build → restart
```

外から鍵を預ける先が無いので (CI に VPS の鍵を置かない)、この形にしています。

反映は毎朝のタイマーで自動に走ります。**急ぐときだけ手で叩きます**:

```sh
sudo -E node backend/scripts/deploy-demo.mjs        # 確認あり
sudo systemctl start chatban-reset.service          # 毎朝と同じもの (デプロイ + リセット)
```

`-E` は PATH を渡すため (sudo は secure_path で PATH を作り直すので、
`/opt/node/bin` に node を置いていると npm が見つからない)。

## 反映したか確かめる

```sh
curl https://chatban.zio3.net/version.txt   # 動いているコミット。-dirty なら手で触った版
curl https://chatban.zio3.net/api/board     # attachments が false なら DEMO_MODE が効いている
```

`version.txt` はビルドが作ります (`frontend/vite-plugin-version.ts`)。手で置かないこと —
次のビルドで消えます。

## 変えるとき

このディレクトリを直してから、VPS へコピーして `daemon-reload` します。
**VPS 側だけ直すと、ここと食い違ったまま誰も気づきません。**

```sh
sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo diff -r <(sudo cat /etc/systemd/system/chatban.service) deploy/chatban.service  # 食い違いを見る
```


## 個人運用 (自宅サーバー) — #268

デモと同じ形の pull 型で、**デプロイスクリプトも共用**します。違いは unit だけ
(`chatban-personal.service`: DEMO_MODE 無し / PORT=8787 / リセットタイマー無し)。

フロントは backend が配ります (`frontend/dist` があれば自動。#268 で追加)。
つまりプロセス1本・ポート 8787 の1本で、Caddy のような別のWebサーバーは要りません。
外へ出す口 (tailscale serve 等) は 127.0.0.1:8787 へ向けます。その設定と
ホスト名は運用側の手元に置き、このリポジトリには書きません。

初回の据え付け (レイアウトはデモと同じ /opt/chatban/{app,data,home}):

```sh
sudo mkdir -p /opt/chatban && cd /opt/chatban
sudo git clone https://github.com/zio3/chatban app
cd app/backend && npm install && cd ../frontend && npm install && npm run build && cd ..
# 接続設定。examples からコピーして宛先とキーを書く (git 管理外。600 で chatban が読めるように)
cp backend/examples/config.openai.json backend/config.json && $EDITOR backend/config.json
sudo cp deploy/chatban-personal.service /etc/systemd/system/chatban.service
# CHATBAN_ALLOWED_ORIGINS に公開ホスト名のオリジンを入れる (unit 内のコメント参照)
sudo systemctl daemon-reload && sudo systemctl enable --now chatban
```

確認: `journalctl -u chatban -n 3` に `(フロントも配信: ...)` が出ること。
`(APIのみ...)` なら dist が無い = フロントのビルドを忘れている。

更新 (デモの `deploy-demo.mjs` を共用。ヘルスチェックの宛先だけ差し替える):

```sh
sudo -E env CHATBAN_HEALTH_URL=http://127.0.0.1:8787/api/board   node backend/scripts/deploy-demo.mjs
```

**データのバックアップはこのリポジトリの外** (運用側の夜間バックアップ) に登録すること。
`/opt/chatban/data` と `backend/config.json` が対象。
