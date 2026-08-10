import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTasksAsAgent, updateTasksAsAgent } from "./agentWrite.js";
import { QUERY_LOG_DESCRIPTION } from "./chat.js";
import { z } from "zod";
import {
  queryLlmCalls,
  queryProjectData,
  reorderTasks,
  createProposal,
  createTask,
  restoreTask,
  trashTask,
  getProjectContext,
  getTask,
  listMembers,
  listPendingProposals,
  listSummaryCards,
  listTasks,
  listTrashedTasks,
  memberLoads,
  metrics,
  searchTasks,
  setProjectContext,
  updateTasks,
} from "./db.js";
import { archiveState } from "./hooks.js";
import { currentProjectId, getProject } from "./store.js";
import type { TaskStatus } from "./types.js";

const STATUS = z.enum(["todo", "inprogress", "review", "done"]);

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** #108: 更新結果は要点だけ返す。以前は context を含む全フィールドが返っており、
 * 経緯メモを更新するたびに自分が書いた1,800字がそっくり戻ってきていた (トークンの無駄) */
function brief(t: ReturnType<typeof getTask>, personal = false) {
  if (!t) return null;
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    ...(personal ? {} : { assignee: t.assignee }),
    ...(t.summary ? { summary: t.summary } : {}),
    ...(t.due ? { due: t.due } : {}),
    ...(t.blockedBy?.length ? { blockedBy: t.blockedBy } : {}),
    ...(t.rejected ? { rejected: true } : {}),
    ...(t.context ? { contextChars: t.context.length, contextVersion: t.contextVersion } : {}),
    updatedAt: t.updatedAt,
  };
}

/** この接続が対象としているプロジェクト (URLで固定されている #96) */
function currentProject() {
  const id = currentProjectId();
  return { id, name: getProject(id)?.name ?? "(不明)" };
}

// MCPクライアント(Claude Code等)向けのサーバー。変更系は onEvent でUIへブロードキャストする
export function buildMcpServer(onEvent: (kind: "board" | "proposals") => void): McpServer {
  const server = new McpServer({ name: "chatban", version: "0.1.0" });

  // #109/#110: メンバーが1人も居ないプロジェクトは「個人用」。担当者という概念自体を消す。
  // ツールを隠すだけでは足りず、create_tasks/update_tasks のスキーマから assignee を外さないと
  // 「無い」にならない (エージェントから見えるのはスキーマなので、隠しても項目が残っていれば使う)。
  // 接続ごとにサーバーを組み立てているので、プロジェクトを見て定義を変えられる
  const isPersonal = listMembers().length === 0;

  server.registerTool(
    "list_tasks",
    { description: "かんばんボードの全タスクとメンバー(負荷つき)を取得する" },
    async () =>
      text({
        // #96: この接続が固定されているプロジェクト。エージェントが自分の作業対象を確認できるように
        // 応答に含める (接続URLで決まるので途中で変わらない)
        project: currentProject(),
        // 個人用プロジェクトでは担当者という概念自体が無い (#109/#110)。
        // ツールとスキーマから消しても、一覧に assignee: null が並んでいれば
        // 「使える項目がある」と読まれるので、応答からも落とす
        tasks: isPersonal
          ? listTasks().map(({ assignee: _a, assignReason: _r, ...t }) => t)
          : listTasks(),
        ...(isPersonal ? {} : { members: memberLoads(), pendingProposals: listPendingProposals() }),
        // #108: 要約カードの状態が取れず、毎回RESTを叩いていた。要素は件数だけ返す(全文は重い)
        summaryCards: listSummaryCards().map((c) => ({
          id: c.id,
          title: c.title,
          taskIds: c.taskIds,
          settled: c.settled,
          elements: c.elements.length,
        })),
        trashedCount: listTrashedTasks().length,
        // #108: 要約の再生成は15〜80秒かかる。生成中に「完了した」と誤認しないように知らせる
        ...(archiveState.running.get(currentProjectId())
          ? { archiveRunning: "要約カードを再生成中。結果を見るなら少し待って list_tasks を呼び直すこと" }
          : {}),
      })
  );

  server.registerTool(
    "create_tasks",
    {
      description: "タスクをボードに追加する(複数可)。UIにはリアルタイム反映される",
      inputSchema: {
        tasks: z.array(
          z.object({
            title: z.string(),
            status: STATUS.optional().describe("省略時はtodo"),
            ...(isPersonal
              ? {}
              : {
                  assignee: z.string().optional().describe("担当者名。未定なら省略"),
                  assign_reason: z.string().optional().describe("なぜこの担当かを一言で。進捗は書かない"),
                }),
            context: z.string().optional().describe("登録に至った経緯・論点・決定事項 (経緯メモの初期値)"),
            summary: z.string().optional().describe("現況の一言。カードに表示される"),
            due: z.string().optional().describe("期限 YYYY-MM-DD"),
            blocked_by: z.array(z.number().int()).optional().describe("依存先タスクID(これらが終わるまで着手不可)"),
          })
        ),
      },
    },
    async ({ tasks }) => {
      // #114: 書き込みは agentWrite に集約。以前はMCP側にガードが無く、
      // done指定がそのまま通って「AIが自主的にDoneへ移動」する事故が起きた
      const r = createTasksAsAgent(tasks as any);
      onEvent("board");
      return text({ ok: true, created: (r.created as any[]).map((t: any) => brief(t, isPersonal)), ...(r.note ? { note: r.note } : {}) });
    }
  );

  server.registerTool(
    "update_tasks",
    {
      description: "既存タスクの状態・担当・タイトル・理由を更新する(複数可)",
      inputSchema: {
        updates: z.array(
          z.object({
            id: z.number().int(),
            title: z.string().optional(),
            status: STATUS.optional(),
            ...(isPersonal
              ? {}
              : {
                  assignee: z.string().nullable().optional(),
                  assign_reason: z.string().optional().describe("なぜこの担当かを一言で。進捗は書かない"),
                }),
            summary: z.string().optional().describe("現況の一言。カードに表示される。詳細な根拠は context へ"),
            context: z
              .string()
              .optional()
              .describe("経緯メモの全文上書き。既存を読んでマージすること。渡すときは context_version も必須"),
            context_version: z
              .number()
              .int()
              .optional()
              .describe("context を渡すときのみ必須。直前に list_tasks で読んだ contextVersion をそのまま添える"),
            due: z.string().nullable().optional().describe("期限 YYYY-MM-DD。解除はnull"),
            blocked_by: z.array(z.number().int()).nullable().optional().describe("依存先タスクID(全置換)。解除はnull"),
            rejected: z.boolean().optional().describe("却下(やらない決定)フラグ。reasonに根拠を書く"),
          })
        ),
      },
    },
    async ({ updates }) => {
      const { updated, note, conflicts } = updateTasksAsAgent(updates as any);
      onEvent("board");
      return text({
        ok: true,
        updated: (updated as any[]).map((t: any) => brief(t, isPersonal)),
        // #112: 経緯メモの版が合わなかったものは適用していない。現在の全文を返すのでマージして再実行する
        ...(conflicts ? { conflicts } : {}),
        ...(note ? { note } : {}),
      });
    }
  );

  server.registerTool(
    "delete_tasks",
    {
      description: "タスクをゴミ箱に入れる(複数可)。実データは残り restore_tasks で戻せる",
      inputSchema: { ids: z.array(z.number().int()) },
    },
    async ({ ids }) => {
      const results = ids.map((id) => ({ id, trashed: trashTask(id) }));
      onEvent("board");
      return text({ ok: true, results, note: "ゴミ箱に入れました (実データは残っています)。復元は restore_tasks" });
    }
  );

  server.registerTool(
    "restore_tasks",
    {
      description: "ゴミ箱に入れたタスクを元に戻す(複数可)",
      inputSchema: { ids: z.array(z.number().int()) },
    },
    async ({ ids }) => {
      const restored = ids.map((id) => restoreTask(id));
      onEvent("board");
      return text({ ok: true, restored: restored.map((t: any) => brief(t, isPersonal)) });
    }
  );

  // 個人用プロジェクトでは担当者関連のツールごと出さない (#109/#110)
  if (!isPersonal)
    server.registerTool(
    "propose_assignments",
    {
      description:
        "割り振り案を提案する(人間がUI上で承認すると確定)。理由には負荷・履歴などの根拠を書く",
      inputSchema: {
        proposals: z.array(
          z.object({ taskId: z.number().int(), assignee: z.string(), reason: z.string() })
        ),
      },
    },
    async ({ proposals }) => {
      const created = proposals.map((p) => createProposal(p.taskId, p.assignee, p.reason));
      onEvent("proposals");
      return text({ ok: true, proposals: created });
    }
  );

  server.registerTool(
    "search_tasks",
    {
      description:
        "タスクの本文(タイトル・現況・経緯メモ・担当理由)を横断検索する。アーカイブ済みも対象。表記ゆれや言い換えは自分で展開して複数語を渡す(OR検索)",
      inputSchema: { terms: z.array(z.string()).describe("検索語(最大10)。言い換え・英日表記を並べる") },
    },
    async ({ terms }) => text(searchTasks(terms))
  );

  // #108: 記録へのSQL窓口。チャットにしか無く、MCP越しの外部エージェントからは引けなかった。
  // 検収の印(checked_at)を「専用ツールで返す」のではなくこの窓口から読ませるのは、
  // readonly接続が「読めるが書けない」を構造で保証するため — プロンプトで禁じる必要がない
  server.registerTool(
    "query_log",
    {
      description: QUERY_LOG_DESCRIPTION,
      inputSchema: {
        scope: z.enum(["cost", "audit"]).describe("cost=LLM呼び出し記録 / audit=会話・割り振り・タスク"),
        sql: z.string().describe("SELECT または WITH で始まる1文"),
      },
    },
    async ({ scope, sql }) => {
      try {
        return text(scope === "audit" ? queryProjectData(sql) : queryLlmCalls(sql));
      } catch (e: any) {
        return text({ ok: false, error: e?.message ?? String(e) });
      }
    }
  );

  // #107で並び順が「後で良い」の表現手段になったのに、MCPからは並べ替えられなかった
  server.registerTool(
    "reorder_tasks",
    {
      description:
        "列の並び順を付け替える。並べたい順にタスクIDを渡す(「重要そうな順」など意味のある並びも可)。「後回し」は列の下へ、「今やりたい」は上へ。書き忘れたタスクは末尾に残るので消えない",
      inputSchema: {
        status: STATUS.optional().describe("対象の列。省略で全列"),
        ids: z.array(z.number().int()).describe("並べたい順のタスクID"),
      },
    },
    async ({ status, ids }) => {
      const r = reorderTasks(ids, status);
      onEvent("board");
      return text(r);
    }
  );

  server.registerTool(
    "list_trash",
    { description: "ゴミ箱に入っているタスクを取得する (restore_tasks で戻せる)" },
    async () => text({ tasks: listTrashedTasks().map((t: any) => brief(t, isPersonal)) })
  );

  if (!isPersonal)
    server.registerTool(
    "list_members",
    { description: "メンバー一覧(スキル情報つき)を取得する" },
    async () => text({ members: listMembers() })
  );

  server.registerTool(
    "get_project_context",
    { description: "プロジェクトの前提情報(全員共有、チャットのシステムプロンプトに常時含まれる)を取得する" },
    async () => text({ text: getProjectContext() })
  );

  server.registerTool(
    "update_project_context",
    {
      description: "プロジェクトの前提情報を上書き更新する(全文を渡す)",
      inputSchema: { text: z.string() },
    },
    async ({ text: t }) => {
      setProjectContext(t);
      return text({ ok: true });
    }
  );

  server.registerTool(
    "get_metrics",
    { description: "LLM呼び出しのコスト計測サマリー(トークン数・レイテンシ)を取得する" },
    async () => text(metrics())
  );

  return server;
}
