/** #180: 認証を廃止したので、境界は「待ち受けを 127.0.0.1 に閉じる」ことと、
 * 「知らないページからの呼び出しを断る」ことの2つだけになった。
 *
 * **`cors()` の許可リストは境界にならない** (Codexレビュー指摘・実測)。
 * express の cors は許可しない Origin に対して `Access-Control-Allow-Origin` を
 * **付けないだけ**で、リクエストはハンドラまで到達する。ブラウザが遮るのは
 * 「レスポンスを読むこと」であって「送ること」ではないので、単純リクエストなら
 * 悪意あるページから localhost の板を書き換えられる (実測: `Origin: https://evil.example` で
 * `POST /api/projects/1/activate` が 200、状態も変わった)。
 * さらに **WebSocket のハンドシェイクはそもそも CORS の対象外**なので、
 * Socket.IO の `cors` 設定は接続の可否に効かない (実測: CONNECTED)。
 *
 * なので「ヘッダを付けない」ではなく **明示的に断る** 側に倒す。REST は 403、
 * Socket.IO は `allowRequest` でハンドシェイクごと拒否する。
 *
 * 判定を純粋関数にしてあるのは、REST と Socket.IO で書き分けるとズレるため
 * (#92 #108 #114 #125 #126 と同じ形。**入口が2つあるものは1つの関数にする**)。 */
export function isAllowedOrigin(origin: string | undefined | null, allowed: string[]): boolean {
  // Origin が無い呼び出しは通す。curl・スクリプト・MCP (Claude Code) がこれで、
  // **ブラウザは必ず Origin を付ける**ので、ここを開けてもページからの攻撃は増えない。
  // 塞ぐと Claude Code から /mcp に繋がらなくなる (ローカルのエージェント用の口)
  if (!origin) return true;
  return allowed.includes(origin);
}
