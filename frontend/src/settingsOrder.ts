/** #199: 設定の新旧判定。React にも fetch にも依存しない純粋関数なので、そのままテストできる。
 *
 * 設定は4つの経路から届く (初期GET / 再接続GET / PATCH応答 / socket配信)。
 * どれも到着順が決まっていないので、全部この判定を通して「古いほうを捨てる」。
 * 1つでも素通しにすると、そこだけ巻き戻しの穴になる。
 */

/** 新旧の判定に使う部分だけ。Settings 全体を要求すると、テストで無関係な項目を埋めることになる */
export interface SettingsOrder {
  /** サーバーの起動世代。再起動のたびに1つ増え、DBに残るので再起動をまたいで単調増加する */
  bootGeneration: number;
  /** その起動の中での版。書き換えるたびに増える (プロセス内カウンタなので再起動で0に戻る) */
  revision: number;
}

/** 届いた設定が、いま持っているものより古いか。
 *
 * (起動世代, 版) の辞書順で比べる。**世代だけ・版だけでは足りない**:
 * - 版だけ → 再起動で0に戻るので、以後どの更新も「持っている版のほうが大きい」で捨てられる
 * - 起動ごとのランダムID → 同一性しか分からず順序が無いので、旧プロセスで始まった遅延応答が
 *   新プロセスの状態を「別の起動だから」と巻き戻す
 *
 * 世代を単調増加させると全順序になり、どの経路がどの順で着いても機械的に決まる。
 * 同じ (世代, 版) は同じ内容なので、古いとは呼ばない (どちらを採っても結果は変わらない)。
 */
export function isOlder(incoming: SettingsOrder, current: SettingsOrder): boolean {
  if (incoming.bootGeneration !== current.bootGeneration) return incoming.bootGeneration < current.bootGeneration;
  return incoming.revision < current.revision;
}
