import {
  detachTaskFromCard,
  getOrCreateActiveCard,
  getSummaryCard,
  assignTaskToCard,
  deleteSummaryCards,
  listSummaryCards,
  reassignTasksToCard,
  setCardSettled,
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

export async function regenerateCard(cardId: number): Promise<SummaryCard | undefined> {
  const card = getSummaryCard(cardId);
  if (!card) return undefined;
  const tasks = tasksOfCard(cardId);
  if (tasks.length === 0) {
    updateCardContent(cardId, null, card.elements.filter((e) => e.checked));
    return getSummaryCard(cardId);
  }
  const taskData = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    assignee: t.assignee,
    reason: t.reason,
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

  // タイトル: 見出しラベルはコスト優先ルーティング(定型)、件数は機械で付与(LLMに数えさせない)
  let label = "";
  try {
    const titleRes = await chatCompletion("archive-title", getModel("cheap"), {
      messages: [
        {
          role: "system",
          content:
            "完了タスク要約カードの見出しラベルを1つだけ生成。「8/9午前の完了」のような日付ベースの短い形式。件数は書かない。ラベルテキストのみ出力。",
        },
        {
          role: "user",
          content: `今日: ${new Date().toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}`,
        },
      ],
    });
    label = (titleRes.choices[0].message.content ?? "").trim().split("\n")[0].replace(/[(（]\d+件[)）]/g, "").trim().slice(0, 40);
  } catch (e: any) {
    log("archive", `title generation failed (fallback): ${e?.message ?? e}`);
  }
  // 件数はUI側で taskIds.length から表示するので、タイトルはラベルのみ持つ
  const title = label || `${new Date().toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}の完了`;

  updateCardContent(cardId, title, elements);
  log("archive", `card#${cardId} regenerated: ${tasks.length} tasks -> ${elements.length} elements`);
  return getSummaryCard(cardId);
}

/** 完了タスク群をアクティブカードに合流させ、生データから要約を再生成する。
 * #60: 一括検収で複数doneが来ても再生成(LLM呼び出し)は1回で済むようバッチで受ける */
export async function onTasksCompleted(taskIds: number[]): Promise<SummaryCard | undefined> {
  if (taskIds.length === 0) return undefined;
  const card = getOrCreateActiveCard();
  for (const id of taskIds) assignTaskToCard(id, card.id);
  return regenerateCard(card.id);
}

/** doneから戻されたタスクをカードから外し、要約を作り直す */
export async function onTaskReopened(taskId: number): Promise<SummaryCard | undefined> {
  const cardId = detachTaskFromCard(taskId);
  if (!cardId) return undefined;
  return regenerateCard(cardId);
}

/** 過去ログ整頓: 全カードを1枚のsettled過去ログに統合 (生データから再要約するので薄まらない)。
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
  await regenerateCard(keep.id);
  setCardSettled(keep.id);
  const card = getSummaryCard(keep.id);
  log("archive", `compacted ${targets.length} cards -> card#${keep.id} (${allTaskIds.length} tasks, settled)`);
  return { merged: targets.length, card };
}
