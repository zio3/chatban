import { io } from "socket.io-client";
import { projectIdFromUrl } from "./project";

// アプリ全体で共有するSocket.IO接続 (App/チャットフックが同じ接続にリスナーを張る)。
// #97/#99: 表示中のプロジェクトを接続時に固定する。サーバー側はプロジェクト単位のroomへ配信するので、
// タブごとに別プロジェクトを開いても他方の更新は届かない
const projectId = projectIdFromUrl();
export const socket = io(projectId !== null ? { query: { project: projectId } } : {});

/** #173: ハンドシェイクで拒否されたときに自分で繋ぎ直す。
 *
 * **socket.io-client はミドルウェア拒否だと二度と再接続しない。**
 * `CONNECT_ERROR` パケットを受けると `destroy()` が走り、
 * 「clean subscriptions to avoid reconnections」で購読ごと捨てる (実装のコメントのまま)。
 * 通信断による切断とは扱いが違い、これは「サーバーが明確に断った」ので自動では諦める設計。
 *
 * ChatBan ではこれが刺さる。認証あり (= サーバー) の場合、ページを開いた直後は
 * まだログインが済んでおらず、`io.use` が unauthorized で弾く。数秒後にログインは通り、
 * RESTはCookieで動くのでボードは表示される — が、**ソケットは死んだままで
 * `board:changed` が一生届かない**。「チャットは応答しているのにカードが動かない」
 * という見え方になる (2026-08-14 に公開環境で発生。当日10回拒否されていた)。
 * ローカルは authEnabled() が false で素通しになるため再現しない。
 *
 * 対処は素直に「繋ぎ直す」。ログインが済んでいれば次の試行で通る。 */

/** 再試行の待ち時間。ログイン操作が挟まるぶんを見て少し置き、
 * ログインしないまま放置された場合にログを埋めないよう頭打ちにする */
export function retryDelayMs(attempt: number): number {
  return Math.min(2000 * 2 ** (attempt - 1), 15000); // 2s, 4s, 8s, 15s, 15s...
}

let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

socket.on("connect", () => {
  attempt = 0;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
});

socket.on("connect_error", () => {
  // 一時的な通信断ならマネージャが自分で繋ぎ直す (active=true)。二重に接続しにいかない
  if (socket.active) return;
  if (timer) return;
  attempt += 1;
  timer = setTimeout(() => {
    timer = null;
    socket.connect();
  }, retryDelayMs(attempt));
});

/** ログアウト時に呼ぶ。**Cookieを消してもソケットは繋がったまま**で、
 * サーバーは `io.use` のハンドシェイク時にしか認証を見ない。切らないと
 * ログアウト後も `board:changed` が届き続ける (Codexレビュー指摘)。
 *
 * 上の再試行タイマーも一緒に止める。残しておくと数秒後に勝手に繋ぎ直してしまい、
 * 「切ったつもりが戻っている」という一番わかりにくい壊れ方をする */
export function disconnectSocket(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  attempt = 0;
  socket.disconnect();
}
