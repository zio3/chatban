import type OpenAI from "openai";
import { createTasksAsAgent, updateTasksAsAgent } from "./agentWrite.js";
import { compactArchive } from "./archive.js";
import { getBoardPromptSection } from "./promptState.js";
import {
  assignmentHistory,
  createProposal,
  createTask,
  restoreTask,
  trashTask,
  getTask,
  listPendingProposals,
  listSummaryCards,
  listTasks,
  memberLoads,
  queryLlmCalls,
  queryProjectData,
  reorderTasks,
  resolveProposal,
  searchTasks,
  setProjectContext,
  updateTask,
  updateTasks,
} from "./db.js";
import { chatCompletion, getModel } from "./llm.js";
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
  usage: {
    promptTokens: number;
    completionTokens: number;
    rounds: number;
    elapsedMs: number;
    /* LLM往復ごとのルーティング詳細 (#31): 実際に使われたモデル・トークン・キャッシュヒット */
    calls: { model: string; promptTokens: number; completionTokens: number; cachedTokens: number; elapsedMs: number }[];
  };
}

const STATUS_VALUES = ["todo", "inprogress", "review", "done"];

/** #106/#108: 記録へのSQL窓口の説明。チャットとMCPで同じものを使う。
 * 入口ごとに書き分けると必ずズレる (#92 #108 #114 で3回起きた) */
export const QUERY_LOG_DESCRIPTION = [
  "記録にSQLで問い合わせる(読み取り専用)。集計軸・期間・条件は自由に決めてよい。",
  "scope='cost': llm_calls — id, purpose(chat/suggest/archive-decompose/archive-title), model, routed_model, prompt_tokens, completion_tokens, cached_tokens, elapsed_ms, project_id, price_in_per_m, price_out_per_m, estimated_usd, created_at",
  "scope='audit': このプロジェクトの記録。chat_messages(id, role, content, trace, usage, task_id, created_at) / assignment_history(task_title, assignee, note, created_at) / proposals(task_id, assignee, reason, status, created_at) / summary_cards(id, title, elements, task_ids, settled, created_at)",
  "scope='audit' の tasks(id, title, status, assignee, assign_reason, summary, context, context_version, due, blocked_by, rejected, checked_at, done_at, trashed_at, sort, archived, summary_card_id, created_at, updated_at)",
  "checked_at = 人が実物で確かめた日時 (nullなら未検収)。status とは別物で、done は列が動いたこと・checked_at は検収が進んだこと。片方からもう片方を推測しない。この窓口は読み取り専用で、checked_at を書く手段はどこにも無い (印を付けられるのは人間だけ)",
  "会話で「#112」と呼ぶタスクは tasks.id = 112 のこと(主キー)。番号はプロジェクトごとに1から振られる。特定の1件を見るときは WHERE id=<番号> で引く",
  "日付の列を取り違えない。created_at=登録日 / updated_at=最終更新(その後の編集でも動く) / done_at=Doneへ確定した日 / checked_at=人が確かめた日。完了の集計には done_at を使う(created_at だと登録日を数えてしまう)。summary_cards.created_at も完了日ではない — 日次まとめで統合されると最初のカードの日付を引き継ぐ",
  "done_at のうち 2026-08-10 以前のものは、列を作る前に終わったぶんを updated_at から埋めた近似値(完了後に触っていなければ最終更新=完了日時)。日単位の集計には使えるが、分単位の議論には使わない",
  "例(いつ何件終わったか): SELECT date(done_at) d, COUNT(*) n FROM tasks WHERE done_at IS NOT NULL GROUP BY 1 ORDER BY 1 DESC",
  "SELECT * は使わない。必要な列だけ挙げる。context(経緯メモ)は1件1,000字を超えるので、一覧では length(context) か substr(context,1,120) にし、全文が要るタスクだけ id で絞って引き直す",
  "例(ボードの一覧。生きているタスクはこの条件): SELECT id, status, title, assignee, due, checked_at, length(context) ctx FROM tasks WHERE archived=0 AND trashed_at IS NULL ORDER BY COALESCE(sort,id), id",
  "例(1件の詳細。経緯メモの全文と版): SELECT title, status, summary, context, context_version, blocked_by FROM tasks WHERE id=112",
  "例(直近の動き。「なにやってたっけ」): SELECT id, status, title, summary, updated_at FROM tasks WHERE archived=0 AND trashed_at IS NULL ORDER BY updated_at DESC LIMIT 15",
  "例(担当ごとの負荷): SELECT m.name, COUNT(t.id) open FROM members m LEFT JOIN tasks t ON t.assignee=m.name AND t.status!='done' AND t.archived=0 AND t.trashed_at IS NULL GROUP BY m.name",
  "例(ゴミ箱の中身): SELECT id, title, trashed_at FROM tasks WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC",
  "例(承認待ちの割り振り案): SELECT task_id, assignee, reason FROM proposals WHERE status='pending'",
  "例(Doneの要約カード): SELECT id, title, task_ids, settled FROM summary_cards ORDER BY id DESC",
  "例(検収待ちで、まだ人が確かめていないもの): SELECT id, title, summary FROM tasks WHERE status='review' AND checked_at IS NULL ORDER BY sort",
  "例(1件の経緯メモ全文): SELECT context, context_version FROM tasks WHERE id=112",
  "例: SELECT routed_model, COUNT(*) n, ROUND(SUM(estimated_usd),4) usd FROM llm_calls GROUP BY 1 ORDER BY usd DESC LIMIT 10",
  "例: SELECT ROUND(SUM(estimated_usd),4) usd FROM llm_calls WHERE date(created_at)=date('now','localtime')",
  "例: SELECT created_at, role, substr(content,1,120) FROM chat_messages WHERE date(created_at)='2026-08-09' ORDER BY id LIMIT 30",
  "例: SELECT substr(created_at,1,13) h, COUNT(*) n FROM chat_messages GROUP BY 1 ORDER BY 1",
  "会話ログは常時プロンプトに載せていないので、過去の話を聞かれたらここを掘る。",
  "estimated_usd は呼び出し時点の単価で打刻した概算。全体の実額は請求APIの値(画面上部)が正",
].join("\n");

/** #115/#116: 列の意味と完了の条件はプロジェクトごとに違う。
 * 実例: あるプロジェクトは review=検収待ち、別のプロジェクトは review=相手待ち(返答・承認待ち)。
 * エージェントから見ると status の enum はどのプロジェクトでも同じに見えるので、契約側で断る */
export const STATUS_DESCRIPTION =
  "列の意味と「いつそこへ置くか」はプロジェクトごとに違う(例: reviewが検収待ちのプロジェクトと、相手待ちのプロジェクトがある)。状態を変える前にプロジェクトの前提情報を読み、そこの定義に従うこと。done はどのプロジェクトでも人間の検収でしか付かない";

/** #115: 前提情報は全文上書き。読まずに書くと全員の運用ルールが消える */
export const PROJECT_CONTEXT_WRITE_DESCRIPTION =
  "プロジェクトの前提情報(全員共有、チャットのシステムプロンプトに常時含まれる)を上書き更新する。全文を渡すので、必ず先に読んで自分の変更をマージした全文にすること。完了の定義・却下や保留の扱い・稼働日など、そのプロジェクト固有の運用ルールが入っている";

/** #91/#108: 並べ替えの契約。sortは列内でしか効かない(列をまたぐ順序はstatusそのもの)ので、
 * 全列を1本のリストで渡されたときに何が起きるかを書いておかないと、LLMの期待とズレる。
 * 実際に「1位 #7、2位 #4…」と全体順位のつもりで渡された事例がある (zio) */
export const REORDER_DESCRIPTION = [
  "列の並び順を付け替える。並べたい順にタスクIDを渡す(「番号の降順」だけでなく「重要そうな順」など意味のある並びも可)。",
  "表示設定ではなく並び順そのものを書き換える操作で、あとから手で並べ直せる。「後回し」は列の下へ、「今やりたい」は上へ。",
  "status を省くと全列が対象になるが、渡した並びは列ごとの相対順に分解される(列をまたぐ順序は status そのものなので、1本の通し順位にはならない)。全体の順位として説明しないこと。",
  "対象は生きているタスクだけ(アーカイブ済み・ゴミ箱は対象外)。指定しなかったタスクは元の順のまま末尾に残るので消えない。対象外や存在しないIDは無視して ignored で返す(全体は失敗しない)。",
].join("\n");

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_tasks",
      description: "タスクをボードに追加する(複数可)",
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
                assign_reason: { type: "string", description: "その担当にした理由を一言で (「指名」「API検証の実績」など)。進捗や作業結果は書かない" },
                context: { type: "string", description: "登録に至った経緯・会話で出た論点・決まったこと。相談や議論の流れから登録するときは必ず書く (タイトルだけでは背景が失われる)" },
                due: { type: "string", description: "期限 YYYY-MM-DD。相対表現は今日の日付から解決" },
                blocked_by: { type: "array", items: { type: "integer" }, description: "依存先タスクID(これらが終わるまで着手不可)" },
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
      description: "既存タスクの状態・担当・タイトル等を更新する(複数可)",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer", description: "タスクID。会話で「#112」と呼ばれるものと同じで、tasks テーブルの主キー(id)。プロジェクトごとに1から振られるので、別プロジェクトの#112とは別物" },
                title: { type: "string" },
                status: { type: "string", enum: STATUS_VALUES, description: STATUS_DESCRIPTION },
                assignee: { type: "string" },
                assign_reason: { type: "string", description: "担当変更・却下の判断理由を一言で。期限だけの変更では渡さない(既存の理由を上書きしてしまう)。進捗や作業結果は書かない — それは summary" },
                summary: { type: "string", description: "現況の一言。カードに表示される(「実装完了 (commit xxx)」「原因調査中」など)。検収の要点はここ、詳細な根拠は経緯メモ(context)へ" },
                due: { type: ["string", "null"], description: "期限 YYYY-MM-DD。解除はnull" },
                blocked_by: { type: ["array", "null"], items: { type: "integer" }, description: "依存先タスクID(全置換)。解除はnull" },
                rejected: { type: "boolean", description: "却下(やらない決定)フラグ。却下時はtrue+reasonに根拠。取り消しはfalse" },
                context: { type: "string", description: "経緯メモの全文。上書きなので既存を読んでマージすること。渡すときは context_version も必須" },
                context_version: { type: "integer", description: "context を渡すときのみ必須。直前に読んだ contextVersion をそのまま添える" },
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
      description: "タスクをゴミ箱に入れる(複数可)。実データは残り restore_tasks や画面から復元できる",
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
      name: "restore_tasks",
      description: "ゴミ箱に入れたタスクを元に戻す(複数可)",
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
      description: "割り振り案を提案する(人間の承認で確定)。理由には負荷・履歴・期限の根拠を書く",
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
      name: "resolve_proposals",
      description:
        "承認待ちの割り振り提案を承認/却下する(「全部承認」「#24は却下」等)。taskIdsを省略すると承認待ち全件が対象",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["approve", "reject"] },
          taskIds: { type: "array", items: { type: "integer" }, description: "対象タスクID。省略で全承認待ち" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task_context",
      description: "タスクの経緯メモを上書き更新する(既存を query_log で読みマージした全文を渡す)",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "タスクID。会話で「#112」と呼ばれるものと同じで、tasks テーブルの主キー(id)。プロジェクトごとに1から振られるので、別プロジェクトの#112とは別物" },
          text: { type: "string", description: "新しいcontext全文" },
          context_version: {
            type: "integer",
            description: "query_log で読んだ context_version をそのまま渡す。読んでから書くまでの間に他から追記されていないかの確認に使う",
          },
        },
        required: ["id", "text", "context_version"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reorder_tasks",
      description: REORDER_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: STATUS_VALUES, description: "対象の列。省略で全列" },
          ids: { type: "array", items: { type: "integer" }, description: "並べたい順のタスクID" },
        },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_tasks",
      description:
        "タスクの本文(タイトル・現況・経緯メモ・担当理由)と会話ログを横断検索する。アーカイブ済みも対象。会話は新しい順に最大6件返る(「あんな話してたっけ?」用)。表記ゆれや言い換えは自分で展開して複数語を渡すこと(OR検索・当たった語が返る)。例: 「なんでDB分けたんだっけ」→ terms:[\"DB\",\"データベース\",\"ファイル分離\",\"分割\",\"プロジェクト\"]",
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
      name: "query_log",
      description: QUERY_LOG_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["cost", "audit"], description: "cost=LLM呼び出し記録 / audit=会話・割り振り・タスク" },
          sql: { type: "string", description: "SELECT または WITH で始まる1文" },
        },
        required: ["scope", "sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compact_archive",
      description: "要約カードを1枚の過去ログに統合する",
      parameters: { type: "object", properties: {} },
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
          version: { type: "integer", description: "直前に読んだ前提情報の version。合わないと更新されず現在値が返る" },
        },
        required: ["text", "version"],
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

/** #109/#110: メンバーが1人も居ないプロジェクトは「個人用」。担当者という概念自体を消す。
 * MCP側(mcp.ts)と同じ扱いにする — 片方だけ直すと「MCPでは消えたのにチャットでは担当者を聞かれる」
 * という、入口ごとの契約のズレ(#92 #108 #114と同型)がまた生まれる。
 *
 * 共有プロジェクトでは元の配列をそのまま返す。ツール定義はプロンプトの一部なので、
 * 組み立て直してバイト列が揺れるとキャッシュが外れる */
const ASSIGNEE_TOOLS = ["propose_assignments", "resolve_proposals", "set_view"];
let personalTools: OpenAI.Chat.Completions.ChatCompletionTool[] | null = null;

function toolsFor(personal: boolean): OpenAI.Chat.Completions.ChatCompletionTool[] {
  if (!personal) return tools;
  if (personalTools) return personalTools;
  personalTools = JSON.parse(JSON.stringify(tools))
    .filter((t: any) => !ASSIGNEE_TOOLS.includes(t.function.name))
    .map((t: any) => {
      const items = t.function.parameters?.properties?.tasks?.items ?? t.function.parameters?.properties?.updates?.items;
      if (items?.properties) {
        delete items.properties.assignee;
        delete items.properties.assign_reason;
      }
      return t;
    });
  return personalTools!;
}

/** 発言者ラベルが本文として書き写されたときの保険。プロンプトは漏れるがツール契約は漏れない (#87と同じ考え方)。
 * 先頭だけでなく行頭のどこに出ても落とす (経緯メモに段落として混ざる例があった) */
function stripSpeakerLabel<T extends string | undefined | null>(v: T): T {
  if (typeof v !== "string") return v;
  return v.replace(/^\s*\[発言者:[^\]]*\]\s*/gm, "") as T;
}

async function execTool(name: string, args: any, uiActions: UiAction[], events: Set<string>): Promise<unknown> {
  switch (name) {
    case "create_tasks": {
      // #114: 書き込みは agentWrite に集約 (チャットとMCPで同じガードを通す)
      const r = createTasksAsAgent(args.tasks ?? []);
      events.add("board");
      return { ok: true, ...r };
    }
    case "update_tasks": {
      const { updated, note, conflicts } = updateTasksAsAgent(args.updates ?? []);
      events.add("board");
      // #112: 版が合わなかった経緯メモは適用していない。現在の全文を返すのでマージして再実行する
      return { ok: true, updated, ...(conflicts ? { conflicts } : {}), ...(note ? { note } : {}) };
    }
    case "delete_tasks": {
      // #102: 実データは消さずゴミ箱へ。誤解釈で消えても取り返しがつくようにする
      const results = (args.ids as number[]).map((id) => ({ id, trashed: trashTask(id) }));
      // 復元できることは毎回文章で説明しない (くどい)。#xx リンクから詳細パネルを開けば「戻す」がある
      events.add("board");
      return { ok: true, results };
    }
    case "propose_assignments": {
      // #101: 一人用プロジェクトでは割り振りに意味がない。プロンプトで抑えても漏れるのでここで止める
      if (memberLoads().length === 0) {
        return {
          ok: false,
          error: "このプロジェクトはメンバー未登録(一人用)のため割り振りはできません。人を追加するには⚙設定タブのプロジェクト設定から、とユーザーに案内してください",
        };
      }
      const created = (args.proposals as any[]).map((p) => createProposal(p.taskId, p.assignee, p.reason));
      events.add("proposals");
      return { ok: true, proposals: created };
    }
    case "resolve_proposals": {
      const pending = listPendingProposals();
      const targets = args.taskIds?.length
        ? pending.filter((p) => (args.taskIds as number[]).includes(p.taskId))
        : pending;
      if (targets.length === 0) return { ok: false, error: "対象の承認待ち提案がありません" };
      const resolved = targets.map((p) => resolveProposal(p.id, args.action === "approve" ? "approved" : "rejected"));
      events.add("proposals");
      if (args.action === "approve") events.add("board");
      return { ok: true, action: args.action, resolved: resolved.map((p) => ({ taskId: p?.taskId, assignee: p?.assignee })) };
    }
    case "update_task_context": {
      // #112/#114: 経緯メモの上書きも agentWrite を通す (版の確認を1箇所に集約)
      const r = updateTasksAsAgent([
        { id: args.id, context: stripSpeakerLabel(args.text) ?? "", context_version: args.context_version },
      ]);
      if (r.conflicts?.length) return r.conflicts[0];
      const updated = r.updated[0] as ReturnType<typeof getTask>;
      if (!updated) return { error: `task #${args.id} not found` };
      events.add("board");
      return { ok: true, id: updated.id };
    }
    case "reorder_tasks": {
      const r = reorderTasks(args.ids ?? [], args.status);
      events.add("board");
      // 指定漏れがあったことはLLMに伝える (黙って末尾に置くと「並べたつもり」とズレる)
      return {
        ok: true,
        ...r,
        ...(r.appended > 0 ? { note: `${r.appended}件は順番の指定に含まれていなかったので末尾に置きました` } : {}),
      };
    }
    case "search_tasks": {
      const r = searchTasks(args.terms ?? []);
      // スニペットは「当たった箇所の周辺」でしかないので、判断の核心が範囲外にあることが多い。
      // 検索は「どのタスクか」を絞るまでの道具と位置づけ、中身は query_log で読ませる
      return {
        ...r,
        ...(r.hits.length > 0
          ? { note: "snippetは当たった箇所の周辺のみ。理由や判断を答えるときは query_log で経緯メモの全文を読むこと (SELECT context FROM tasks WHERE id=...)" }
          : {}),
      };
    }
    case "query_log": {
      try {
        return args.scope === "audit" ? queryProjectData(args.sql ?? "") : queryLlmCalls(args.sql ?? "");
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
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
      const r = setProjectContext(args.text ?? "", args.version);
      if (!r.ok)
        return {
          ok: false,
          conflict: r.current,
          note: "前提情報が他から更新されています。返した text に自分の変更をマージし、この version を添えて再実行してください",
        };
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

function buildSystemPrompt(taskFocus?: ReturnType<typeof getTask>, speaker?: string, view?: string): string {
  const loads = memberLoads();
  const history = assignmentHistory();
  const pending = listPendingProposals();
  // キャッシュ友好の並び: 静的な内容(人格/ルール/思想)を先頭に固定し、動的な内容(索引/履歴/カード)を末尾へ。
  // プロンプトキャッシュはプレフィックス一致なので、先頭が安定しているほどヒット部分が伸びる。
  return [
    "あなたはチームのタスク管理ボード「ChatBan」のアシスタント。日本語で簡潔に応答する。",
    "",
    "## 行動ルール",
    "- まず依頼か相談かを判別する。明確なアクション依頼(「〜を追加して」「〜やらないと」「タスク: 〜」「〜に対応したい」)だけを、確認を挟まず即 create_tasks で登録する。テンポ優先はこの依頼に限る。",
    "- 質問・意見募集・感想(「どう思う?」「いいのかな?」「なんで〜?」、画像やPDFを見せての問いかけ等)は相談。タスク化せず、内容に踏み込んで会話で応える。タスクにする価値がありそうなら会話の末尾に「タスクに積みますか?」と一言添えるだけにし、登録は次のユーザー発言を待つ。",
    "- 依頼か相談か迷ったら相談として扱う (誤登録の削除コストより会話で受ける方が安い)。",
    "- create_tasks / update_tasks の報告では、必ず割り当てられたタスクID を「#12として登録しました」の形式で明記する (ユーザーは以後この番号で参照する)。",
    "- 相談・議論の流れからタスクを登録するときは、create_tasks の context に登録に至った経緯を要約して入れる。経緯のない単発の明確な依頼では省略可。",
    "- 「Nは◯◯に」のような指名は update_tasks で即実行してよい (reason は「指名」)。",
    "- 「いい感じに振っといて」のような委任は propose_assignments を使う。勝手に assignee を確定しない。理由には負荷と履歴を必ず引用する。",
    "- 提案への「承認」「全部承認で」「#Nは却下」は resolve_proposals を使う。update_tasks で直接 assignee を書いて代用しない (提案が残留してUIに表示され続ける)。",
    "- 「終わりました」等の完了報告は status=review に置き、「Reviewに置いたので確認OKなら承認を」と一言返す。勝手に done にしない (doneは検収済みの意味で、即アーカイブされる)。発言者名が分かればその人のタスクを優先して曖昧参照を解決する。",
    "- あなたは done に変更できない (ツールが受け付けず review に置き換わる)。完了・却下・承認はすべて status=review に置き、done への確定はボードのReview列の検収チェック(人間の操作)だけが行う。「doneにして」「まとめて承認」と言われたら review に置いた上で「確定はReview列の検収チェックからお願いします」と案内する。",
    "- 「◯◯さんの分だけ見せて」は set_view を使う。",
    "- チーム共通の前提・決まりごと(締切、方針、用語など)を伝えられたら update_project_context で前提情報に反映する。",
    "- 特定タスクの経緯・決定事項・補足(「#22は◯◯方式でいくことにした」等)は update_task_context でそのタスクの経緯メモに記録する。",
    "- assign_reason は「なぜこの担当か」、summary は「いまどうなっているか」。別の情報なので混ぜない。進捗・完了報告は summary に一言で書き、詳細な根拠は経緯メモ(context)に書く。",
    "- 「ログ整頓して」は compact_archive を使う。完了タスクのアーカイブは自動なので手動操作は不要。",
    "- 過去の判断や経緯・過去の会話を聞かれたら(「なんで◯◯にしたんだっけ」「あんな話してたっけ」)、索引のタイトルだけで答えず search_tasks で本文と会話ログを引く。言い換え・英日表記を自分で並べて渡し、空振りしたら語を変えて引き直す。検索結果のsnippetは断片なので、理由を答える前に query_log で経緯メモの全文を読む。時期や条件で絞りたいとき(「8/9の午前に何を話していたか」等)は query_log(scope=audit) を使う。",
    "- 削除と却下は文脈で使い分ける: 誤登録・重複・ダミー(「消して」「間違えた」)は delete_tasks (ゴミ箱行きで復元可。返答で復元方法を説明する必要はない)。やらない決定(「見送り」「却下」「やらないことにした」)は削除せず update_tasks で status=review + rejected=true にし、reason に却下の根拠を書いて「却下としてReviewに置きました。検収で確定します」と返す (検収後、決定として要約アーカイブに残る)。",
    "- 「消して」がタスクそのものを指すのか、タイトルや文言の一部の修正を指すのか曖昧なときは、操作せず確認する (実例:「#95だけ発言者の話が入っていて不自然なので消せますか?」はタイトルの修正依頼だったが、タスクごと削除してしまった)。",
    "- ボードから退場するもの(完了・却下)は必ずReviewを通り、人間の検収チェックで確定する。チャットからdoneへ直行する経路は存在しない。",
    "- 着手したが前提が足りず進められないときは、勝手に却下にも完了にもしない。summary に「前提不足で保留 (◯◯が必要)」と現況を書き、必要な情報を人に尋ねる。status をどこに置くかはプロジェクトの前提情報の定義に従う (列の意味はプロジェクトごとに違う)。",
    "- 検収の印(checked_at)は人が実物で確かめた記録で、AIには書く手段が無い。「確認しておきました」と自分で付けることはできないし、付いたことにして話さない。誰が何を確かめたかを聞かれたら query_log(scope=audit) の tasks.checked_at を読む。",
    "- 「後回し」「今はやらない」は却下ではない。status は変えず (done にするとアーカイブに吸い込まれる)、reorder_tasks でその列の下へ落とす。「今やりたい」は逆に上へ。",
    "- 「金曜まで」「明日まで」等の期限表現は今日の日付から YYYY-MM-DD に解決して due に入れる。期限が近い/過ぎたタスクはレポートや割り振り提案で優先的に言及する。",
    "- 画像やPDFが添付されたら内容を読み取って会話・操作に活かす。重要な情報(バグの症状、決定事項、資料の要点)はタスクの context や前提情報に文字で蒸留して記録する。ファイル原本はどこにも保存されないため、後から参照が必要な内容は必ず文字にして残す。",
    "- 「#AはB待ち」「Bが終わってから」等の依存表現は blocked_by に依存先IDを登録する(複数可)。索引の dep がそれ。依存先が未完了のタスクは割り振り提案の対象にせず、レポートでは「#N待ち」と添える。",
    "- 操作後は結果を一言で報告する。長い説明はしない。",
    "",
    "## 設計思想 (構造カスタマイズの要望が来たときの応対)",
    "ChatBanは「会話が構造の代わりをする」ツール。ステータス4列は固定で、カスタム列・優先度フィールド・タグの追加要望には応じない。",
    "代わりに以下へ誘導する (どれが適切かはニーズを聞いて判断):",
    "- 状態を細かく刻みたい (「検証待ち」等) → その情報はタスクのタイトルや理由欄に書く。または「検証」を独立タスクに分割する",
    "- 分類したい → タイトルの付け方か、reorder_tasks の並び順で表現する",
    "- 優先したい → 並び順 (「これ上にして」) で表現する",
    "断るときは設計理由 (語彙が固定だから一言が正確に通じる) を一言添える。",
    "",
    // ---- ここから動的セクション ----
    // #50: ボード状態は「基準スナップショット+変更イベント追記」でプレフィックスを安定させる (promptState.ts)。
    // 温かい間はバイト不変のまま伸びるのでキャッシュが基準部分まで効く。TTL超過時のみ再ベースライン。
    getBoardPromptSection(),
    "",
    // #101: メンバーが1人も登録されていないプロジェクトは「一人用」。
    // 割り振りは自分1人しかいない場に対する空回りなので、材料ごと渡さず提案もさせない
    // (フラグを増やさず、データの有無で振る舞いを変える)
    loads.length === 0
      ? [
          "## 体制",
          "このプロジェクトはメンバー未登録の一人用。担当者が空なのが正常な状態であり、欠落ではない。",
          "- 担当の空きを問題として指摘しない。「未割り当てが◯件あります」のような報告もしない",
          "- 割り振りを頼まれたら実行せず、一人用なので担当は使っていないと説明し、人を増やすなら⚙設定タブのプロジェクト設定から追加できると案内する",
        ].join("\n")
      : [
          "## メンバーと現在の担当タスク数(未完了)",
          JSON.stringify(loads),
          "",
          "## 過去の割り振り履歴 (類似タスクの参考にする)",
          JSON.stringify(history.slice(0, 10).map((h) => ({ t: h.taskTitle.slice(0, 30), a: h.assignee }))),
        ].join("\n"),
    "",
    pending.length ? `## 承認待ちの割り振り提案\n${JSON.stringify(pending)}` : "",
    // #93: いま見ている画面。発言者と同じくメタ情報 (本文には混ぜない)。
    // 「これ何?」「これ高くない?」のような指示語をタブの文脈で解決するために渡す
    VIEW_HINTS[view ?? ""] ?? "",
    // 発言者はメタ情報。本文に混ぜるとタスクへ書き写されるので、ここで「書き写すな」と添えて渡す
    speaker
      ? `\n## いまの発言者: ${speaker}\n「終わりました」等の曖昧な言い回しの主語はこの人。これはメタ情報であって発言内容ではないので、タスクのタイトル・経緯メモ・理由には書き写さないこと。`
      : "",
    taskFocus
      ? [
          "",
          `## いま注目しているタスク (このチャットは #${taskFocus.id} 専用)`,
          JSON.stringify(taskFocus),
          `- 「これ」「このタスク」等の指示語は #${taskFocus.id} を指す。`,
          `- この会話で決まったこと・分かったことは update_task_context で #${taskFocus.id} の経緯メモに反映する (既存contextを読んでマージ)。`,
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
  metrics: [
    "",
    "## いま見ている画面: 📊コスト",
    "AI利用のコストを見ている。「これ高い?」「何にかかってる?」等は query_log(scope=cost) でSQLを書いて実データを集計してから答える。回数が多いモデルと金額が大きいモデルは一致しないので、金額で見ること。全体の実額は請求APIの値(画面上部)が正で、estimated_usd は概算。",
  ].join("\n"),
  audit: [
    "",
    "## いま見ている画面: 📜監査",
    "会話・LLM呼び出し・割り振り履歴のログを見ている。「直近何やってた?」は query_log で updated_at の新しい順に引き、「あの日どんな話をしていたか」「いつ何を決めたか」は query_log(scope=audit) で会話ログを掘る。",
  ].join("\n"),
  trash: [
    "",
    "## いま見ている画面: 🗑ゴミ箱",
    "削除したタスクを見ている。「#xxを戻して」は restore_tasks で復元する。",
  ].join("\n"),
  settings: [
    "",
    "## いま見ている画面: ⚙設定",
    "モデル設定を見ている。設定を変えるツールは持っていないので、頼まれても実行せず、意味を説明したうえで「この画面から変更してください」と案内する (例: 対話モデルは応答速度とプロンプトキャッシュが効くので日付つきIDで固定するのが安全)。",
  ].join("\n"),
};

const TOOL_LABELS: Record<string, string> = {
  create_tasks: "タスクを追加",
  update_tasks: "タスクを更新",
  delete_tasks: "ゴミ箱へ移動",
  restore_tasks: "ゴミ箱から復元",
  propose_assignments: "割り振りを検討",
  set_view: "ビューを切替",
  update_project_context: "前提情報を更新",
  compact_archive: "過去ログを整頓",
  reorder_tasks: "並び順を変更",
  search_tasks: "経緯を検索",
  query_log: "記録を集計",
  update_task_context: "経緯メモを更新",
  resolve_proposals: "提案を承認/却下",
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
let suggestCache: { key: string; value: { label: string; message: string }[]; at: number } | null = null;
const SUGGEST_TTL_MS = 5 * 60 * 1000;
let suggestInflight: Promise<{ label: string; message: string }[]> | null = null;

export async function generateSuggestions(): Promise<{ label: string; message: string }[]> {
  // 新規プロジェクト(ボードが空)では読むべき文脈が無い。LLMを呼ばずに空で返す
  // — UI側は「方針を伝える」導線だけを出す (#86)
  if (listTasks().length === 0 && listSummaryCards().length === 0) return [];
  const systemPrompt = buildSystemPrompt();
  if (suggestCache && suggestCache.key === systemPrompt && Date.now() - suggestCache.at < SUGGEST_TTL_MS) {
    return suggestCache.value;
  }
  // 同時到着 (StrictModeの二重実行はほぼ同時に来る) は1本にまとめる
  if (suggestInflight) return suggestInflight;
  suggestInflight = generateSuggestionsUncached(systemPrompt)
    .then((value) => {
      suggestCache = { key: systemPrompt, value, at: Date.now() };
      return value;
    })
    .finally(() => {
      suggestInflight = null;
    });
  return suggestInflight;
}

async function generateSuggestionsUncached(systemPrompt: string): Promise<{ label: string; message: string }[]> {
  const res = await chatCompletion("suggest", getModel("main"), {
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          'ボードの現状を読んで、いまユーザーにとって価値のある操作を最大3つ提案して。ツールは呼ばない。出力はJSON配列のみ: [{"label":"絵文字+15字以内の短文","message":"チャットにそのまま投げる依頼文"}]。期限接近・依存解除・検収たまり・未割り当てなど文脈が根拠のものを優先。',
      },
    ],
    tools: toolsFor(memberLoads().length === 0),
  });
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
  onEvent: (kind: "board" | "proposals") => void,
  onProgress?: (label: string) => void,
  taskFocusId?: number,
  speaker?: string,
  attachments?: ChatAttachment[],
  view?: string
): Promise<ChatResult> {
  const t0 = Date.now();
  const taskFocus = taskFocusId != null ? getTask(taskFocusId) : undefined;
  // #68: 添付はそのままコンテンツパートでLLMへ (画像=vision / PDF=file直投げ)。原本は保存しない
  const fileParts = attachments && attachments.length > 0 ? buildAttachmentParts(attachments) : [];
  // #14: 発言者の記名。「終わりました」等の曖昧参照を解決するためのメタ情報であって発言内容ではない。
  // 以前は本文の先頭に [発言者: xxx] を足していたが、LLMがそれをタスクのタイトルや経緯メモへ
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
    { role: "system", content: buildSystemPrompt(taskFocus, speaker, view) },
    ...history.slice(-20),
    { role: "user", content: userContent },
  ];
  const isPersonal = memberLoads().length === 0; // #109/#110
  const trace: ToolTrace[] = [];
  const uiActions: UiAction[] = [];
  const usage: ChatResult["usage"] = { promptTokens: 0, completionTokens: 0, rounds: 0, elapsedMs: 0, calls: [] };
  let reply = "";

  for (let round = 0; round < 8; round++) {
    const c0 = Date.now();
    const res = await chatCompletion("chat", getModel("main"), { messages, tools: toolsFor(isPersonal) });
    usage.rounds++;
    usage.promptTokens += res.usage?.prompt_tokens ?? 0;
    usage.completionTokens += res.usage?.completion_tokens ?? 0;
    usage.calls.push({
      model: res.model ?? getModel("main"),
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      cachedTokens: (res.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0,
      elapsedMs: Date.now() - c0,
    });
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
