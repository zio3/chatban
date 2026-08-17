export type TaskStatus = "todo" | "inprogress" | "review" | "done";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  /** 詳細・決定事項・ブリーフィングの置き場 (フリーテキスト、遅延読み込み) */
  context: string | null;
  /** 期限 YYYY-MM-DD (#44)。相対表現はチャットが今日の日付から解決して格納する */
  due: string | null;
  /** 依存先タスクID (#41)。このタスクは blocked_by の全タスクが完了するまで着手できない想定 */
  blockedBy: number[] | null;
  /** 却下=やらない決定 (#65)。reason に却下理由を持ち、要約でも【却下】として蒸留される */
  /** #92: 現況の一言。カードに出る。Reviewでは検収の要点を書く (詳細はcontextへ) */
  summary?: string | null;
  rejected: boolean;
  /** #102: ゴミ箱に入れた日時。nullなら通常のタスク */
  trashedAt?: string | null;
  /** #108: Doneへ確定した日時。nullなら未完了、またはこの列より前に終わったもの */
  doneAt?: string | null;
  /** #108: 人が実物で確かめた日時。nullなら未検収。AIは読むだけで書けない */
  checkedAt?: string | null;
  /** #112: 経緯メモの版。contextが変わるたびに +1。
   * エージェントが「読む→考える→全文で書き戻す」の間に他人が追記していないかを見る */
  contextVersion: number;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

/** チャットの応答に付随してUIを動かす指示。DBには保存しない揮発物。
 *
 * #179 で set_filter (担当者での絞り込み) が消え、いまは ask だけ。
 * フィルタ自体をやめたわけではなく、担当という軸が無くなった —
 * 作り直すなら「LLMにIDの集合を返させて、押した瞬間に確定する」形になる (CLAUDE.md の将来案) */
export type UiAction = {
  /** 直前の返答に対する簡易返信ボタン。押すとその文字列がそのままユーザー発言として送られる。
   * 次の発言でUIごと消える(状態を持たない) — 承認待ちという状態を作らないための設計 */
  type: "ask";
  options: string[];
};
