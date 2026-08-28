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
sudo env PATH=/opt/node/bin:$PATH node backend/scripts/deploy-demo.mjs   # 確認あり
sudo systemctl start chatban-reset.service          # 毎朝と同じもの (デプロイ + リセット)
```

PATH を渡すのは、sudo が secure_path で PATH を作り直すため
(`/opt/node/bin` に node を置いていると npm が見つからない)。`sudo -E` で渡す手も
あるが、**サーバーによっては "preserving the entire environment is not supported" で
無視される** (miniPC で実際に踏んだ `#269`) ので、`sudo env PATH=...` の形が確実。
root で走らせると git が dubious ownership で止まることがある — そのときは
`sudo git config --global --add safe.directory /opt/chatban/app` を一度入れる。

## 反映したか確かめる

```sh
curl https://chatban.zio3.net/version.txt   # 動いているコミット。-dirty なら手で触った版
curl https://chatban.zio3.net/api/board     # attachments: 公開デモの期待値は false (DEMO_MODE の既定)
```

**ただし false は DEMO_MODE の証拠ではない。**`canAcceptAttachments()` が false を返すのは
明示の `CHATBAN_ATTACHMENTS=off`、`apiStyle: "messages"` (Messages API 形式の添付は未対応)、
または **config.json の読み込み・検証の失敗** (ファイルが無い・JSON不正・キー未読を含む) の
いずれかで、DEMO_MODE はその1つ目に乗っているだけ。逆に個人運用は、chat 形式で
`CHATBAN_ATTACHMENTS` を切っていなければ true が期待値 (messages 形式なら false が正常)。
miniPC の据え付けでは false を「DEMO_MODE では?」と誤診しかけ、実際は config が
placeholder のままキー未投入だった (`#269`)。

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

初回の据え付け (レイアウトはデモと同じ /opt/chatban/{app,data,home})。
**順序に意味がある**: unit は `User=chatban` で動き、`ReadWritePaths` に挙げた
data / home / backend/logs が**起動前に実在しないと systemd が unit を落とす**
(自動では作らない。特に backend/logs は gitignore 対象なので clone には入っていない)。
だから「ユーザーを作る → ディレクトリを作って渡す → chatban として build する」の順で進める:

```sh
# 1. 動かすユーザーと器 (data/home は unit の ReadWritePaths が要求する)
sudo useradd --system --home-dir /opt/chatban/home --shell /usr/sbin/nologin chatban
sudo mkdir -p /opt/chatban/data /opt/chatban/home

# 2. 取得。以降の npm install / build / config は所有者の chatban で行う
#    (root で clone したまま進めると、非rootの npm install が書込権限で失敗する)
sudo git clone https://github.com/zio3/chatban /opt/chatban/app
sudo mkdir -p /opt/chatban/app/backend/logs   # gitignore 対象で clone に無い。無いと unit が起動しない
sudo chown -R chatban:chatban /opt/chatban
sudo -u chatban env PATH=/opt/node/bin:$PATH sh -c \
  'cd /opt/chatban/app/backend && npm install && cd ../frontend && npm install && npm run build'

# 3. 接続設定。examples からコピーして宛先とキーを書く (git 管理外)
sudo -u chatban cp /opt/chatban/app/backend/examples/config.openai.json /opt/chatban/app/backend/config.json
sudo -e /opt/chatban/app/backend/config.json   # 宛先とキーを書く
sudo chown chatban:chatban /opt/chatban/app/backend/config.json
sudo chmod 600 /opt/chatban/app/backend/config.json

# 4. unit を入れて起動
sudo cp /opt/chatban/app/deploy/chatban-personal.service /etc/systemd/system/chatban.service
# CHATBAN_ALLOWED_ORIGINS に公開ホスト名のオリジンを入れる (unit 内のコメント参照)
sudo systemctl daemon-reload && sudo systemctl enable --now chatban
```

確認: `journalctl -u chatban -n 3` に `(フロントも配信: ...)` が出ること。
`(APIのみ...)` なら dist が無い = フロントのビルドを忘れている。

更新 (デモの `deploy-demo.mjs` を共用。ヘルスチェックの宛先だけ差し替える。
`sudo -E` を使わないのは上のデモ節と同じ理由。非対話で流すときだけ `echo y |` を頭に付ける):

```sh
cd /opt/chatban/app && sudo env PATH=/opt/node/bin:$PATH CHATBAN_HEALTH_URL=http://127.0.0.1:8787/api/board node backend/scripts/deploy-demo.mjs
```

**データのバックアップはこのリポジトリの外** (運用側の夜間バックアップ) に登録すること。
`/opt/chatban/data` と `backend/config.json` が対象。
