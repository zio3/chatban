import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTasksAsAgent, updateTasksAsAgent } from "./agentWrite.js";
import {
  PROJECT_CONTEXT_WRITE_DESCRIPTION,
  PROPOSE_DESCRIPTION,
  QUERY_LOG_DESCRIPTION,
  REORDER_DESCRIPTION,
  STATUS_DESCRIPTION,
} from "./chat.js";
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
  getProjectContextRow,
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
    "create_tasks",
    {
      description: "タスクをボードに追加する(複数可)。UIにはリアルタイム反映される",
      inputSchema: {
        tasks: z.array(
          z.object({
            title: z.string(),
            status: STATUS.optional().describe(`省略時はtodo。${STATUS_DESCRIPTION}`),
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
            id: z.number().int().describe("タスクID。会話で「#112」と呼ばれるものと同じで、tasks テーブルの主キー(id)。プロジェクトごとに1から振られるので、別プロジェクトの#112とは別物"),
            title: z.string().optional(),
            status: STATUS.optional().describe(STATUS_DESCRIPTION),
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
              .describe("context を渡すときのみ必須。直前に query_log で読んだ context_version をそのまま添える"),
            due: z.string().nullable().optional().describe("期限 YYYY-MM-DD。解除はnull"),
            blocked_by: z.array(z.number().int()).nullable().optional().describe("依存先タスクID(全置換)。解除はnull"),
            rejected: z.boolean().optional().describe("却下(やらない決定)フラグ。reasonに根拠を書く"),
          })
        ),
      },
    },
    async ({ updates }) => {
      const { ok, status, updated, note, conflicts, notFound } = updateTasksAsAgent(updates as any);
      onEvent("board");
      return text({
        // #120/#123: 1件でも適用できなければ ok:false。
        // 全部ダメだったのか一部だけかは status で言う (配列を数えさせない)
        ok,
        status,
        updated: (updated as any[]).map((t: any) => brief(t, isPersonal)),
        // #112: 経緯メモの版が合わなかったものは適用していない。現在の全文を返すのでマージして再実行する
        ...(conflicts ? { conflicts } : {}),
        ...(notFound ? { notFound } : {}),
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
      description: PROPOSE_DESCRIPTION,
      inputSchema: {
        proposals: z.array(
          z.object({
            taskId: z.number().int(),
            assignee: z.string(),
            reason: z.string().optional().describe("ボード上で確かめられる根拠だけ。無いなら省略する"),
          })
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
      description: REORDER_DESCRIPTION,
      inputSchema: {
        status: z.enum(["todo", "inprogress", "review"]).describe("対象の列"),
        ids: z.array(z.number().int()).describe("その列のタスクを並べたい順に"),
      },
    },
    async ({ status, ids }) => {
      const r = reorderTasks(ids, status);
      onEvent("board");
      return text(r);
    }
  );

  server.registerTool(
    "get_project_context",
    {
      description:
        "この接続の足場を取得する。対象プロジェクト(接続URLで固定)と、その前提情報(全員共有)。作業を始める前に一度読む。ボードの中身は query_log で引く",
    },
    async () =>
      text({
        // #96: 接続がどのプロジェクトに向いているか。SQL窓口は
        // プロジェクトDBしか見えないので、これはここでしか確認できない
        project: currentProject(),
        ...getProjectContextRow(), // text と version (上書きするとき版が要る #115)
        // #108: 要約の再生成は15〜80秒かかる。生成中に「完了した」と誤認しないように知らせる
        ...(archiveState.running.get(currentProjectId())
          ? { archiveRunning: "要約カードを再生成中。結果を見るなら少し待って引き直すこと" }
          : {}),
      })
  );

  server.registerTool(
    "update_project_context",
    {
      description: PROJECT_CONTEXT_WRITE_DESCRIPTION,
      inputSchema: {
        text: z.string().describe("新しい前提情報の全文"),
        version: z
          .number()
          .int()
          .describe("直前に get_project_context で読んだ version。合わないと更新されず現在値が返る"),
      },
    },
    async ({ text: t, version }) => {
      const r = setProjectContext(t, version);
      if (!r.ok)
        return text({
          ok: false,
          conflict: r.current,
          note: "前提情報が他から更新されています。返した text に自分の変更をマージし、この version を添えて再実行してください",
        });
      return text({ ok: true });
    }
  );

  return server;
}
