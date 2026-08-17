import { io } from "socket.io-client";
import { projectIdFromUrl } from "./project";

// アプリ全体で共有するSocket.IO接続 (App/チャットフックが同じ接続にリスナーを張る)。
// #97/#99: 表示中のプロジェクトを接続時に固定する。サーバー側はプロジェクト単位のroomへ配信するので、
// タブごとに別プロジェクトを開いても他方の更新は届かない
const projectId = projectIdFromUrl();
export const socket = io(projectId !== null ? { query: { project: projectId } } : {});

// #173 → #180: ここには「ハンドシェイクで拒否されたら自分で繋ぎ直す」再試行と、
// ログアウト時に接続を切る disconnectSocket があった。**認証を廃止したので両方とも消した。**
//
// あれが必要だったのは、socket.io-client がミドルウェア拒否 (CONNECT_ERROR) を受けると
// 購読ごと destroy して二度と再接続しないため。ログイン前に io.use が弾く構成では、
// ログイン後もソケットが死んだままで board:changed が一生届かなかった。
// **拒否する側 (io.use の認証) が無くなったので、拒否されて死ぬ経路も無い。**
// 通信断による切断は socket.io のマネージャが自分で繋ぎ直す (それは元から手を出していない)。
