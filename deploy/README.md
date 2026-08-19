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
| `chatban.service` | 本体。`DEMO_MODE=on` で公開デモの既定値が入る (#213) |
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
