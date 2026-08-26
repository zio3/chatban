import type OpenAI from "openai";
import {
  CONTEXT_APPEND_DESCRIPTION,
  CONTEXT_MARKDOWN_RULE,
  createCardsAsAgent,
  RESTORE_DESCRIPTION,
  restoreCardsAsAgent,
  updateCardsAsAgent,
} from "./agentWrite.js";
import { getBoardPromptSection } from "./promptState.js";
import {
  trashCard,
  getCard,
  getCards,
  listCards,
  PUBLIC_TABLES,
  queryLogHelp,
  queryProjectData,
  reorderCards,
  searchCards,
  setProjectContext,
} from "./db.js";
import { currentProjectId, customLanes } from "./store.js";
import { agentStatusValues, parseToolArgs, reorderableStatuses } from "./toolArgs.js";
import { chatCompletion } from "./llm.js";
import { getModel } from "./config.js";
import { foldedContainer } from "./archive.js";
import { suggestBootGraceMs } from "./demoMode.js";
import { argDetail, argShape, choicesDetail, isFailure, outcomeOf, safeToolName, throwOutcome } from "./mcpLog.js";
import { log } from "./log.js";
import type { CustomLane, UiAction, ViewEvent } from "./types.js";

export interface ToolTrace {
  tool: string;
  input: unknown;
  result: unknown;
}

export interface ChatResult {
  reply: string;
  trace: ToolTrace[];
  uiActions: UiAction[];
  /** #181: 1ターンの体感を返す。**トークン数・キャッシュヒット・ルーティング先は含めない**
   * (#31 のルーティング詳細は計測系ごと撤去した)。残したのは「速いか遅いか」で、
   * それは応答のフィードバックであって計測ではない。内訳を見たいときは backend/logs/ を読む */
  usage: {
    rounds: number;
    elapsedMs: number;
  };
}

/** エージェントが指定できる列。**done は無い** — 検収は人間のUIだけが通す扉なので、
 * 契約に選択肢として置かない。以前は enum に done があり、受けた側 (coerceStatus) で
 * review へ倒していたが、それは「押せるボタンを押した後で断る」形だった。
 * 「プロンプトは漏れるが、経路が無いことは漏れない」— 選べないものは選ばれない。
 *
 * coerceStatus は残す。done を review へ倒すのは**型ではなく意味の話**で、
 * 入口の検査 (toolArgs.ts) を通ったあとに効かせたいため。
 * (#245 以前はここに「こちらに検証は無い」と書いてあった。いまは両入口とも Zod を通る) */

/** #19: この接続のプロジェクトで選べる列。任意レーンを**有効なものだけ**足す。
 * 「選べないものは選ばれない」— 無効なレーンを enum に出さないので、そこへ置く経路が無い。
 * db.ts の isUsableStatus が最後の砦だが、そこまで届かせないほうがよい (done を enum から外したのと同じ形)。
 *
 * **チャットとMCPで同じ関数を使う。**同じ一覧を2か所に書くと必ず片方だけ直る (#92 #108 #114) */

/** 任意レーンの意味を契約に差し込む。**表示名は必須**なので、custom1 が説明の無い箱になることはない。
 * 人が前提情報に運用ルールを書くのは任意だが、`custom1 = 素材` の対応だけは待たずに自動で出す */
export function statusDescription(lanes: CustomLane[]): string {
  if (lanes.length === 0) return STATUS_DESCRIPTION;
  const map = lanes.map((l) => `${l.key} = 「${l.label}」`).join(" / ");
  return `${STATUS_DESCRIPTION}。このプロジェクトには任意レーンがある: ${map}。ボードでは Review と Done の間に並ぶ。何を置く列かはプロジェクトの前提情報を読むこと`;
}


/** #106/#108: 記録へのSQL窓口の説明。チャットとMCPで同じものを使う。
 * 入口ごとに書き分けると必ずズレる (#92 #108 #114 で3回起きた) */
/** **同じ事実を、散文と例文の両方で言わない** (#255)。
 *
 * 説明が3,259字まで太った原因は、行を足したことより**同じことを2回言っていた**こと。
 * `length(context)` は散文にも例文にもあり、`WHERE id=112` も、`done_day` もそうだった。
 *
 * 迷ったら**例文だけで通じるならそちら**。SQLは形がそのまま答えなので、
 * 「こう書ける」を1本見せるほうが短く、真似もされる (実測で真似されていたのは例文だけだった)。
 * **例文からは読めない事実だけ散文に残す** — 並び順が組み込まれていること、
 * 番号がプロジェクトごとであること、2つのビューに同じカードが出る時期があること。
 *
 * つまり片方に寄せる。**説明+例のセットは作らない。** */
export const QUERY_LOG_DESCRIPTION = [
  "記録にSQLで問い合わせる(読み取り専用)。集計軸・期間・条件は自由に決めてよい。",
  // #255: **「SQLiteなら知っている知識」は書かない。**以前はここで方言を185字かけて
  // 説明していた (date_trunc が無い・真偽値は 0/1・連結は || ・日付関数と修飾子)。
  //
  // 実測 (2026-08-25、chat_messages.trace から復元したSQL 98本): **方言違反0件・失敗0件**。
  // date_trunc / INTERVAL / NOW() / CURRENT_DATE / CONCAT / TRUE・FALSE / :: は1本も無く、
  // SQLの文法で転んだ記録も1つも無かった。**事故を見て足した行ではなく、予防で書いた行**だった。
  //
  // **残すのは1つだけ** — 日時の入り方は方言ではなく**このDBのスキーマの事実**で、
  // SQLiteを知っていても列がUNIX秒かTEXTか、UTCかローカルかは分からない。
  // しかも現行の文は `localtime` を書いていなかった (例文は date('now','localtime') と
  // 書いているのに)。**短くしながら精度は上がっている。**
  //
  // 「使われていない=不要」で消したのではない (#189)。**転んだ形跡が無い**うえ、
  // 落とした知識はモデルが元から持っている、という2つが揃ったから消せた。
  // done_cards が0件・SELECT * 違反が0件なのは**同じ根拠にならない** — 知られていないのか
  // 規則が効いているのかを区別できないので、そちらは #252 の実測待ちのまま
  "DBは SQLite。日時は 'YYYY-MM-DD HH:MM:SS' の文字列で、**ローカル時刻**で入っている",
  "見えるのは**接続中のプロジェクトの記録だけ**。別プロジェクトのカードや会話は見えない",
  // #181: この行は PUBLIC_TABLES から生成する。説明に手で書くと、テーブルを増減したときに
  // 説明・コード・テストの3箇所を人間が揃える前提になり、実際にズレた (project_context の漏れ)
  `引けるもの: ${PUBLIC_TABLES.join(" / ")}`,
  // #262: **`chat_messages` を SQL窓口から外した。**#258 は説明だけを落として
  // 「能力は残し、授業料だけ落とす」としたが、**能力のほうを畳んだ** — 費用ではなく思想の判断。
  //
  // > チャットの話から、絞るは不要。というかやりません。**ツールの思想にない方向ですね** (zio)
  //
  // **失うのは「時期や条件で会話を絞る」だけ。**「あんな話してたっけ」「なんで◯◯にしたんだっけ」は
  // `search_cards` が会話ログをキーワードで引いている (`db.ts` の `chatHits`) ので、そのまま答えられる。
  //
  // **記録は消していない。**テーブルも行も残り、閉じたのは引く口だけ。
  // #255〜#258 の調査に使った `trace` 列も残るが、**SQLでは引けない** — 次に同じ調査をするなら
  // DBを直接読む。**年に何度もやることではない**ので、毎セッション払う理由にはならない。
  //
  // **#258 で戻した45字も一緒に落ちる。**あれは「時期や条件で絞りたいときは query_log」という
  // システムプロンプトの指示に**従えなくしない**ために戻したもので、**今回はその指示のほうを消した**。
  // 前提が変わったのであって、あのときの判断が誤りだったのではない。
  //
  // `project_context` の列は残す — 前提情報を更新する前に版を読む経路がここしかない
  // (チャットに `get_project_context` が無い。#257 のレビューで確認済み)
  "project_context(id, text, version, updated_at)",
"cards(id, title, status, summary, context, context_version, due, blocked_by, rejected, checked_at, done_at, trashed_at, sort, archived, created_at, updated_at)",
  "checked_at = 人が実物で確かめた日時 (nullなら未検収)。status とは別物で、done は列が動いたこと・checked_at は検収が進んだこと。片方からもう片方を推測しない。この窓口は読み取り専用で、checked_at を書く手段はどこにも無い (印を付けられるのは人間だけ)",
  "会話の「#112」は cards.id = 112 (主キー)。番号はプロジェクトごとに1から振られる",
  "日付の列を取り違えない。created_at=登録日 / updated_at=最終更新(その後の編集でも動く) / done_at=Doneへ確定した日 / checked_at=人が確かめた日。完了の集計には done_at を使う(created_at だと登録日を数えてしまう)",
  "done_at のうち 2026-08-10 以前のものは、列を作る前に終わったぶんを updated_at から埋めた近似値(完了後に触っていなければ最終更新=完了日時)。日単位の集計には使えるが、分単位の議論には使わない",
  "done_cards は完了したもの(done_at 入り)だけを、完了が新しい順に抜いたビュー。live_cards の対",
  // #175: **どの status がどちらに入るかを書く。**「生きている / 終わった」だけだと
  // review がどちらか分からず、実際に「live_cards に review が出ないバグがある」と誤報した
  // (2026-08-15。ビューは正しく、検収済みで消えていただけ)。
  // ビューの条件は status ではなく archived / trashed_at / done_at なので、**両方に出る状態がある** —
  // そこも書かないと「重複している=おかしい」と読まれる。
  //
  // **「短時間だけ」とは書かない** (Codexレビュー指摘)。畳むのは #200 以降**同期**だが、
  // そのとき畳むのは**前回の検収ぶん**なので (`foldDoneColumn`)、いま確定したカードは
  // **次に誰かが検収を押すまで** `archived=0` のまま残る。押さなければ何も動かない。
  // (起動時に `status=done AND archived=0` を回収する処理も無い)
  // 時間で消えると書くと、エージェントは「待てば直る」と判断してしまう
  "live_cards に入るのは **done 以外の列すべて** (todo / inprogress / review と、そのプロジェクトで有効な任意レーン)。加えて「Doneへ確定したが、まだ畳まれていないもの」も入る。done_cards は done_at が入っているものなので、**畳まれるまでは同じカードが両方に出る**(不整合ではない)。畳むのは**人が検収を押した瞬間だけ**で、押さなければ何も動かない — 時間が経てば消えると考えないこと。列で絞りたいなら status を書く: WHERE status='review'",
  // #255: **散文で言ったことを、SQLで言い直さない。**外した例文5本はどれも
  // 上の行が既に言っている事実の書き直しだった (length(context) は15行目、
  // updated_at の意味は9行目、ゴミ箱は16行目、review+checked_at は7・12行目、
  // done_day は11行目)。**列の一覧を見れば書ける**ものは、モデルが元から書ける。
  //
  // 実測 (2026-08-25、trace から復元したSQL 98本): 外した5本を真似したSQLは**0件**。
  // 残した2本 (「1件の詳細」「経緯メモ全文」) は**18件と12件**で、どちらも
  // **context と context_version を一緒に読む**という、列の一覧からは出てこない
  // 組み合わせを教えている。**例文が仕事をしているのはここだけだった。**
  //
  // **0件を根拠に消したのではない** (#189)。0件のうえで「散文と重複している」が
  // 揃ったものだけ外した。done_cards の例文を1本残してあるのは、ビューの存在自体は
  // 例文でしか目に入らないため (ビューを作った経緯は store.ts の done_cards を参照)
  "例(いつ何件終わったか): SELECT done_day, COUNT(*) n FROM done_cards GROUP BY 1 ORDER BY 1 DESC",
  "SELECT * は使わない。必要な列だけ挙げる。context(経緯メモ)は1件1,000字を超えるので、一覧では length(context) か substr(context,1,120) にし、全文が要るカードだけ id で絞って引き直す",
  "live_cards ビューを使う。cards から「生きているもの」(ゴミ箱でもアーカイブ済みでもないもの)だけを、ボードと同じ並びで抜いたもの。条件と並びを毎回書かなくてよく、書き忘れてゴミ箱のカードが混ざることもない。列は cards と同じ + sort_key(=COALESCE(sort,id))。ゴミ箱やアーカイブを見たいときだけ cards を直に引く",
  "例(1件の詳細。経緯メモの全文と版): SELECT title, status, summary, context, context_version, blocked_by FROM cards WHERE id=112",
  "LLM呼び出しの記録 (トークン・単価・レイテンシ) はここには無い (#181で撤去)。速度やキャッシュの効きを見たいときは backend/logs/ のログを読む",
].join("\n");

/** 会話の記録 (`chat_messages.trace`) に載せない項目を落とす。
 *
 * いまは `goal` (#256) だけ。**自由文なので潰せない**ぶん、残す場所を1つに絞る —
 * 失敗したときのログ行だけが記録で、成功した回はどこにも残さない。 */
function withoutGoal(args: unknown): unknown {
  if (!args || typeof args !== "object" || !("goal" in args)) return args;
  const { goal: _dropped, ...rest } = args as Record<string, unknown>;
  return rest;
}

/** #257 (Codexレビュー P2): **版を読む先は get_cards。**
 *
 * `get_cards` を足したのに、**操作のいちばん近くにある説明が `query_log` を指したまま**だった。
 * 遠い説明 (ツールの description) を直して近い説明 (項目の description) を残すと、
 * **近いほうが勝つ** — 実測23本がSQLで版を読んでいた経路は、ここが入口だった。
 *
 * チャットとMCPで同じ文言を使う (入口ごとに書き分けると必ずズレる #92 #108 #114) */
export const CONTEXT_VERSION_DESCRIPTION =
  "context を渡すときのみ必須。直前に get_cards で読んだ context_version をそのまま添える";

/** #257: **カードを名指しで読む口。**
 *
 * 実測 (2026-08-25、`chat_messages.trace` から復元したSQL 98本): **23本がこれだった** —
 * `context` と `context_version` を読むだけのSQLで、集計ではない。
 * **一番多い用途に道具が無く、説明で肩代わりさせていた** (`search_cards` は断片しか返さず、
 * `sync_board` は `summary` だけなので、全文を読むにはSQLを書くしかなかった)。
 *
 * 呼び出し側も安くなる: SQLは平均83字 (最長136)、`{"ids":[112]}` なら13字。
 * **呼び出しは出力トークンなのでキャッシュが効かない**ぶん、効き方が大きい。 */
export const GET_CARDS_DESCRIPTION =
  "カードを番号で読む。経緯メモ(context)の全文と context_version を返すので、書き換える前はここで読む。会話の「#112」が id=112。ゴミ箱・アーカイブ済みも読める(名指しなら在ると答える)";

const GET_CARDS_LIMIT = 10;

/** **上限を置く。**経緯メモは1件1,000字を超えるので、まとめて読むと応答がそのまま費用になる。
 * 断らずに切って、切ったことを言う (黙って減らすと「読んだつもり」が残る)。
 *
 * **チャットとMCPで同じ関数を使う** — 入口ごとに書くと必ず片方だけ直る (#92 #108 #114)。
 * `searchResult` と同じ置き方 */
export function readCards(ids: number[]): ReturnType<typeof getCards> & { note?: string } {
  const r = getCards(ids.slice(0, GET_CARDS_LIMIT));
  return ids.length > GET_CARDS_LIMIT
    ? { ...r, note: `一度に読めるのは${GET_CARDS_LIMIT}件までです。残りは番号を分けて呼んでください` }
    : r;
}

/** #256: **やりたいことを添えてもらう。**説明を削った (#255) 分、
 * **届かなかったときに本人から聞く**ための欄。
 *
 * 記録するのは**失敗した呼び出しだけ** (`mcpLog` の `FAILURE_ONLY_VALUES`)。
 * 成功した回の目的は捕らない — 欲しいのは「説明が足りなかった瞬間」だけで、
 * 実測では 98/98 が成功していた (2026-08-25) ので、残るのはごく僅か。
 *
 * **別ツールにしない。**`ask` ツールは自発的には **0/3回**しか呼ばれなかった
 * (extractChoices のコメント) — 「呼ばなくても目的を達成できるツールは呼ばれない」。
 * **引数なら、呼ぶときに必ず目に入る。**
 *
 * **任意にしてある。**必須にすると添え忘れがスキーマ拒否になり、
 * **見たいだけの呼び出しが丸ごと失敗する**。窓口は読み取り専用で、間違えても壊れない。
 *
 * **説明はここ1箇所だけ。**ツール説明の1行目にも「goal を添えておくと」と書きかけたが、
 * それは #255 で決めた「**同じ事実を2回言わない**」を自分で破っていた。
 * 引数の説明は呼ぶときに目に入るので、本文で言い直す必要が無い。
 *
 * **文脈を減らす話で文脈を増やしている**ことは自覚しておく (+79字)。
 * 見合うのは、#255 で削った852字のうち**削れなかった残りを判別できるようになる**から。
 * 判別が済んだら、この欄ごと畳んでよい。 */
export const GOAL_DESCRIPTION =
  "任意。自明なクエリには要らない。複雑なときや、引けるか不安なときだけ「何が知りたいか」をひとこと。引けなかった回だけ記録して、説明を直す材料にする";

/** #115/#116: 列の意味と完了の条件はプロジェクトごとに違う。
 * 実例: あるプロジェクトは review=検収待ち、別のプロジェクトは review=相手待ち(返答・承認待ち)。
 * エージェントから見ると status の enum はどのプロジェクトでも同じに見えるので、契約側で断る */
export const STATUS_DESCRIPTION =
  "列の意味と「いつそこへ置くか」はプロジェクトごとに違う(例: reviewが検収待ちのプロジェクトと、相手待ちのプロジェクトがある)。状態を変える前にプロジェクトの前提情報を読み、そこの定義に従うこと。done はこの一覧に無い — どのプロジェクトでも、人間がボードで検収チェックを付けて確定したときにだけ付く。実装が終わったものは review に置く";

/** #115: 前提情報は全文上書き。読まずに書くと全員の運用ルールが消える */
export const PROJECT_CONTEXT_WRITE_DESCRIPTION =
  "プロジェクトの前提情報(全員共有、チャットのシステムプロンプトに常時含まれる)を上書き更新する。全文を渡すので、必ず先に読んで自分の変更をマージした全文にすること。完了の定義・却下や保留の扱い・稼働日など、そのプロジェクト固有の運用ルールが入っている";

/** #91/#108: 並べ替えの契約。sortは列内でしか効かない(列をまたぐ順序はstatusそのもの)。
 * 「省略で全列」を残すと1本の通し順位だと期待されるので、対象の列を必須にした。
 * 実際に全体順位のつもりで全列分のIDを渡された事例がある (zio) */
export const REORDER_DESCRIPTION = [
  "1つの列の中で並び順を付け替える。その列のカードを並べたい順に渡す(「番号の降順」だけでなく「重要そうな順」など意味のある並びも可)。",
  "表示設定ではなく並び順そのものを書き換える操作で、あとから手で並べ直せる。「後回し」は列の下へ、「今やりたい」は上へ。",
  "対象の列は必ず指定する。列をまたぐ順序は status そのものなので、複数列を1本の通し順位にはできない(列をまたいで動かしたいなら update_cards で status を変える)。",
  "対象は生きているカードだけ。指定しなかったカードは元の順のまま末尾に残るので消えない。他の列・アーカイブ済み・存在しないIDは無視して ignored で返す(全体は失敗しない)。",
].join("\n");

/** update_cards の見出し。「状態・担当・タイトル・理由」と書いていたが実際より狭く、
 * summary / context / context_append / due / blocked_by も更新できる。
 * 特に context_append は一覧しか見ないクライアントからは存在が読み取れなかった (指摘) */
export const UPDATE_TASKS_DESCRIPTION =
  "カードの状態と内容を更新する(複数可)。状態・タイトルのほか、summary(現況の1行)・経緯メモ・期限・依存も変えられる。経緯メモに1行足すだけなら context_append を使う(既存を読む必要も版も要らない)";

/** rejected の説明。以前は「reasonに根拠を書く」としていたが、reason というパラメータは無い。
 * additionalProperties:false なので、存在しない reason を渡すと確実にエラーになる (指摘) */
export const REJECTED_DESCRIPTION =
  "却下(やらない決定)フラグ。trueにするときは、なぜやらないと決めたかを summary に一言、詳しい経緯は経緯メモ(context / context_append)に書く。取り消しは false";

/** summary の契約。
 *
 * 最初「状態ではなく注意点と次にやることを書く」と否定形で書いたが、これは間違いだった。
 * 外部エージェントが守れなかったと報告してきたが、確認したらこちらも守っていない —
 * ChatBan自身の運用(CLAUDE.md)は「summary=いまどうなっているか」で、実際に登録している
 * summary も「実装完了 (commit xxx)」。3者が独立に同じ側へ倒れているなら、
 * 契約のほうが実態に合っていない。
 *
 * 実例を並べると、欲しいのは状態でもアクションでもなかった:
 *   「実装完了 (commit abc123)」   → 検収してよいかの判断を促す
 *   「PR#42 レビュー待ち」          → 誰の手番かが分かる
 *   「iOS Safari だけ落ちるので注意」→ 触るときの判断材料
 * どれも「次の判断を促す」もので、状態かアクションかは結果でしかない。
 *
 * 位置づけは zio の言葉で「AIとユーザーに、極力短く、状況や次の判断を促すもの」。
 * 否定形をやめたのは、判断を求める指示が反復に弱いと分かったため(同じ日に ask ツールで
 * 0/3、前提情報の空欄で推測、と3回確認した)。書くべきものを名指しする形に倒す */
export const SUMMARY_DESCRIPTION =
  "AIとユーザーの両方に、極力短く、状況や次の判断を促すための1行。カードに出るだけでなく、ボードのチャットが常時これを読んで受け答えする。" +
  "「実装完了 (commit abc123)」「PR#42 レビュー待ち」「先方の返答待ち。8/15に来なければ再送」「iOS Safariだけ落ちるので注意」のように、確認先や気をつけることを添えると次の判断が早い。" +
  "しばらく続くものだけを書き、UIに出ていてすぐ解決する短命な状態(承認待ち・提案中)は書かない。詳細な根拠は経緯メモ(context)へ。" +
  // #221: 索引側で 120字に切る (promptState の clampSummary)。**契約にも書いておく** —
  // コードだけが上限を持っていると、書いた側は切られたことに気づかない
  "長すぎるとチャットが読む索引では先頭120字までになるので、それを超える内容は経緯メモに書く";

/** context(経緯メモ)の書き込み契約。全文上書きであることは書いてあったが、
 * 「累積なので上書きすると前の情報が消える」が書いていなかった。
 * 実例: 外部エージェントが書き直すたびに無意識に要約し、経緯メモの情報が減った */
export const CONTEXT_WRITE_DESCRIPTION =
  "経緯メモの全文上書き。累積の記録なので、既存を読んでマージした全文を渡す(書き直すときに要約すると前の情報が消える)。渡すときは context_version も必須。1件足すだけなら context_append を使う — そちらは読む必要も版も要らない。" +
  CONTEXT_MARKDOWN_RULE;

/** #250: **作成時の説明は入口ごとに書かない。**実測すると、同じ `context` なのに
 * チャットは「相談や議論の流れから登録するときは必ず書く」まで言い、MCPは
 * 「(経緯メモの初期値)」だけだった — **MCP から作るときだけ、書く理由が伝わっていなかった** */
export const CONTEXT_CREATE_DESCRIPTION =
  "登録に至った経緯・会話で出た論点・決まったこと。相談や議論の流れから登録するときは必ず書く (タイトルだけでは背景が失われる)。" +
  CONTEXT_MARKDOWN_RULE;

/** #153: 期限の契約。以前は「期限 YYYY-MM-DD」だけで、**渡した値が使われたかどうかが
 * 返り値から分からなかった** — `not-a-date` がそのまま保存された報告がある。
 * 検証を足したので、契約側でも「実在する日付」と「違うと捨てて報告する」ことを言う */
export const DUE_DESCRIPTION =
  "期限 YYYY-MM-DD (実在する日付。相対表現は今日の日付から解決する)。形式が違うとその指定だけ捨てて badDue で名指しで返す — 保存されたつもりにならないよう、返り値を確かめる";

/** #176: 検索の位置づけ。**絞り込みの引数は持たない** — 絞りたい形は際限が無いので、
 * SQL窓口 (query_log) へ渡すよう契約側で案内する。#91 でソートキーを渡す方式を捨てたのと同じ判断。
 * チャットとMCPで同じ文言を使う (入口ごとに書き分けると必ずズレる) */
export const SEARCH_DESCRIPTION = [
  "カードの本文(タイトル・現況・経緯メモ)を横断検索する。アーカイブ済みも対象。表記ゆれや言い換えは自分で展開して複数語を渡す(OR検索・当たった語が matched で返る)。",
  "**候補が広すぎたら、この道具で絞ろうとせず query_log でSQLを書く。**本文にその語が1度出てくるだけで当たるので、絞り込みはSQLのほうが素直に書ける:",
  "例(タイトルだけを見る): SELECT id, title FROM live_cards WHERE title LIKE '%記事%'",
  "例(条件を重ねる): SELECT id, title, due FROM live_cards WHERE status='review' AND due IS NOT NULL ORDER BY due",
  "この道具は「表記ゆれを展開して当たりを見つける」まで、query_log は「条件で絞る」— 使い分ける。",
].join("\n");

/** 検索・並べ替えの応答。**注意書きは道具の契約の一部**なので、説明文 (SEARCH_DESCRIPTION /
 * REORDER_DESCRIPTION) と同じくチャットとMCPで共有する。
 *
 * #227: 以前は組み立てがチャット側にしか無く、MCPは生の結果をそのまま返していた。
 * 説明文は共通化してあったのに応答は分かれていたので、**外部エージェントだけが注意書きを
 * 受け取れない**状態になっていた (板の文脈を持たない分、むしろ必要としている側)。
 * DBに触らない純粋関数にしてあるのはテストのため。 */
export function searchResult<T extends { hits: unknown[] }>(r: T) {
  // スニペットは「当たった箇所の周辺」でしかないので、判断の核心が範囲外にあることが多い。
  // 検索は「どのカードか」を絞るまでの道具と位置づけ、中身は get_cards で読ませる (#257)
  return {
    ...r,
    ...(r.hits.length > 0
      ? {
    note: "snippetは当たった箇所の周辺のみ。理由や判断を答えるときは get_cards で経緯メモの全文を読むこと",
        }
      : {}),
  };
}

export function reorderResult<T extends { appended: number }>(r: T) {
  // 指定漏れがあったことはLLMに伝える (黙って末尾に置くと「並べたつもり」とズレる)
  return {
    ok: true as const,
    ...r,
    ...(r.appended > 0 ? { note: `${r.appended}件は順番の指定に含まれていなかったので末尾に置きました` } : {}),
  };
}

/** 依存の契約。「順番に着手したい」を依存にしてしまう失敗が実際に起きた
 * (「DateTimeOffset化はデモの後」を blocked_by で表現していた)。
 * 依存は着手可能性の話で、優先順位は sort(並び順)で表す。
 *
 * #152: **「それが終わらないと着手できない」と書いていたのをやめた。**
 * 強制力の宣言に読めるが、実装は何も止めていない (`mayEnterDone` が見るのは
 * status / checkedAt / trashedAt だけで、依存先は見ない)。文言だけが嘘をついていたので、
 * 相互依存や循環を見たエージェントが「両方とも永久に着手できない=矛盾」と読み、
 * 直すべき不整合として扱ってしまう。**緩い参照であることを契約側で言う。**
 * かつて `reason` 欄が説明不足で用途を発明されたのと同じ形 — あちらは説明が無く、
 * こちらは説明が実装と違った。ツール契約のdescriptionはエージェントにとってのUIラベルなので、
 * 実装が課していない制約をそこに書くと、エージェントはそれを守ろうとして詰まる */
export const BLOCKED_BY_DESCRIPTION =
  "依存先カードID。「#AはBが終わってから」という関係の覚え書きで、コードは何も止めない(依存先が残っていても着手・Review・Doneはできる)。相互に張り合っていても、循環していても矛盾ではない — 事実としてそう書いてあるだけ。未完了の依存先があれば「#N待ち」と添え、やるかどうかは人間に決めてもらう。あとでやりたいだけ・順番を表したいだけなら張らず、reorder_cards で列の下へ落とす(依存は関係の記述、優先順位は並び順)";

// 計測スクリプト(scripts/prompt-breakdown.ts)から実物を測れるように公開する。
// 「何が入力トークンを食っているか」はソースを眺めても分からず、実物を数えるしかない
export function buildTools(lanes: CustomLane[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const STATUS_VALUES = agentStatusValues(lanes);
  const STATUS_DESC = statusDescription(lanes);
  return [
  {
    type: "function",
    function: {
      name: "create_cards",
      description: "カードをボードに追加する(複数可)",
      parameters: {
        type: "object",
        properties: {
          cards: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                // #245: status と summary はMCPだけが出していた。**内蔵チャットは作成時に置けると知らず**、
                // 作ってから update_cards で直す往復をしていた (Codexレビュー指摘)
                status: { type: "string", enum: STATUS_VALUES, description: `省略時はtodo。${STATUS_DESC}` },
                summary: { type: "string", description: SUMMARY_DESCRIPTION },
                context: { type: "string", description: CONTEXT_CREATE_DESCRIPTION },
                due: { type: "string", description: DUE_DESCRIPTION },
                blocked_by: { type: "array", items: { type: "integer" }, description: BLOCKED_BY_DESCRIPTION },
              },
              required: ["title"],
            },
          },
        },
        required: ["cards"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_cards",
      description: UPDATE_TASKS_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer", description: "カードID。会話で「#112」と呼ばれるものと同じで、cards テーブルの主キー(id)。プロジェクトごとに1から振られるので、別プロジェクトの#112とは別物" },
                title: { type: "string" },
                status: { type: "string", enum: STATUS_VALUES, description: STATUS_DESC },
                summary: { type: "string", description: SUMMARY_DESCRIPTION },
                due: { type: ["string", "null"], description: `${DUE_DESCRIPTION}。解除はnull` },
                blocked_by: { type: ["array", "null"], items: { type: "integer" }, description: `${BLOCKED_BY_DESCRIPTION}。全置換で、解除はnull` },
                rejected: { type: "boolean", description: REJECTED_DESCRIPTION },
                context: { type: "string", description: CONTEXT_WRITE_DESCRIPTION },
                context_version: { type: "integer", description: CONTEXT_VERSION_DESCRIPTION },
                context_append: { type: "string", description: CONTEXT_APPEND_DESCRIPTION },
              },
              required: ["id"],
            },
          },
        },
        required: ["updates"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_cards",
      description: "カードをゴミ箱に入れる(複数可)。実データは残り restore_cards や画面から復元できる",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "integer" } } },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restore_cards",
      description: RESTORE_DESCRIPTION,
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "integer" } } },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reorder_cards",
      description: REORDER_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: reorderableStatuses(lanes), description: "対象の列" },
          ids: { type: "array", items: { type: "integer" }, description: "その列のカードを並べたい順に" },
        },
        required: ["status", "ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_cards",
      // 共通の説明 + チャット側だけの補足 (会話ログも引く)。
      // 絞り込みをSQLへ寄せる案内は共通側に入っている (#176)
      description: `${SEARCH_DESCRIPTION}\n会話ログも同じ語で引き、新しい順に最大6件返る(「あんな話してたっけ?」用)。例: 「なんでDB分けたんだっけ」→ terms:["DB","データベース","ファイル分離","分割","プロジェクト"]`,
      parameters: {
        type: "object",
        properties: {
          terms: { type: "array", items: { type: "string" }, description: "検索語(最大10)。言い換え・英日表記を並べる" },
        },
        required: ["terms"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cards",
      description: GET_CARDS_DESCRIPTION,
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "integer" }, description: "カード番号" } },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_log",
      description: QUERY_LOG_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "SELECT または WITH で始まる1文" },
          goal: { type: "string", description: GOAL_DESCRIPTION },
        },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_project_context",
      description: PROJECT_CONTEXT_WRITE_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "新しい前提情報の全文" },
          version: { type: "integer", description: "直前に query_log で `SELECT text, version FROM project_context WHERE id=1` を読んだ version。合わないと更新されず現在値が返る" },
        },
        required: ["text", "version"],
      },
    },
  },
  ];
}

// #179: 以前はここに toolsFor(personal) があり、メンバーが居ないプロジェクトでは
// 実行時に assignee 系のツールと項目を削っていた (#109/#110)。担当者そのものを
// 廃止したので、削る対象も分岐も消えた。**ツール定義は常に1つ**になり、
// プロンプトのバイト列が揺れる余地 (キャッシュが外れる原因) も1つ減っている


/** #245: **テストから入口の配線を叩けるようにしてある。**
 * `delete_cards` / `reorder_cards` は agentWrite を通らず、ガードがここにしか無い。
 * ヘルパ単体のテストでは**配線を消しても気づけない** (Codexレビュー指摘) */
export async function execTool(name: string, rawArgs: any, events: Set<string>): Promise<unknown> {
  // #245: **ここから先は検証済みの値しか流れない。**
  // 以前はここに検査が無く、モデルの出力が揺れるだけで実データが消えた
  // (`context:null` で経緯メモが消える / `ids:"12"` が `"1"`,`"2"` に割れて別のカードを復元する等)。
  // MCPは同じことを SDK の Zod がやっていたので踏んでいない — **穴は入口が1つ無検査だった点**だった。
  // 項目ごと・ツールごとに塞ぐと (入口 × ツール × 項目) の面を1マスずつ埋めることになる
  const parsed = parseToolArgs(name, rawArgs, customLanes());
  if (!parsed.ok) return { ok: false, note: parsed.note };
  const args = parsed.args;

  switch (name) {
    case "create_cards": {
      // #114: 書き込みは agentWrite に集約 (チャットとMCPで同じガードを通す)
      // #245: **`?? []` にしない。**欠落を空配列に補うと「何もしていないのに成功」になる
      const r = createCardsAsAgent(args.cards);
      events.add("board");
      // #245: **`ok:true` を被せない。**共有入口が決めた ok/status をそのまま返す —
      // 被せていたので、1件も作れなくても成功に見えていた
      return r;
    }
    case "update_cards": {
      const { ok, status, updated, note, conflicts, notFound, badDue } = updateCardsAsAgent(args.updates);
      events.add("board");
      // #112: 版が合わなかった経緯メモは適用していない。現在の全文を返すのでマージして再実行する
      // #153: badDue も返す。**列挙して返しているので、足し忘れると入口ごとにズレる** —
      // このPRの中で2回踏んだ (MCP側で1回、こちらで1回。契約は「badDueで名指しで返す」と言っている)
      return {
        ok,
        status,
        updated,
        ...(conflicts ? { conflicts } : {}),
        ...(notFound ? { notFound } : {}),
        ...(badDue ? { badDue } : {}),
        ...(note ? { note } : {}),
      };
    }
    case "delete_cards": {
      // #102: 実データは消さずゴミ箱へ。誤解釈で消えても取り返しがつくようにする
      const results = (args.ids as number[]).map((id) => ({ id, trashed: trashCard(id) }));
      // 復元できることは毎回文章で説明しない (くどい)。#xx リンクから詳細パネルを開けば「戻す」がある
      events.add("board");
      return { ok: true, results };
    }
    case "restore_cards": {
      // ツール定義とゴミ箱画面のプロンプトには公開してあるのに、ここに分岐が無く
      // unknown tool を返していた (自動レビュー指摘)。画面が「チャットで戻せる」と
      // 案内しているのに成立しない状態。MCP側には実装があり、**入口ごとに機能が違っていた**
      // (#92 #108 #114 #125 #126 と同じ形。契約だけ公開して実装を書き忘れる、が新しい)
      // #161: 判定と報告は agentWrite に集約。以前はここだけ **常に ok:true** で、
      // MCPは「1件でも戻せなければ ok:false」だった — ok だけを見るエージェントは
      // 入口によって失敗を見落とす (Codexレビュー指摘)
      const r = restoreCardsAsAgent(args.ids as number[]); // 型は restoreCardsAsAgent が見る (#245)
      events.add("board");
      return r;
    }
    case "reorder_cards": {
      const r = reorderCards(args.ids, args.status);
      events.add("board");
      return reorderResult(r);
    }
    case "search_cards": {
      const r = searchCards(args.terms);
      return searchResult(r);
    }
    case "get_cards":
      return readCards(args.ids as number[]);
    case "query_log": {
      // #181: scope は廃止 (cost 側の llm_calls を撤去したので窓口が1つになった)
      try {
        return queryProjectData(args.sql ?? "");
      } catch (e: any) {
        // 失敗したら、直せるだけの材料を一緒に返す (説明を厚くする代わりの事後注入)
        const error = e?.message ?? String(e);
        return { ok: false, error, ...queryLogHelp(error) };
      }
    }
    case "update_project_context": {
      // **`args.text ?? ""` にしない。**欠落や null を空文字に補うと、全消去に化ける (#244)
      const r = setProjectContext(args.text, args.version);
      // 📋前提の画面は編集UIを持たず変更経路がチャットだけ (#73) なので、
      // ここで伝えないと**開いたまま古い本文を読み続ける** (レビュー指摘 2026-08-21)
      if (r.ok) events.add("context");
      if (!r.ok)
        return {
          ok: false,
          conflict: r.current,
          note: r.missingText
            ? "text (前提情報の全文) が届いていません。返した text に自分の変更をマージし、全文と version を添えて再実行してください。全部消したいときだけ空文字を明示してください"
            : "前提情報が他から更新されています。返した text に自分の変更をマージし、この version を添えて再実行してください",
        };
      return { ok: true };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

export function buildSystemPrompt(cardFocus?: ReturnType<typeof getCard>, view?: string): string {
  // キャッシュ友好の並び: 静的な内容(人格/ルール/思想)を先頭に固定し、動的な内容(索引/履歴/カード)を末尾へ。
  // プロンプトキャッシュはプレフィックス一致なので、先頭が安定しているほどヒット部分が伸びる。
  return [
    "あなたはチームのタスク管理ボード「ChatBan」のアシスタント。日本語で簡潔に応答する。",
    "",
    "## 行動ルール",
    // #215: 板の上のものの名前は「カード」に統一したが、**ユーザーに言い換えを強いない**。
    // ユーザーは「タスク」と呼ぶことが多く、そこを訂正すると会話のテンポが落ちるだけで何も得しない。
    // 内部(画面・ツール名・この指示)がカードで揃っていれば、探すときも指すときも迷わない
    "- 「タスク」「カード」「チケット」「項目」はすべて同じもの(ボードに並ぶ1件)を指す。ユーザーが使った語をそのまま使って応答し、言い換えたり訂正したりしない。",
    "- まず依頼か相談かを判別する。明確なアクション依頼(「〜を追加して」「〜やらないと」「カード: 〜」「〜に対応したい」)だけを、確認を挟まず即 create_cards で登録する。テンポ優先はこの依頼に限る。",
    // 定型文に記法を織り込んでおく。別の節に「返事は [[ ]] で囲む」と書いてあっても、
    // 定型文が具体的に指定されていると そのまま出力されて記法が付かない (実測2/2)。
    // 判断を挟ませず、コピーすれば記法が付いてくる形にする
    "- 質問・意見募集・感想(「どう思う?」「いいのかな?」「なんで〜?」、画像やPDFを見せての問いかけ等)は相談。カードにせず、内容に踏み込んで会話で応える。カードにする価値がありそうなら会話の末尾に「積んでおきますか?  [[積んで]] [[いまはいい]]」と一言添えるだけにし、登録は次のユーザー発言を待つ。",
    "- 依頼か相談か迷ったら相談として扱う (誤登録の削除コストより会話で受ける方が安い)。",
    "- create_cards / update_cards の報告では、必ず割り当てられたカードID を「#12として登録しました」の形式で明記する (ユーザーは以後この番号で参照する)。",
    "- 相談・議論の流れからカードを登録するときは、create_cards の context に登録に至った経緯を要約して入れる。経緯のない単発の明確な依頼では省略可。",
    "- ただし判断材料が足りないときや、影響が大きいと感じたときは、実行する前にチャットで案を出して聞く。どちらにするかは文脈で決めてよい。",
    "- 「終わりました」等の完了報告は status=review に置き、「Reviewに置いたので確認OKなら承認を」と一言返す。勝手に done にしない (doneは人間の検収済みという意味。確定したカードはしばらく個別に残り、次の検収のときに「畳んだ完了」の箱へ入る)。",
    "- あなたは done に変更できない (ツールが受け付けず review に置き換わる)。完了・却下・承認はすべて status=review に置き、done への確定はボードのReview列の検収チェック(人間の操作)だけが行う。「doneにして」「まとめて承認」と言われたら review に置いた上で「確定はReview列の検収チェックからお願いします」と案内する。",
    "- 共通の前提・決まりごと(締切、方針、用語など)を伝えられたら update_project_context で前提情報に反映する。",
    "- 特定カードの経緯・決定事項・補足(「#22は◯◯方式でいくことにした」等)は update_cards の context_append でそのカードの経緯メモに1行足す。",
    "- summary は「いまどうなっているか」。進捗・完了報告は summary に一言で書き、詳細な根拠は経緯メモ(context)に書く。",
    "- 過去の判断や経緯・過去の会話を聞かれたら(「なんで◯◯にしたんだっけ」「あんな話してたっけ」)、索引のタイトルだけで答えず search_cards で本文と会話ログを引く。言い換え・英日表記を自分で並べて渡し、空振りしたら語を変えて引き直す。検索結果のsnippetは断片なので、理由を答える前に get_cards で経緯メモの全文を読む。",
    "- 削除と却下は文脈で使い分ける: 誤登録・重複・ダミー(「消して」「間違えた」)は delete_cards (ゴミ箱行きで復元可。返答で復元方法を説明する必要はない)。やらない決定(「見送り」「却下」「やらないことにした」)は削除せず update_cards で status=review + rejected=true にし、なぜやらないと決めたかを summary に一言・詳しい経緯を経緯メモ(context / context_append)に書いて「却下としてReviewに置きました。検収で確定します」と返す (検収後、決定としてDone列に残る)。",
    "- 「消して」がカードそのものを指すのか、タイトルや文言の一部の修正を指すのか曖昧なときは、操作せず確認する (実例:「#95だけ発言者の話が入っていて不自然なので消せますか?」はタイトルの修正依頼だったが、カードごと削除してしまった)。",
    "- ボードから退場するもの(完了・却下)は必ずReviewを通り、人間の検収チェックで確定する。チャットからdoneへ直行する経路は存在しない。",
    "- 着手したが前提が足りず進められないときは、勝手に却下にも完了にもしない。summary に「前提不足で保留 (◯◯が必要)」と現況を書き、必要な情報を人に尋ねる。status をどこに置くかはプロジェクトの前提情報の定義に従う (列の意味はプロジェクトごとに違う)。",
    "- 検収の印(checked_at)は人が実物で確かめた記録で、AIには書く手段が無い。「確認しておきました」と自分で付けることはできないし、付いたことにして話さない。誰が何を確かめたかを聞かれたら query_log で cards.checked_at を読む。",
    "- 「後回し」「今はやらない」は却下ではない。status は変えず (done にするとアーカイブに吸い込まれる)、reorder_cards でその列の下へ落とす。「今やりたい」は逆に上へ。",
    "- 「金曜まで」「明日まで」等の期限表現は今日の日付から YYYY-MM-DD に解決して due に入れる。期限が近い/過ぎたカードはレポートで優先的に言及する。",
    "- 画像やPDFが添付されたら内容を読み取って会話・操作に活かす。重要な情報(バグの症状、決定事項、資料の要点)はカードの context や前提情報に文字で蒸留して記録する。ファイル原本はどこにも保存されないため、後から参照が必要な内容は必ず文字にして残す。",
    "- 「#AはB待ち」「Bが終わってから」等の依存表現は blocked_by に依存先IDを登録する(複数可)。索引の dep がそれ。依存先が未完了のカードは、レポートで「#N待ち」と添える。これは関係の覚え書きで着手を止めるものではないので、相互や循環になっていても直すべき不整合として扱わない。",
    "- 操作後は結果を一言で報告する。長い説明はしない。",
    "",
    "## ユーザーの返事を先回りして置く",
    "こちらから聞き返して次の発言を待つときは、ユーザーが返しそうな短い返事を [[ ]] で囲んで置く。",
    "これは押せるボタンになり、押すとその文字列がユーザーの発言として送られる。「OK」と打つだけの手間を省くためのもの。",
    "",
    "例1: 「積んでおきますか?  [[積んで]] [[いまはいい]]」",
    "例2: 「#8はやらない方針ということで、却下にしますか?  [[却下でOK]] [[まだ決めない]]」",
    "例3: 「先に依存を外したほうが早そうです。そちらから見ますか?  [[それでOK]] [[このまま進める]]」",
    "例4: 「どれから着手しますか。  [[#4から]] [[#5から]] [[#6から]]」",
    "",
    "1〜4個まで。ユーザーの言葉で書く (「はい」「OK」「それで」など、そのまま発言になる短文)。",
    "同じ内容を「- 」の箇条書きでも書かない — 置いたものがそのまま表示になる。",
    "答えが自由記述になる問い、そもそも聞かずに実行してよいことには使わない。",
    "押さずに打ち返してもよく、無視して別の話をしてもよい。次の発言で消えるので、押されるのを待つ状態にはならない。",
    "",
    "## 設計思想 (構造カスタマイズの要望が来たときの応対)",
    "ChatBanは「会話が構造の代わりをする」ツール。優先度フィールド・タグ・サブタスク階層の追加要望には応じない。列は Todo/Inprogress/Review/Done の4本が固定だが、**任意レーンを最大2本まで足せる** (#19。⚙設定でその列に名前を付けると現れ、Review と Done の間に並ぶ)。列がほしいと言われたらこれを案内する。それ以上は増やさない。",
    "代わりに以下へ誘導する (どれが適切かはニーズを聞いて判断):",
    "- 状態を細かく刻みたい (「検証待ち」等) → その情報はカードのタイトルか summary(現況の1行) に書く。または「検証」を独立カードに分割する",
    "- 分類したい → タイトルの付け方か、reorder_cards の並び順で表現する",
    "- 優先したい → 並び順 (「これ上にして」) で表現する",
    "断るときは設計理由 (語彙が固定だから一言が正確に通じる) を一言添える。",
    "",
    // ---- ここから動的セクション ----
    // #50: ボード状態は「基準スナップショット+変更イベント追記」でプレフィックスを安定させる (promptState.ts)。
    // 温かい間はバイト不変のまま伸びるのでキャッシュが基準部分まで効く。TTL超過時のみ再ベースライン。
    getBoardPromptSection(),
    "",
    // #93: いま見ている画面。発言者と同じくメタ情報 (本文には混ぜない)。
    // 「これ何?」「これ高くない?」のような指示語をタブの文脈で解決するために渡す
    VIEW_HINTS[view ?? ""] ?? "",
    // #14/#126 → #180: ここに「いまの発言者」を渡していた。個人利用に特化したので、
    // 話しかけてくるのは常に持ち主ひとり。名前を毎ターン送っても情報が増えない (実測で
    // null 554件 / "zio" 100件) ため、発言者という概念ごと外した
    cardFocus
      ? [
          "",
          `## いま注目しているカード (このチャットは #${cardFocus.id} 専用)`,
          JSON.stringify(cardFocus),
          `- 「これ」「このカード」等の指示語は #${cardFocus.id} を指す。`,
          `- この会話で決まったこと・分かったことは update_cards の context_append で #${cardFocus.id} の経緯メモに足す (既存を読む必要も版も要らない)。`,
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// #93: 画面ごとの文脈。チャットは常設 (#74) なので、ボード以外を見ているときも
// 「その画面の話」ができないと噛み合わない。操作できないものは断り方まで決めておく。
// 発言者と同じくメタ情報なので、動的セクションの末尾に置く (キャッシュのプレフィックスを崩さない)
const VIEW_HINTS: Record<string, string> = {
  context: [
    "",
    "## いま見ている画面: 📋前提情報",
    "チームの前提情報を見ている。「ここに◯◯を足して」等は update_project_context で反映する。",
  ].join("\n"),
  // #181: 📊コスト と 📜監査 のヒントはここにあった。両タブごと撤去した
  trash: [
    "",
    "## いま見ている画面: 🗑ゴミ箱",
    "削除したカードを見ている。「#xxを戻して」は restore_cards で復元する。",
  ].join("\n"),
  settings: [
    "",
    "## いま見ている画面: ⚙設定",
    "モデル設定を見ている。設定を変えるツールは持っていないので、頼まれても実行せず、意味を説明したうえで「この画面から変更してください」と案内する (例: 対話モデルは応答速度とプロンプトキャッシュが効くので日付つきIDで固定するのが安全)。",
  ].join("\n"),
};

/** ツール実行中の進捗表示 (「カードを追加中…」)。**画面側の trace ラベルとは別物**で、
 * あちらは名詞形 (「カード追加」)。用途が違うので表を分けているが、
 * **どちらも buildTools() の道具立てと合っていないと嘘になる** — 揃っているかは
 * toolLabels.test.ts が見張る (#229: set_view という存在しない道具が載っていた) */
export const TOOL_LABELS: Record<string, string> = {
  create_cards: "カードを追加",
  update_cards: "カードを更新",
  delete_cards: "ゴミ箱へ移動",
  restore_cards: "ゴミ箱から復元",
  update_project_context: "前提情報を更新",
  reorder_cards: "並び順を変更",
  search_cards: "経緯を検索",
  get_cards: "カードを読む",
  query_log: "記録を集計",
};

// #68: 添付は「保存しない蒸留型」— 画像もPDFもそのままLLMに渡し(前処理なし、原本はどこにも残さない)、
// 重要な情報はAIが context / 前提情報に文字で蒸留する (Doneアーカイブ・チャット揮発化と同じ思想)。
// PDFはOpenAIのfileコンテンツパート直投げがOrcaRouter経由で通ることを実測済み (gpt-5.4-miniはfile入力対応)
export interface ChatAttachment {
  kind: "image" | "pdf";
  name: string;
  dataUrl: string;
}

function buildAttachmentParts(attachments: ChatAttachment[]): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  return attachments.map((a) =>
    a.kind === "image"
      ? { type: "image_url", image_url: { url: a.dataUrl } }
      : ({ type: "file", file: { filename: a.name, file_data: a.dataUrl } } as any)
  );
}

/** AI提案チップ (#75): ボードの文脈から「いま価値のある操作」を提案する。
 * チャットと同一のシステムプロンプト+ツール定義で呼ぶことで、キャッシュ済みプレフィックスに相乗りする */
// 提案はボード状態だけの関数なので、同じ状態なら作り直さない。
// StrictModeの二重実行・複数タブ・F5連打・🆕新しい会話のいずれでもLLMを再度叩かずに済む
// (クライアント側を直しても他の経路が残るため、費用の歯止めはサーバー側に置く)
// #209: **プロジェクトごとに持つ。**以前は単一スロットで、タブが別プロジェクトを開いていると
// 読み込むたびに互いを蹴り出して毎回ミスしていた (実測 2026-08-17: #1/#4/#6/#2/#11 の5つが同時に動き、
// 5分TTLがあるのに suggest が781回)。#119 で suggestInflight を同じ理由でプロジェクト単位にしたのに、
// **キャッシュだけ1個のまま残っていた** — 同じ穴を片方だけ塞いだ形
const suggestCache = new Map<number, { value: { label: string; message: string }[]; at: number }>();
// E2Eだけ 0 にする (playwright.config.ts)。#209でキャッシュがボードの中身を見なくなったため、
// テスト側が「ボードを変えてキャッシュを外す」手で呼び出しを起こせなくなった (#162の中断テスト)
const SUGGEST_TTL_MS = Number(process.env.SUGGEST_TTL_MS ?? 5 * 60 * 1000);

/** #209: 起動直後は提案を出さない。**開発中の再起動のたびに全タブが呼び直すのを避ける**ため
 * (tsx watch は1日35回走っていた)。キャッシュはプロセス内なので再起動で空になり、
 * 直後の読み込みは必ずミスする — そこだけ塞ぐ。
 *
 * **タイマーは持たない。**「時間が来たら呼ぶ」ではなく「リクエストが来た時点で判定する」
 * (読み取りは状態を変えない #200 と同じ形)。
 *
 * 環境で分岐させない。NODE_ENV で切ると「開発では出ないが本番では出る」差ができ、
 * 動かして確かめられなくなる。本番は再起動が滅多に無いので存在しないのと同じ */
// E2Eだけ 0 にする (playwright.config.ts)。AUTO_ARCHIVE=0 と同じ形の試験用の口で、
// **NODE_ENV による自動分岐ではない** — 既定は開発でも本番でも同じ60秒
const BOOT_GRACE_MS = suggestBootGraceMs();
const BOOTED_AT = Date.now();
// #119: 同時実行の合流。1本しか持たないと、プロジェクトAの生成中にBが要求したとき
// Aの結果がBへ返る (タブごとに別プロジェクト #97)。
// #209: キーを systemPrompt から**プロジェクトIDへ変えた。**キャッシュがボードの中身を見なく
// なったので、こちらだけ内容単位のままだと「同じプロジェクトで内容が僅かに違うタブ」が並走する
const suggestInflight = new Map<number, Promise<{ label: string; message: string }[]>>();

/** #162: いまチャットを処理中のプロジェクト。提案チップはこの間だけ譲る。
 *
 * 上流が遅いときに並走するとTTFTが目に見えて悪化する (実測: 単独12秒 → chat+chat+suggest の
 * 3本並走で30〜55秒)。しかもチップは「会話が始まる前」にしか表示されない (log.length===0) ので、
 * 送信した瞬間から画面に出る余地が無い — **表示されないものを作るために待たされていた**。
 *
 * プロジェクト単位で持つのは #119 と同じ理由。1本しか持たないと、
 * Aのチャット中にBの提案まで止まる (タブごとに別プロジェクト #97) */
const chatInflight = new Map<number, number>();

export function isChatBusy(projectId: number): boolean {
  return (chatInflight.get(projectId) ?? 0) > 0;
}

/** 進行中の提案生成。チャットが始まったら中断する。
 *
 * 開始時のフラグを見るだけでは**片方向にしか効かない** (外部レビュー指摘)。
 * 実際の画面ではページ表示直後に /api/suggestions が走るので、
 * 「suggest開始 → chat開始」が普通の順番で、そのままでは並走が残っていた。
 *
 * 結果を捨てるだけでは足りない — 上流の応答は待ち続けるので、
 * 止めたかったTTFTの奪い合いがそのまま残る。**接続ごとやめる**必要がある。
 *
 * #209で suggestInflight をプロジェクト単位にしたので並走は起きにくくなったが、
 * 中断は「いま走っているものを全部止める」でよいので Set のまま持つ (取りこぼしを作らない) */
const suggestAborts = new Map<number, Set<AbortController>>();

function abortSuggestsFor(projectId: number): void {
  const set = suggestAborts.get(projectId);
  if (!set?.size) return;
  for (const ac of set) ac.abort();
  set.clear();
  log("chat", `提案の生成を中断しました (project #${projectId} でチャットが始まったため)`);
}

/** 提案チップの生成を**呼ばずに諦める**条件。null なら呼ぶ。
 *
 * #181: ここを純粋関数に切り出したのは、**この判定**をユニットで固定するため
 * (「諦めると決めたとき実際に呼び出しが0回」までは固定していない — 判定と呼び出しの結線は未検証)。
 * それまでは E2E が `llm_calls` の件数差で確かめていたが、計測系の撤去でテーブルが無くなり、
 * 代わりに共有ログの行数を数える形にしたら**開発サーバーの書き込みで誤判定しうる**状態になった
 * (自動レビュー指摘)。判断を関数にすればDBもログも要らない (#91 #57 と同じ形)。
 *
 * 順番に意味がある: 起動猶予が最優先 (再起動直後は全タブが読み直すので、そこだけ止めたい #209)、
 * 次に会話中は譲る (#162)、最後に空ボード (読むべき文脈が無い #86)。
 * **以前はここの先頭がON/OFF設定だった** (#167 で入れ、#199 で全体1つにした) が、#209 で設定ごと撤去した */
export function suggestSkipReason(state: {
  /** 起動からの経過ミリ秒 */
  sinceBootMs: number;
  chatBusy: boolean;
  emptyBoard: boolean;
  /** 起動猶予。**呼び出し側が必ず渡す。**既定値を持たせるとモジュール変数 (= 環境変数) を
   * 読むことになり、「純粋関数だからDBもexpressも要らない」が成り立たなくなる —
   * 実際 #232 の作業中、開発機の SUGGEST_BOOT_GRACE_MS が効いてユニットが2本落ちていた */
  graceMs: number;
}): "booting" | "chat-busy" | "empty-board" | null {
  if (state.sinceBootMs < state.graceMs) return "booting";
  if (state.chatBusy) return "chat-busy";
  if (state.emptyBoard) return "empty-board";
  return null;
}

export async function generateSuggestions(): Promise<{ label: string; message: string }[]> {
  const skip = suggestSkipReason({
    graceMs: BOOT_GRACE_MS,
    sinceBootMs: Date.now() - BOOTED_AT,
    chatBusy: isChatBusy(currentProjectId()),
    // #200: 畳んだ箱も見る。**入口ごとにズレると事故る** — 画面側 (App.tsx の isEmptyBoard) は
    // 箱を見ているので、ここだけカードしか見ないと「板には箱が出ているのに提案だけ空」になる
    emptyBoard: listCards().length === 0 && (foldedContainer(currentProjectId()) ?? []).length === 0,
  });
  if (skip) return [];
  const projectId = currentProjectId();
  const cached = suggestCache.get(projectId);
  // #209: **ボードの中身では判定しない。**以前はキーが systemPrompt の全文で、索引が1バイト違えば
  // 作り直していた (タイトルを直す・列を動かす・カードが1件増える、のたびにミス)。
  // 提案はあれば助かる程度のもので、数分古くても困らない。**「提案は5分間そのまま」**で言い切る
  if (cached && Date.now() - cached.at < SUGGEST_TTL_MS) return cached.value;
  // 同時到着 (StrictModeの二重実行はほぼ同時に来る) は1本にまとめる。
  // **プロンプトを組む前に見る** — 合流するなら組む必要がない
  const running = suggestInflight.get(projectId);
  if (running) return running;
  const systemPrompt = buildSystemPrompt();
  // チャットが始まったら中断できるようにしておく
  const project = projectId;
  const ac = new AbortController();
  const acs = suggestAborts.get(project) ?? new Set<AbortController>();
  acs.add(ac);
  suggestAborts.set(project, acs);
  const job = generateSuggestionsUncached(systemPrompt, ac.signal)
    .then((value) => {
      suggestCache.set(projectId, { value, at: Date.now() });
      return value;
    })
    // 中断は失敗ではない (チャットに譲っただけ)。呼び出し側の catch まで投げず空で返す —
    // /api/suggestions は失敗を空配列に倒すので結果は同じだが、ログにエラーを残さない
    .catch((e) => {
      if (ac.signal.aborted) return [];
      throw e;
    })
    .finally(() => {
      suggestInflight.delete(projectId);
      acs.delete(ac);
      if (acs.size === 0) suggestAborts.delete(project);
    });
  suggestInflight.set(projectId, job);
  return job;
}

async function generateSuggestionsUncached(
  systemPrompt: string,
  signal: AbortSignal
): Promise<{ label: string; message: string }[]> {
  const res = await chatCompletion(
    "suggest",
    getModel("main"),
    {
      messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          'ボードの現状を読んで、いまユーザーにとって価値のある操作を最大3つ提案して。ツールは呼ばない。出力はJSON配列のみ: [{"label":"絵文字+15字以内の短文","message":"チャットにそのまま投げる依頼文"}]。期限接近・依存解除・検収たまりなど文脈が根拠のものを優先。',
      },
      ],
      // #208: **ツール定義を渡さない。**上のプロンプトが「ツールは呼ばない」と言っている相手に
      // 9本ぶんの定義を積んでいた。実測で 1リクエストの入力 15,408字(~9,064tk) のうち
      // **ツール定義が 9,793字(~5,761tk) = 64%** (scripts/prompt-breakdown.ts)。
      // 提案チップは入力トークンの8割を占めるので (8/17-18: 11,775,075 / 14,623,079)、
      // ここが全体の43%を「使わない説明文」に使っていたことになる。
      //
      // 前置きが chat と別になるぶんキャッシュは分かれるが、システムプロンプトだけでも
      // 3,303tk あり OpenAI の最小長(1024tk)を超えるので、suggest 単独でキャッシュに乗る。
      // chat 側の前置きは無改造なのでそちらは影響を受けない
    },
    { signal }
  );
  const text = res.choices[0].message.content ?? "";
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s: any) => typeof s?.label === "string" && typeof s?.message === "string")
      .slice(0, 3);
  } catch {
    return [];
  }
}

export async function runChatTurn(
  userMessage: string,
  history: { role: "user" | "assistant"; content: string }[],
  onEvent: (kind: ViewEvent) => void,
  onProgress?: (label: string) => void,
  cardFocusId?: number,
  attachments?: ChatAttachment[],
  view?: string
): Promise<ChatResult> {
  const project = currentProjectId();
  chatInflight.set(project, (chatInflight.get(project) ?? 0) + 1);
  // 先に始まっていた提案生成は捨てる。フラグだけでは「chat→suggest」の順しか止められず、
  // 実際の画面で普通に起きる「suggest→chat」の順で並走が残っていた (外部レビュー指摘)
  abortSuggestsFor(project);
  try {
    return await runChatTurnInner(
      userMessage,
      history,
      onEvent,
      onProgress,
      cardFocusId,
      attachments,
      view
    );
  } finally {
    const n = (chatInflight.get(project) ?? 1) - 1;
    if (n > 0) chatInflight.set(project, n);
    else chatInflight.delete(project);
  }
}

async function runChatTurnInner(
  userMessage: string,
  history: { role: "user" | "assistant"; content: string }[],
  onEvent: (kind: ViewEvent) => void,
  onProgress?: (label: string) => void,
  cardFocusId?: number,
  attachments?: ChatAttachment[],
  view?: string
): Promise<ChatResult> {
  const t0 = Date.now();
  const cardFocus = cardFocusId != null ? getCard(cardFocusId) : undefined;
  // #68: 添付はそのままコンテンツパートでLLMへ (画像=vision / PDF=file直投げ)。原本は保存しない
  const fileParts = attachments && attachments.length > 0 ? buildAttachmentParts(attachments) : [];
  // #14: 発言者の記名。「終わりました」等の曖昧参照を解決するためのメタ情報であって発言内容ではない。
  // 以前は本文の先頭に [発言者: xxx] を足していたが、LLMがそれをカードのタイトルや経緯メモへ
  // そのまま書き写す事故が起きた (#95のタイトルに混入)。メタ情報は本文に混ぜず、
  // システムプロンプト側に「書き写すな」と添えて置く
  const baseText =
    userMessage +
    (fileParts.length > 0
      ? `\n[添付${fileParts.length}件 (${attachments!.map((a) => a.name).join(", ")}) — 内容を読み取って活用すること]`
      : "");
  const userContent: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"] =
    fileParts.length > 0 ? [{ type: "text", text: baseText }, ...fileParts] : baseText;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(cardFocus, view) },
    ...history.slice(-20),
    { role: "user", content: userContent },
  ];
  const trace: ToolTrace[] = [];
  const uiActions: UiAction[] = [];
  const usage: ChatResult["usage"] = { rounds: 0, elapsedMs: 0 };
  let reply = "";
  // ラウンドをまたいで**同じ配列を使い回す**。#106 でプレフィックスをバイト単位で安定させてあるので、
  // 毎ラウンド組み直すとレーン名が同じでも整形が揺れうる。1ターンの中では固定してキャッシュを守る
  const tools = buildTools(customLanes());

  for (let round = 0; round < 8; round++) {
    const res = await chatCompletion("chat", getModel("main"), { messages, tools });
    usage.rounds++;
    const msg = res.choices[0].message;
    messages.push(msg);
    if (msg.tool_calls?.length) {
      const events = new Set<string>();
      for (const tc of msg.tool_calls) {
        if (tc.type !== "function") continue;
        let args: any = {};
        let broken = false;
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* 引数パース失敗時は空で実行し、エラーはツール結果に出る */
          broken = true;
        }
        onProgress?.(TOOL_LABELS[tc.function.name] ?? tc.function.name);
        // #254: **MCP側と同じ規則で記録する** (`mcpLog` は入口に依存しない純粋関数)。
        // 以前はここが引数JSONを無加工で先頭200字残していて、**経緯メモの本文が
        // ディスクに落ちていた** — MCP側が「値は元から1文字も出さない」なのと正反対だった。
        // 整形されたJSONなら改行で1回の呼び出しが複数行に見えるので、行数の集計もこちらだけ崩れる。
        //
        // **失敗しても1行残す** (finally)。ターンが例外で終わると `saveChatMessage` まで
        // 届かず `trace` がDBに残らないので、**落ちたターンで何を呼んだかはここにしか無い**
        const started = Date.now();
        let outcome = "ok";
        let result: unknown;
        try {
          result = await execTool(tc.function.name, args, events as Set<string>);
          outcome = outcomeOf(result);
        } catch (e) {
          // 例外はそのまま投げ直す。**記録だけ足す**。
          // 本文を出さない理由は throwOutcome に書いてある (MCP側と同じ規則 #254)
          outcome = throwOutcome(e);
          throw e;
        } finally {
          const detail = argDetail(tc.function.name, args, isFailure(outcome));
          log(
            "tool",
            `${safeToolName(tc.function.name)} ${outcome} | ${broken ? "(引数が壊れている)" : argShape(args)} | ` +
              `${Date.now() - started}ms` +
              (detail ? ` | ${detail}` : "")
          );
        }
        // #256 (Codexレビュー P2): **trace はDBに残る。**`chat_messages.trace` に保存されるので、
        // ログから外しただけでは「成功した回の目的は捕らない」が成立しない
        // (ログは失敗時だけ、DBには全部、という**入口の中でねじれた状態**になっていた)。
        // `goal` は自由文で語の許可リストが効かないぶん、**残す場所を1つに決める** —
        // 記録はログ行だけ。会話の記録には載せない
        trace.push({ tool: tc.function.name, input: withoutGoal(args), result });
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      for (const e of events) onEvent(e as ViewEvent);
      continue;
    }
    reply = typeof msg.content === "string" ? msg.content : "";
    break;
  }
  usage.elapsedMs = Date.now() - t0;
  const picked = extractChoices(reply);
  if (picked.options.length > 0) {
    // 抽出前の生テキストを残す。保存されるのは抽出後なので、記法の書かれ方を後から追えるのはここだけ
    // #259: 本文かどうかの判断と伏せ方は mcpLog に寄せた (呼ぶ側で書くと掛け忘れる)
    log("choices", choicesDetail(reply, picked.options));
    reply = picked.text;
    uiActions.push({ type: "ask", options: picked.options });
  }
  return { reply, trace, uiActions, usage };
}

/** 応答まるごとが2回書かれていたら1回に畳む。
 *
 * 実測: [[選択肢]] の記法を使った応答で、同じ本文+同じ選択肢を2回続けて書くことがある
 * (2/2で再現。記法を使わない応答では起きていない)。原因はモデル側なので、
 * プロンプトで直そうとせずここで畳む — 「間違えないようにする」ではなく
 * 「間違えても取り返しがつく」に寄せる、このプロジェクトの既定方針と同じ扱い。 */
function dedupeRepeatedBody(s: string): string {
  // 実測の形は「本文 \n 同じ本文」。区切りの改行があるので長さの折半では割れない
  const m = /^([\s\S]{8,}?)\s*\n\s*\1$/.exec(s.trim());
  return m ? m[1] : s;
}

/** 本文中の [[選択肢]] を返信ボタンとして取り出す。
 *
 * 最初はツール(ask)にしていたが、実測で自発的にはまったく呼ばなかった(0/3。
 * ツール定義とルール文を強めても変わらず)。他のツールは「呼ばないと目的を達成できない」のに対し、
 * これだけは本文に箇条書きすれば同じことが伝わるので、呼ぶ動機が生まれない。
 * 記法なら新しい行動ではなく書き方の指定で済み、生成の流れにそのまま乗る (zio案)。 */
export function extractChoices(reply: string): { text: string; options: string[] } {
  const options: string[] = [];
  const text = dedupeRepeatedBody(reply)
    .replace(/\[\[([^\[\]\n]{1,24})\]\]/g, (_m, label: string) => {
      const v = label.trim();
      if (v && options.length < 4 && !options.includes(v)) options.push(v);
      return "";
    })
    // 選択肢だけの行が空行として残るので畳む
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, options };
}
