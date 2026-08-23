/** #19: custom1 / custom2 は**プロジェクトが表示名を付けたときだけ存在する**任意レーン。
 * 値そのものは固定 (静的な enum) で、意味は表示名と前提情報が与える。
 * 位置は Review と Done の間。Todo/Inprogress と同じ緩い箱で、live_cards にも入る。
 * **Done へは行けない** — 退場は review を通る規則のまま (mayEnterDone は変えていない) */
export type CardStatus = "todo" | "inprogress" | "review" | "custom1" | "custom2" | "done";
export type CustomLaneKey = "custom1" | "custom2";
export interface CustomLane {
  key: CustomLaneKey;
  /** UIとプロンプトに出るのはこちら。custom1 という値そのものは人に見せない */
  label: string;
}

export interface Card {
  id: number;
  title: string;
  status: CardStatus;
  /** 詳細・決定事項・ブリーフィングの置き場 (フリーテキスト、遅延読み込み) */
  context: string | null;
  /** 期限 YYYY-MM-DD (#44)。相対表現はチャットが今日の日付から解決して格納する */
  due: string | null;
  /** 依存先カードID (#41)。「#AはBが終わってから」という**関係の覚え書き**で、
   * コードは何も止めない (#152: mayEnterDone は依存を見ない。相互・循環も矛盾ではない) */
  blockedBy: number[] | null;
  /** #92: 現況の一言。カードに出る。Reviewでは検収の要点を書く (詳細はcontextへ) */
  summary?: string | null;
  /** 却下=やらない決定 (#65)。**理由の置き場は summary と経緯メモ** (REJECTED_DESCRIPTION と同じ契約)。
   * かつては専用の reason 列があったが #179 で廃止した */
  rejected: boolean;
  /** #102: ゴミ箱に入れた日時。nullなら通常のカード */
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

/** 書き込み経路 (チャット / MCP) が画面へ伝える出来事。**名前を1か所に置く** —
 * 以前は同じユニオンが4か所に書いてあり、種類を足すときに全部を直す必要があった (#226 と同じ形)。
 *
 * board: 板の中身が変わった / proposals: 提案チップ / context: プロジェクトの前提情報 */
export type ViewEvent = "board" | "proposals" | "context";
