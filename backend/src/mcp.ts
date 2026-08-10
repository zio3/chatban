import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createProposal,
  createTask,
  restoreTask,
  trashTask,
  getProjectContext,
  listMembers,
  listPendingProposals,
  listTasks,
  memberLoads,
  metrics,
  searchTasks,
  setProjectContext,
  updateTasks,
} from "./db.js";
import { currentProjectId, getProject } from "./store.js";
import type { TaskStatus } from "./types.js";

const STATUS = z.enum(["todo", "inprogress", "review", "done"]);

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** この接続が対象としているプロジェクト (URLで固定されている #96) */
function currentProject() {
  const id = currentProjectId();
  return { id, name: getProject(id)?.name ?? "(不明)" };
}

// MCPクライアント(Claude Code等)向けのサーバー。変更系は onEvent でUIへブロードキャストする
export function buildMcpServer(onEvent: (kind: "board" | "proposals") => void): McpServer {
  const server = new McpServer({ name: "chatban", version: "0.1.0" });

  server.registerTool(
    "list_tasks",
    { description: "かんばんボードの全タスクとメンバー(負荷つき)を取得する" },
    async () =>
      text({
        // #96: この接続が固定されているプロジェクト。エージェントが自分の作業対象を確認できるように
        // 応答に含める (接続URLで決まるので途中で変わらない)
        project: currentProject(),
        tasks: listTasks(),
        members: memberLoads(),
        pendingProposals: listPendingProposals(),
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
            assignee: z.string().optional().describe("担当者名。未定なら省略"),
            assign_reason: z.string().optional().describe("なぜこの担当かを一言で。進捗は書かない"),
            context: z.string().optional().describe("登録に至った経緯・論点・決定事項 (経緯メモの初期値)"),
          })
        ),
      },
    },
    async ({ tasks }) => {
      const created = tasks.map((t) => {
        const task = createTask(t.title, (t.status ?? "todo") as TaskStatus, t.assignee ?? null, t.assign_reason ?? null);
        return t.context ? updateTasks([{ id: task.id, patch: { context: t.context } }])[0] : task;
      });
      onEvent("board");
      return text({ ok: true, created });
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
            assignee: z.string().nullable().optional(),
            assign_reason: z.string().optional().describe("なぜこの担当かを一言で。進捗は書かない"),
            summary: z.string().optional().describe("現況の一言。カードに表示される。詳細な根拠は context へ"),
            lane: z.enum(["demo", "later"]).nullable().optional().describe("demo=90秒台本に必要 / later=機能凍結後"),
            context: z.string().optional().describe("経緯メモ(詳細・決定事項)の全文上書き"),
            due: z.string().nullable().optional().describe("期限 YYYY-MM-DD。解除はnull"),
            blocked_by: z.array(z.number().int()).nullable().optional().describe("依存先タスクID(全置換)。解除はnull"),
            rejected: z.boolean().optional().describe("却下(やらない決定)フラグ。reasonに根拠を書く"),
          })
        ),
      },
    },
    async ({ updates }) => {
      // 一括更新は db 層でまとめて処理 (完了遷移の通知=要約再生成が1回で済む #60)
      const updated = updateTasks(
        updates.map((u) => ({
          id: u.id,
          patch: {
            ...(u.title !== undefined ? { title: u.title } : {}),
            ...(u.status !== undefined ? { status: u.status as TaskStatus } : {}),
            ...(u.assignee !== undefined ? { assignee: u.assignee } : {}),
            ...(u.assign_reason !== undefined ? { assignReason: u.assign_reason } : {}),
            ...(u.summary !== undefined ? { summary: u.summary } : {}),
            ...(u.lane !== undefined ? { lane: u.lane } : {}),
            ...(u.context !== undefined ? { context: u.context } : {}),
            ...(u.due !== undefined ? { due: u.due } : {}),
            ...(u.blocked_by !== undefined ? { blockedBy: u.blocked_by } : {}),
            ...(u.rejected !== undefined ? { rejected: u.rejected } : {}),
          },
        }))
      );
      onEvent("board");
      return text({ ok: true, updated });
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
      return text({ ok: true, restored });
    }
  );

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
