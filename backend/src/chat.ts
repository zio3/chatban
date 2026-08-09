import type OpenAI from "openai";
import { compactArchive } from "./archive.js";
import {
  assignmentHistory,
  createProposal,
  createTask,
  deleteTask,
  getProjectContext,
  listPendingProposals,
  listSummaryCards,
  listTasks,
  memberLoads,
  setProjectContext,
  updateTask,
} from "./db.js";
import { chatCompletion, MODELS } from "./llm.js";
import { log } from "./log.js";
import type { TaskStatus, UiAction } from "./types.js";

export interface ToolTrace {
  tool: string;
  input: unknown;
  result: unknown;
}

export interface ChatResult {
  reply: string;
  trace: ToolTrace[];
  uiActions: UiAction[];
  usage: { promptTokens: number; completionTokens: number; rounds: number; elapsedMs: number };
}

const STATUS_VALUES = ["todo", "inprogress", "review", "done"];

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_tasks",
      description: "タスクをボードに追加する(複数可)。ユーザーが登録を指示したときだけ使う。候補を出すだけの段階では使わない",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                assignee: { type: "string", description: "担当者名。未定なら省略" },
                reason: { type: "string", description: "その担当にした理由。指名時は「指名」など" },
              },
              required: ["title"],
            },
          },
        },
        required: ["tasks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_tasks",
      description:
        "既存タスクの状態・担当・タイトルを更新する(複数可)。指名割り振り(「1は佐藤に」)や完了報告(「1終わりました」→status=done)に使う",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                title: { type: "string" },
                status: { type: "string", enum: STATUS_VALUES },
                assignee: { type: "string" },
                reason: { type: "string", description: "担当変更の理由" },
                lane: {
                  type: ["string", "null"],
                  enum: ["demo", "later", null],
                  description: "台本レーン。demo=デモ台本に必要, later=機能凍結後, null=未分類",
                },
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
      name: "delete_tasks",
      description: "タスクを削除する(複数可)",
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
      name: "propose_assignments",
      description:
        "担当未定タスクの割り振り案を提案する。委任(「いい感じに振っといて」)のときに使う。直接assigneeを書き換えず、必ずこの提案を経由して人間の承認を待つ。理由には現在の負荷や過去の類似タスク履歴を根拠として書く",
      parameters: {
        type: "object",
        properties: {
          proposals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                taskId: { type: "integer" },
                assignee: { type: "string" },
                reason: { type: "string", description: "負荷・履歴・スキルに基づく理由" },
              },
              required: ["taskId", "assignee", "reason"],
            },
          },
        },
        required: ["proposals"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compact_archive",
      description:
        "確認済み(全要素チェック済み)の要約カードを1枚に統合する(「ログ整頓して」)。生データから再要約するので情報は薄まらない",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_project_context",
      description:
        "プロジェクトの前提情報(全員共有、システムプロンプトに常時含まれる)を上書き更新する。既存内容を踏まえ、ユーザーの要望を反映した新しい全文を渡す",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "新しい前提情報の全文" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_view",
      description: "ボードの表示フィルタを切り替える(「鈴木さんの分だけ見せて」など)。assigneeにnullを渡すと全員表示に戻す",
      parameters: {
        type: "object",
        properties: {
          assignee: { type: ["string", "null"], description: "絞り込む担当者名。全員表示はnull" },
        },
        required: ["assignee"],
      },
    },
  },
];

async function execTool(name: string, args: any, uiActions: UiAction[], events: Set<string>): Promise<unknown> {
  switch (name) {
    case "create_tasks": {
      const created = (args.tasks as any[]).map((t) =>
        createTask(t.title, "todo", t.assignee ?? null, t.reason ?? null)
      );
      events.add("board");
      return { ok: true, created };
    }
    case "update_tasks": {
      const updated = (args.updates as any[]).map((u) =>
        updateTask(u.id, {
          ...(u.title !== undefined ? { title: u.title } : {}),
          ...(u.status !== undefined ? { status: u.status as TaskStatus } : {}),
          ...(u.assignee !== undefined ? { assignee: u.assignee } : {}),
          ...(u.reason !== undefined ? { reason: u.reason } : {}),
          ...(u.lane !== undefined ? { lane: u.lane } : {}),
        })
      );
      events.add("board");
      return { ok: true, updated };
    }
    case "delete_tasks": {
      const results = (args.ids as number[]).map((id) => ({ id, deleted: deleteTask(id) }));
      events.add("board");
      return { ok: true, results };
    }
    case "propose_assignments": {
      const created = (args.proposals as any[]).map((p) => createProposal(p.taskId, p.assignee, p.reason));
      events.add("proposals");
      return { ok: true, proposals: created };
    }
    case "compact_archive": {
      try {
        const result = await compactArchive();
        events.add("board");
        return { ok: true, ...result };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    }
    case "update_project_context": {
      setProjectContext(args.text ?? "");
      return { ok: true };
    }
    case "set_view": {
      uiActions.push({ type: "set_filter", assignee: args.assignee ?? null });
      return { ok: true };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

function buildSystemPrompt(): string {
  const tasks = listTasks();
  const loads = memberLoads();
  const history = assignmentHistory();
  const pending = listPendingProposals();
  const projectContext = getProjectContext();
  const summaryCards = listSummaryCards();
  return [
    "あなたはチームのタスク管理ボード「ChatBan」のアシスタント。日本語で簡潔に応答する。",
    "",
    projectContext ? `## プロジェクトの前提情報 (全員共有)\n${projectContext}\n` : "",
    "## ボードの状態 (status: todo=未着手, inprogress=作業中, review=レビュー中, done=完了)",
    "完了タスクは自動でアーカイブされ要約カードに畳まれる。以下のボードには未アーカイブ分のみ載っている。",
    JSON.stringify(tasks),
    "",
    summaryCards.length
      ? `## アーカイブ要約 (過去の完了の蒸留。過去の作業について聞かれたらここを参照)\n${JSON.stringify(
          summaryCards.map((c) => ({ id: c.id, title: c.title, elements: c.elements.map((e) => e.text) }))
        )}`
      : "",
    "",
    "## メンバーと現在の担当タスク数(未完了)",
    JSON.stringify(loads),
    "",
    "## 過去の割り振り履歴 (類似タスクの参考にする)",
    JSON.stringify(history),
    "",
    pending.length ? `## 承認待ちの割り振り提案\n${JSON.stringify(pending)}` : "",
    "## 行動ルール",
    "- タスクにすべき発言(「〜を追加して」「〜やらないと」「タスク: 〜」等)は確認を挟まず即 create_tasks で登録する。テンポ優先。",
    "- ただし「候補を挙げて」「相談したい」のような明示的な相談モードのときだけは、登録せずテキストで候補を提示する。",
    "- create_tasks / update_tasks の報告では、必ず割り当てられたタスクID を「#12として登録しました」の形式で明記する (ユーザーは以後この番号で参照する)。",
    "- 「Nは◯◯に」のような指名は update_tasks で即実行してよい (reason は「指名」)。",
    "- 「いい感じに振っといて」のような委任は propose_assignments を使う。勝手に assignee を確定しない。理由には負荷と履歴を必ず引用する。",
    "- 「終わりました」等の完了報告は該当タスクを status=done に更新。発言者名が分かればその人のタスクを優先して曖昧参照を解決する。",
    "- 「◯◯さんの分だけ見せて」は set_view を使う。",
    "- チーム共通の前提・決まりごと(締切、方針、用語など)を伝えられたら update_project_context で前提情報に反映する。",
    "- 「ログ整頓して」は compact_archive を使う。完了タスクのアーカイブは自動なので手動操作は不要。",
    "- 削除と却下は文脈で使い分ける: 誤登録・重複・ダミー(「消して」「間違えた」)は delete_tasks。やらない決定(「見送り」「却下」「やらないことにした」)は削除せず update_tasks で status=done にし、reason に却下の根拠を書く (決定として要約アーカイブに残る)。どちらか曖昧なら削除せず確認する。",
    "- 操作後は結果を一言で報告する。長い説明はしない。",
    "",
    "## 設計思想 (構造カスタマイズの要望が来たときの応対)",
    "ChatBanは「会話が構造の代わりをする」ツール。ステータス4列は固定で、カスタム列・優先度フィールド・タグの追加要望には応じない。",
    "代わりに以下へ誘導する (どれが適切かはニーズを聞いて判断):",
    "- 状態を細かく刻みたい (「検証待ち」等) → その情報はタスクのタイトルや理由欄に書く。または「検証」を独立タスクに分割する",
    "- 分類したい → lane (demo/later) か、タイトルの付け方で表現する",
    "- 優先したい → 並び順 (「これ上にして」) で表現する",
    "断るときは設計理由 (語彙が固定だから一言が正確に通じる) を一言添える。",
  ]
    .filter(Boolean)
    .join("\n");
}

const TOOL_LABELS: Record<string, string> = {
  create_tasks: "タスクを追加",
  update_tasks: "タスクを更新",
  delete_tasks: "タスクを削除",
  propose_assignments: "割り振りを検討",
  set_view: "ビューを切替",
  update_project_context: "前提情報を更新",
  compact_archive: "過去ログを整頓",
};

export async function runChatTurn(
  userMessage: string,
  history: { role: "user" | "assistant"; content: string }[],
  onEvent: (kind: "board" | "proposals") => void,
  onProgress?: (label: string) => void
): Promise<ChatResult> {
  const t0 = Date.now();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt() },
    ...history.slice(-20),
    { role: "user", content: userMessage },
  ];
  const trace: ToolTrace[] = [];
  const uiActions: UiAction[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, rounds: 0, elapsedMs: 0 };
  let reply = "";

  for (let round = 0; round < 8; round++) {
    const res = await chatCompletion("chat", MODELS.main, { messages, tools });
    usage.rounds++;
    usage.promptTokens += res.usage?.prompt_tokens ?? 0;
    usage.completionTokens += res.usage?.completion_tokens ?? 0;
    const msg = res.choices[0].message;
    messages.push(msg);
    if (msg.tool_calls?.length) {
      const events = new Set<string>();
      for (const tc of msg.tool_calls) {
        if (tc.type !== "function") continue;
        let args: any = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* 引数パース失敗時は空で実行し、エラーはツール結果に出る */
        }
        log("tool", `${tc.function.name} ${tc.function.arguments?.slice(0, 200)}`);
        onProgress?.(TOOL_LABELS[tc.function.name] ?? tc.function.name);
        const result = await execTool(tc.function.name, args, uiActions, events as Set<string>);
        trace.push({ tool: tc.function.name, input: args, result });
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      for (const e of events) onEvent(e as "board" | "proposals");
      continue;
    }
    reply = typeof msg.content === "string" ? msg.content : "";
    break;
  }
  usage.elapsedMs = Date.now() - t0;
  return { reply, trace, uiActions, usage };
}
