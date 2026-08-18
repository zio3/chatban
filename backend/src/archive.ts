import {
  detachTaskFromCard,
  createSummaryCard,
  getSummaryCard,
  createCardWithClaimedTasks,
  deleteSummaryCards,
  getTask,
  listSummaryCards,
  reassignTasksToCard,
  setCardFrozen,
  tasksOfCard,
  updateCardContent,
  type SummaryCard,
  type SummaryElement,
} from "./db.js";
import { chatCompletion } from "./llm.js";
import { getModel } from "./config.js";
import { log } from "./log.js";

// Doneアーカイブ+要約常駐 (docs/done-archive-design.md + zio設計判断)
//  - 完了と同時にアーカイブし「まだ見ていない要約(アクティブカード)」に合流 (Done列に生カードは滞留しない)
//  - 要約の再生成は常にカード配下のタスク原本(生データ)から行う → 劣化コピー問題が構造的に起きない
//  - チェック済み要素は文言を変えない (人間が確認した内容を勝手に書き換えない)
//  - 要素分解=判断寄り→品質優先モデル / タイトル生成=定型→軽いモデル (purpose はログに出る)

function extractJsonArray(text: string): string[] | null {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr;
  } catch {
    /* fallthrough */
  }
  return null;
}

const todayLabel = () => `${new Date().toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}の完了`;

/** 中身が何だったかを表す短い見出し。失敗時はnullを返して呼び出し側でフォールバックさせる */
async function generateContentLabel(titles: string[]): Promise<string | null> {
  try {
    const res = await chatCompletion(
      "archive-title",
      getModel("cheap"),
      {
      messages: [
        {
          role: "system",
          content:
            "完了タスク群の見出しラベルを1つだけ生成する。そのまとまりが何だったか一目で分かる短い日本語(20字以内)。日付は入れない。件数も書かない。ラベルテキストのみ出力。例: 「プロジェクト分離まわり」「削除の可逆化と検索」",
        },
        { role: "user", content: titles.map((t) => `- ${t.slice(0, 40)}`).join("\n") },
      ],
    });
    const label = (res.choices[0].message.content ?? "")
      .trim()
      .split("\n")[0]
      .replace(/[(（]\d+件[)）]/g, "")
      .replace(/^["「』]|["」』]$/g, "")
      .trim()
      .slice(0, 40);
    return label || null;
  } catch (e: any) {
    log("archive", `title generation failed (fallback): ${e?.message ?? e}`);
    return null;
  }
}

/** 要素分解に投げる中身を組み立てる。regenerateCard と比較スクリプトで同じものを使う
 * (プロンプトを二重管理しないため。scripts/compare-archive-models.ts) */
export function buildDecomposeMessages(tasks: ReturnType<typeof tasksOfCard>, checkedTexts: string[]) {
  // #92: 経緯メモ(context)を渡す。タイトルだけでは「何をしたか」しか残らず、
  // 「なぜそうしたか」が蒸留に入らない — 経緯を貯めても要約に活きないなら貯める意味が薄い。
  // contextは長くなりがちなので頭を切る (要約の材料には結論と理由があれば足りる)
  //
  // summary は渡さない。「いま何が起きているか」を書く欄なので、Doneに入った時点で
  // 中身が過去のものになり、「現在は検収待ちの状態である」が要約に載る事故が起きた。
  // 渡さなければそもそも起きない (「プロンプトは漏れるが、経路が無いことは漏れない」)。
  // 内容としても context に同じことがより詳しく書いてある。
  const base = (t: ReturnType<typeof tasksOfCard>[number]) => ({
    id: t.id,
    title: t.title,
    ...(t.context ? { context: t.context.slice(0, 800) } : {}),
  });

  // 完了と却下を配列ごと分ける (zio案)。以前は rejected: true を混ぜて渡し、
  // 「rejected=true のものには【却下】を付けろ」とプロンプトで指示していたが、
  // 却下が1件も無い材料に対して【却下】を付けるモデルが複数あった (opus-4.8 / gpt-5.4-mini)。
  // 保留のタスクを「却下した」と書かれるのは、後から読む人間にとって一番害が大きい。
  //
  // 分けてしまえば、却下が無いときは却下タスクのキーごと出ないので、
  // 【却下】を付ける材料が存在しない。判断させずに構造で決める。
  const doneTasks = tasks.filter((t) => !t.rejected).map(base);
  // #179: 却下理由は assign_reason に入れていたが、担当理由と同じ列を使い回していた。
  // いまの契約 (REJECTED_DESCRIPTION) では却下理由は summary と経緯メモに書くので、
  // context を渡している base だけで足りる
  const rejectedTasks = tasks.filter((t) => t.rejected).map(base);

  const messages = [
    {
      role: "system" as const,
      content: [
        "ボードから退場したタスク群を、人間が後で確認する価値のある単位に分解して要約する。",
        "渡されるタスクは、すべて人間の検収を通って確定したもの。終わった仕事の記録を書く。",
        "",
        "材料は2つに分かれている:",
        "- 完了タスク … やり切ったもの。関連するものはまとめて凝縮する",
        "- 却下タスク … やらないと決めたもの。**このキーが無いときは、却下されたタスクは1件も無い**",
        "",
        "ルール:",
        "- 単なる件数ではなく、決定事項・成果の内容が残る形に凝縮する",
        "- context(経緯メモ)には「なぜそうしたか」「何を検討して何を捨てたか」が書かれている。タイトルの言い換えで終わらせず、そこにしかない判断を要素文に残す (例: 「並べ替えを実装」ではなく「並べ替えはソートキー方式を捨て、LLMが決めた順番を受け取る方式にした」)",
        "- まだ決まっていないこと(検討中・保留・候補を挙げた段階)は、決まったように書かない。材料にそう書いてあるとおりに「保留」「未定」と書く",
        "- 完了タスクは、関連するものをまとめて1要素にする。タスクIDを #n 形式で含める",
        "- 完了タスクのうち些末なもの(動作検証・軽微な修正等)は独立要素にせず省いてよい。省いた分だけを末尾に「ほか軽微N件 (#x, #y)」としてまとめる。本文の要素で既に触れたIDをここに再掲しない",
        "- 却下タスクは1件ずつ独立した要素にし、先頭に【却下】と付けて却下理由を残す (なぜやらないかが後から分かるように)",
        "- 「確認済み要素」に既に含まれている内容は出力しない (その要素は変更せず保持される)",
        "- 完了タスクからは2〜5要素程度。各1文",
        '- 出力はJSON文字列配列のみ: ["要素1", "要素2"]',
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        確認済み要素: checkedTexts,
        完了タスク: doneTasks,
        // 却下が無ければキーごと出さない。「無い」ことを書かずに済ませるのが肝
        ...(rejectedTasks.length > 0 ? { 却下タスク: rejectedTasks } : {}),
      }),
    },
  ];
  return { messages, taskData: [...doneTasks, ...rejectedTasks] };
}

/** カードの要約を作り直す。dateLabelを渡すとタイトル生成をせずそのラベルを使う (日次まとめ用) */
export async function regenerateCard(cardId: number, dateLabel?: string): Promise<SummaryCard | undefined> {
  const card = getSummaryCard(cardId);
  if (!card) return undefined;
  const tasks = tasksOfCard(cardId);
  if (tasks.length === 0) {
    updateCardContent(cardId, null, card.elements.filter((e) => e.checked));
    return getSummaryCard(cardId);
  }
  const checkedElements = card.elements.filter((e) => e.checked);
  const { messages, taskData } = buildDecomposeMessages(tasks, checkedElements.map((e) => e.text));
  // 生成を始めた時点の顔ぶれ。LLMを待っている間にカードの中身が変わったら、
  // この結果はもう古い (下の isStale を参照)
  const startedWith = tasks.map((t) => t.id);

  // 要素分解 (品質が肝・非同期なのでレイテンシ許容): ルーティング委任
  // 応答が読めなかったときに使う代替。**中身が空のカードを残さないためのもの**で、
  // これがあれば「何が畳まれたか」はIDから辿れる
  const fallback = [`${tasks.length}件の完了: ${tasks.map((t) => `#${t.id}`).join(", ")}`];

  // #191: **上流が落ちても空のカードを残さない (失効キーで実測)。**
  // onTasksCompleted は「カード作成 → タスクをアーカイブ → ここで要約」の順なので、
  // ここで例外が飛ぶと**前の2つはコミット済み**。検収した成果がボードから消えたうえで、
  // 中身が空のカードだけが残っていた。しかもUIは空のカードを「要約を生成中…」と
  // 表示するので、**二度と動かないものを待たせる**ことになる。
  //
  // 代替要素は「応答が壊れていたとき」用に既にあったので、**例外にも同じものを使う**。
  // 失敗したことも1行足す — 静かに劣化させると、あとで見た人が「これで全部」と読む
  let newTexts: string[];
  try {
    const res = await chatCompletion("archive-decompose", getModel("archive"), { messages });
    newTexts = extractJsonArray(res.choices[0].message.content ?? "") ?? fallback;
  } catch (e: any) {
    // e.message は chatCompletion の出口で伏字済み (キーは載らない)
    log("archive", `card#${cardId} の要約生成が失敗: ${e?.message ?? e} — 代替の要素で埋めます`);
    newTexts = [...fallback, `(要約の生成に失敗しました。もう一度畳み直すと作り直します)`];
  }
  const elements: SummaryElement[] = [...checkedElements, ...newTexts.map((text) => ({ text, checked: false }))];

  // 生成中にカードの顔ぶれが変わっていたら、この結果は捨てる。
  //
  // regenerateCard は「読む → LLMを待つ(10〜100秒) → 同じカードへ保存」なので、
  // 待っている間に onTaskReopened でタスクが外れたり、次の検収バッチが走ったりすると、
  // 古い顔ぶれで作った要約が後から新しい要約を上書きする。
  // 実測: 2件で生成を始め、途中で1件外し、1件で作り直したあとに先発が完了すると、
  // 外したはずのタスクが要約に残った。
  //
  // 直列化ではなく世代チェックにしたのは、遅い方を待たせても結果が古いことは変わらないため。
  // 捨てたぶんは、外した側の処理 (onTaskReopened / onTasksCompleted) が改めて生成する
  if (isStale(cardId, startedWith)) {
    log("archive", `card#${cardId} の要約を破棄 (生成中に構成が変わった: [${startedWith}] → [${tasksOfCard(cardId).map((t) => t.id)}])`);
    return getSummaryCard(cardId);
  }

  // 要素を先に保存する。以前はタイトル生成の後にまとめて保存していたため、
  // 安いタイトル生成が詰まると、高い要素分解(57秒かけて成功)の結果まで失われていた。
  // 高い処理の成果を、安い処理の成否に人質に取らせない
  updateCardContent(cardId, dateLabel ?? null, elements);
  log("archive", `card#${cardId} regenerated: ${tasks.length} tasks -> ${elements.length} elements`);

  // タイトル: 見出しラベルはコスト優先ルーティング(定型)、件数は機械で付与(LLMに数えさせない)。
  // #105: カードが検収バッチごとに複数並ぶようになったので、日付ラベルでは区別できない。
  // 中身のタスクを渡して内容ラベルを作らせる (日次まとめ済みのカードだけは日付ラベルのまま)
  if (!dateLabel) {
    const label = (await generateContentLabel(taskData.map((t) => t.title))) ?? todayLabel();
    // タイトル生成の間にも構成は変わりうる。ここで書き戻すと、上で捨てたはずの
    // 古い elements がタイトルと一緒に復活してしまう
    if (isStale(cardId, startedWith)) {
      log("archive", `card#${cardId} のタイトルを破棄 (タイトル生成中に構成が変わった)`);
      return getSummaryCard(cardId);
    }
    updateCardContent(cardId, label, elements);
  }
  return getSummaryCard(cardId);
}

/** 生成を始めた時点の顔ぶれと、いまの顔ぶれが違うか。
 * カードごと消えている場合も「古い」扱いにする (消えたカードに書き戻すと復活する) */
function isStale(cardId: number, startedWith: number[]): boolean {
  if (!getSummaryCard(cardId)) return true;
  return differs(tasksOfCard(cardId).map((t) => t.id), startedWith);
}

/** 顔ぶれが変わったか。DBに触らない部分だけ切り出してテストできるようにする */
export function differs(now: number[], startedWith: number[]): boolean {
  return now.length !== startedWith.length || now.some((id, i) => id !== startedWith[i]);
}

/** #105: 1日経ったカードを日単位に統合する。粒度は時間とともに粗くなる:
 *   直近=検収バッチごと(内容ラベル) → 1日経過=その日1枚(日付ラベル) → 手動整頓=全部で1枚(frozen)
 * 放っておくとバッチ単位のカードが増え続けるので、古くなったものから自動で畳む。
 * frozenにはしない — 過去ログ化の引き金は手動整頓だけ、という #58 の定義を壊さないため。
 *
 * 将来案: レンジを日だけでなく週・月・四半期・年へ段階的に上げていくと、
 * 何年運用しても常駐する要約カードの枚数が対数的にしか増えない (CLAUDE.mdに記載)。
 */
async function rollUpOldCards(): Promise<void> {
  const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
  const byDate = new Map<string, SummaryCard[]>();
  for (const c of listSummaryCards()) {
    if (c.frozen || c.taskIds.length === 0) continue;
    const date = c.createdAt.slice(0, 10);
    if (date >= today) continue; // 今日のぶんは細かいまま残す
    byDate.set(date, [...(byDate.get(date) ?? []), c]);
  }
  for (const [date, cards] of byDate) {
    if (cards.length < 2) continue; // 1枚しかない日は畳む必要がない
    const keep = cards[0];
    reassignTasksToCard(cards.flatMap((c) => c.taskIds), keep.id);
    deleteSummaryCards(cards.slice(1).map((c) => c.id));
    updateCardContent(keep.id, null, []); // 白紙にしてから原本で作り直す (要約の要約にしない)
    const [, m, d] = date.split("-");
    await regenerateCard(keep.id, `${Number(m)}/${Number(d)}の完了`);
    log("archive", `rolled up ${cards.length} cards of ${date} -> card#${keep.id}`);
  }
}

/** 完了タスク群を新しいカードにまとめ、生データから要約を再生成する。
 * #60: 一括検収で複数doneが来ても再生成(LLM呼び出し)は1回で済むようバッチで受ける
 * #105: バッチごとに新しいカードを作る (以前は1枚のアクティブカードに合流し続けていた) */
export async function onTasksCompleted(taskIds: number[]): Promise<SummaryCard | undefined> {
  if (taskIds.length === 0) return undefined;
  await rollUpOldCards(); // 先に古いぶんを畳んでから、今回のバッチを新しいカードにする

  // #105 → #195: 要約生成は15〜30秒かかり、`rollUpOldCards()` の await もある。
  // その間に対象の状態は変わりうるので、**「読んだ時点でdoneだった」を根拠に書かない**。
  // 条件つきUPDATEで押さえ (claimTasksForCard)、**押さえられたものだけ**をカードに入れる:
  //   - Doneから戻された → 「todoなのに archived=1 でボードから消える」幽霊を作らない (#105)
  //   - ゴミ箱へ入れられた → ゴミ箱と要約カードの両方に入るのを防ぐ (Codexレビュー指摘)
  //   - 別の経路が先に畳んだ (起動時の掃除 #195 と通常のフックが重なる) → 二重取りしない
  // **カードの作成と claim は1つのトランザクション。**別々にすると、カードを作った直後に
  // プロセスが止まったときに空のカードが残る — この札が塞ごうとしている事故そのものを
  // 自分の実装で作ることになる (Codexレビュー指摘)。押さえられなければカードごと巻き戻る
  const result = createCardWithClaimedTasks(taskIds);
  if (!result) {
    log("archive", `tasksCompleted [${taskIds.join(",")}]: 畳める対象が無かったのでカードは作らない`);
    return undefined;
  }
  const { card, claimed, staleCards } = result;
  if (claimed.length < taskIds.length) {
    const skipped = taskIds.filter((id) => !claimed.includes(id));
    log("archive", `tasksCompleted: #${skipped.join(", #")} は畳まなかった (done以外・ゴミ箱・畳み済みのいずれか)`);
  }
  // **タスクが出ていった旧カードの本文も作り直す** (Codexレビュー指摘)。索引だけ直すと、
  // 出ていったタスクを説明する古い要約が残る。空になった旧カードは claim の中で消えている
  for (const stale of staleCards) {
    log("archive", `card#${stale} は構成が変わったので作り直します (タスクが card#${card.id} へ移動)`);
    await regenerateCard(stale);
  }
  return regenerateCard(card.id);
}

/** doneから戻されたタスクをカードから外し、要約を作り直す。
 * #105: 最後の1件が抜けて空になったカードは消す (チェックボックス廃止済みなので残す意味がない) */
export async function onTaskReopened(taskId: number): Promise<SummaryCard | undefined> {
  const cardId = detachTaskFromCard(taskId);
  if (!cardId) return undefined;
  if (tasksOfCard(cardId).length === 0) {
    deleteSummaryCards([cardId]);
    log("archive", `card#${cardId} became empty -> deleted`);
    return undefined;
  }
  return regenerateCard(cardId);
}

/** 過去ログ整頓: 全カードを1枚のfrozen過去ログに統合 (生データから再要約するので薄まらない)。
 * #58: 過去ログ化(settle)の唯一の引き金。次の完了から新しいアクティブカードが始まる */
export async function compactArchive(): Promise<{ merged: number; card?: SummaryCard }> {
  const targets = listSummaryCards().filter((c) => c.taskIds.length > 0);
  if (targets.length === 0) return { merged: 0 };
  const keep = targets[0];
  const allTaskIds = targets.flatMap((c) => c.taskIds);
  reassignTasksToCard(allTaskIds, keep.id);
  deleteSummaryCards(targets.slice(1).map((c) => c.id));
  // 白紙にしてから全生データで再要約 (要約の要約ではなく原本から作り直す)
  updateCardContent(keep.id, null, []);
  await regenerateCard(keep.id, todayLabel());
  setCardFrozen(keep.id);
  const card = getSummaryCard(keep.id);
  log("archive", `compacted ${targets.length} cards -> card#${keep.id} (${allTaskIds.length} tasks, frozen)`);
  return { merged: targets.length, card };
}
