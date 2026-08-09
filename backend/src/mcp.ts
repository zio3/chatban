import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createProposal,
  createTask,
  deleteTask,
  getProjectContext,
  listMembers,
  listPendingProposals,
  listTasks,
  memberLoads,
  metrics,
  setProjectContext,
  updateTasks,
} from "./db.js";
import type { TaskStatus } from "./types.js";

const STATUS = z.enum(["todo", "inprogress", "review", "done"]);

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// MCPクライアント(Claude Code等)向けのサーバー。変更系は onEvent でUIへブロードキャストする
export function buildMcpServer(onEvent: (kind: "board" | "proposals") => void): McpServer {
  const server = new McpServer({ name: "chatban", version: "0.1.0" });

  server.registerTool(
    "list_tasks",
    { description: "かんばんボードの全タスクとメンバー(負荷つき)を取得する" },
    async () => text({ tasks: listTasks(), members: memberLoads(), pendingProposals: listPendingProposals() })
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
            reason: z.string().optional().describe("担当理由"),
          })
        ),
      },
    },
    async ({ tasks }) => {
      const created = tasks.map((t) =>
        createTask(t.title, (t.status ?? "todo") as TaskStatus, t.assignee ?? null, t.reason ?? null)
      );
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
            reason: z.string().optional(),
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
            ...(u.reason !== undefined ? { reason: u.reason } : {}),
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
      description: "タスクを削除する(複数可)",
      inputSchema: { ids: z.array(z.number().int()) },
    },
    async ({ ids }) => {
      const results = ids.map((id) => ({ id, deleted: deleteTask(id) }));
      onEvent("board");
      return text({ ok: true, results });
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
