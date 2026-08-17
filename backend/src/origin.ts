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
  // 塞ぐと Claude Code から /mcp に繋がらなくなる (ローカルのエージェント用の口)。
  //
  // **ここだけでは足りない。**Origin が付かないブラウザ要求が2種類ある —
  // トップレベルのGETナビゲーション (リンクを踏む) と、`<img src>` のような subresource GET。
  // 後者は悪意あるページから撃てるので、Origin の有無だけを見ていると素通りする。
  // それを塞ぐのが下の isBrowserCrossSite (自動レビュー指摘で追加)。
  //
  // 併せて **課金・外部アクセスを伴う処理は GET に置かない** (POSTにしてある)。
  // 「GETは一切副作用なし」ではない — 例えば /api/projects はプロジェクトDBを開くときに
  // スキーマ適用が走る。守っているのは「開いただけでお金が動いたり外部を叩いたりしない」線
  if (!origin) return true;
  return allowed.includes(origin);
}

/** **Origin が付かないブラウザ要求**を捕まえるための第2の判定。
 *
 * 悪意あるページは `<img src="http://localhost:8787/api/...">` で GET を撃てる。
 * この要求に Origin は付かないので `isAllowedOrigin` は通してしまう。実際、
 * `GET /api/suggestions` は**有料のLLM呼び出しを起こす**ので、開いているだけで
 * 課金と記録を増やされる経路だった (自動レビュー指摘)。
 *
 * `Sec-Fetch-Site` は**ブラウザが自分で付ける**ヘッダ (ページ側から偽装できない)。
 * `cross-site` を断れば、他所のページからの要求は方式を問わず落ちる。
 * curl・スクリプト・MCP はこのヘッダを送らないので影響を受けない。
 *
 * 「課金・外部アクセスを伴う処理を GET に置かない」設計は**それはそれで守る**
 * (該当する3本は POST にした)。ここは、うっかり戻したときに事故らないための二重化 */
export function isBrowserCrossSite(secFetchSite: string | undefined | null): boolean {
  return secFetchSite === "cross-site";
}
