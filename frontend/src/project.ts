// #97: 表示中のプロジェクトはURLが持つ (/p/<id>)。
//
// なぜURLか: MCPが接続URLでプロジェクトを固定した(#96)のと同じ考え方を、UI側でも成立させる。
// サーバー側に「アクティブプロジェクト」という隠れ状態を持つと、タブを2枚開いたときに
// 奪い合いになる。URLに出しておけば、タブごとに別プロジェクトを開けて、リロードしても戻らず、
// URLを渡すだけで「このプロジェクトを見て」が成立する。
//
// 「見えない状態が事故を起こす」— 担当フィルタが効いていることに気づけずカードが消えたように
// 見えた件(#90)と同じ構図で、こちらはその親玉にあたる。

/** URLから読む。/p/<id> でなければ null (=既定プロジェクトへ着地させる)。
 * 0 は実在しないIDなので null 扱い — 「指定なし」と区別できないと、下の真偽判定で
 * 既定プロジェクトに化ける (自動レビュー指摘) */
export function projectIdFromUrl(): number | null {
  const m = location.pathname.match(/^\/p\/(\d+)/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** APIリクエストに載せるプロジェクト。URLに無ければ載せない (サーバー側の既定に任せる)。
 * null との比較にする — `id ?` だと 0 だけが「指定なし」に化け、/p/0 を開いているのに
 * 既定プロジェクトの中身が出て、そのまま既定へ書き込めた。
 * サーバーは「指定したのに無いプロジェクト」を400で拒否する (#125) のに、
 * ヘッダを載せないぶんその拒否にすら到達しない */
export function currentProjectHeader(): Record<string, string> {
  const id = projectIdFromUrl();
  return id !== null ? { "X-ChatBan-Project": String(id) } : {};
}

/** プロジェクトを切り替える。ページごと移動させて状態を持ち越さない
 * (詳細パネル・検収チェック・フィルタなどの持ち越しを個別に消す必要がなくなる) */
export function gotoProject(id: number): void {
  location.href = `/p/${id}`;
}

/** URLがプロジェクトを指していないときに、既定プロジェクトのURLへ置き換える (履歴は汚さない) */
export function ensureProjectInUrl(id: number): void {
  if (projectIdFromUrl() === null) history.replaceState(null, "", `/p/${id}${location.search}`);
}
