import {
  detachTaskFromCard,
  createSummaryCard,
  getSummaryCard,
  assignTaskToCard,
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
import { chatCompletion, getModel } from "./llm.js";
import { log } from "./log.js";

// Doneアーカイブ+要約常駐 (docs/done-archive-design.md + zio設計判断)
//  - 完了と同時にアーカイブし「まだ見ていない要約(アクティブカード)」に合流 (Done列に生カードは滞留しない)
//  - 要約の再生成は常にカード配下のタスク原本(生データ)から行う → 劣化コピー問題が構造的に起きない
//  - チェック済み要素は文言を変えない (人間が確認した内容を勝手に書き換えない)
//  - 要素分解=判断寄り→品質優先モデル / タイトル生成=定型→コスト優先ルーティング (purpose別にllm_calls記録)

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

/** カードの要約を作り直す。dateLabelを渡すとタイトル生成をせずそのラベルを使う (日次まとめ用) */
export async function regenerateCard(cardId: number, dateLabel?: string): Promise<SummaryCard | undefined> {
  const card = getSummaryCard(cardId);
  if (!card) return undefined;
  const tasks = tasksOfCard(cardId);
  if (tasks.length === 0) {
    updateCardContent(cardId, null, card.elements.filter((e) => e.checked));
    return getSummaryCard(cardId);
  }
  // #92: 経緯メモ(context)と現況(summary)も渡す。タイトルだけでは「何をしたか」しか残らず、
  // 「なぜそうしたか」が蒸留に入らない — 経緯を貯めても要約に活きないなら貯める意味が薄い。
  // contextは長くなりがちなので頭を切る (要約の材料には結論と理由があれば足りる)
  const taskData = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    assignee: t.assignee,
    reason: t.assignReason,
    ...(t.summary ? { summary: t.summary } : {}),
    ...(t.context ? { context: t.context.slice(0, 800) } : {}),
    ...(t.rejected ? { rejected: true } : {}),
  }));
  const checkedElements = card.elements.filter((e) => e.checked);

  // 要素分解 (品質が肝・非同期なのでレイテンシ許容): ルーティング委任
  const res = await chatCompletion("archive-decompose", getModel("archive"), {
    messages: [
      {
        role: "system",
        content: [
          "完了タスク群を、人間が後で確認する価値のある単位に分解して要約する。",
          "ルール:",
          "- 単なる件数ではなく、決定事項・担当の偏り・成果の内容が残る形に凝縮する",
          "- context(経緯メモ)には「なぜそうしたか」「何を検討して何を捨てたか」が書かれている。タイトルの言い換えで終わらせず、そこにしかない判断を要素文に残す (例: 「並べ替えを実装」ではなく「並べ替えはソートキー方式を捨て、LLMが決めた順番を受け取る方式にした」)",
          "- 関連するタスクはまとめて1要素にする。タスクIDを #n 形式で含める",
          "- 些末なタスク(動作検証・軽微な修正等)は独立要素にせず省いてよい。省いた分は末尾に「ほか軽微N件 (#x, #y)」として1行でまとめる",
          "- rejected=true のタスクは「やらないと決めた」決定。省かず、要素の先頭に【却下】と付け、reason の却下理由を要素文に残す (なぜやらないかが後から分かるように)",
          "- 「確認済み要素」に既に含まれている内容は出力しない (その要素は変更せず保持される)",
          "- 2〜5要素程度、各1文",
          '- 出力はJSON文字列配列のみ: ["要素1", "要素2"]',
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({ 確認済み要素: checkedElements.map((e) => e.text), 完了タスク: taskData }),
      },
    ],
  });
  const newTexts = extractJsonArray(res.choices[0].message.content ?? "") ?? [
    `${tasks.length}件の完了: ${tasks.map((t) => `#${t.id}`).join(", ")}`,
  ];
  const elements: SummaryElement[] = [...checkedElements, ...newTexts.map((text) => ({ text, checked: false }))];

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
    updateCardContent(cardId, label, elements);
  }
  return getSummaryCard(cardId);
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

  // #105: 要約生成は15〜30秒かかる。その間にDoneから戻されたタスクをアーカイブすると
  // 「todoなのに archived=1 でボードから消える」幽霊ができるので、いまも done のものだけ入れる
  const stillDone = taskIds.filter((id) => getTask(id)?.status === "done");
  if (stillDone.length === 0) {
    log("archive", `tasksCompleted [${taskIds.join(",")}]: 全件doneでなくなっていたのでアーカイブしない`);
    return undefined;
  }
  if (stillDone.length < taskIds.length) {
    log("archive", `tasksCompleted: ${taskIds.length - stillDone.length}件はdoneでなくなっていたので除外`);
  }
  const card = createSummaryCard();
  for (const id of stillDone) assignTaskToCard(id, card.id);
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
