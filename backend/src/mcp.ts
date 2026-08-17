import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONTEXT_APPEND_DESCRIPTION, createTasksAsAgent, updateTasksAsAgent } from "./agentWrite.js";
import {
  BLOCKED_BY_DESCRIPTION,
  CONTEXT_WRITE_DESCRIPTION,
  PROJECT_CONTEXT_WRITE_DESCRIPTION,
  QUERY_LOG_DESCRIPTION,
  REJECTED_DESCRIPTION,
  REORDER_DESCRIPTION,
  AGENT_STATUS_VALUES,
  REORDERABLE_STATUSES,
  STATUS_DESCRIPTION,
  SUMMARY_DESCRIPTION,
  UPDATE_TASKS_DESCRIPTION,
} from "./chat.js";
import { z } from "zod";
import {
  queryLlmCalls,
  queryLogHelp,
  queryProjectData,
  reorderTasks,
  createTask,
  restoreTask,
  trashTask,
  getProjectContext,
  getProjectContextRow,
  getTask,
  listMembers,
  listSummaryCards,
  listTasks,
  listTrashedTasks,
  memberLoads,
  metrics,
  searchTasks,
  setProjectContext,
  updateTasks,
} from "./db.js";
import { boardDelta, formatBoardUpdate } from "./boardState.js";
import { archiveState } from "./hooks.js";
import { contextReference, contextTemplateHint, currentProjectId, getProject } from "./store.js";
import type { TaskStatus } from "./types.js";

// 値の一覧はチャット側と共有する。入口ごとに書き分けると必ずズレる (#92 #108 #114 #125 #126)
const STATUS = z.enum(AGENT_STATUS_VALUES);

/** boolean を文字列で送ってくるMCPクライアントがある (実測: Claude Code から
 * reference=true を渡すと "true" が届き、z.boolean() が弾いた)。
 * 呼ぶ側の実装差でツールが使えなくなるので、受け側で吸収する。
 * "false"/"0"/"" は偽として扱う — 文字列を素直に真偽変換すると "false" が true になる */
const flexBool = z.preprocess(
  (v) => (typeof v === "string" ? !["false", "0", ""].includes(v.toLowerCase()) : v),
  z.boolean().optional()
);

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// #150: 書き込みの応答に「前回見たとき以降の変化」を同梱する。
// 差分を専用の道具だけにすると「取りに行こうと思ったとき」しか更新されないが、
// **間違えているときは取りに行こうと思っていない** (思い込んでいるからこそ間違えている)。
// エージェントは作業中に必ず何かを書くので、そこに相乗りさせれば追加の往復ゼロで最新が届く。
const SINCE_ON_WRITE = z
  .string()
  .optional()
  .describe(
    "直前に受け取った状況ID。渡すと、その状況IDの時点から**いま書き込んだ結果まで**の変化が changesSince に返る。" +
      "他所からの更新 (人間の検収・UIでの並べ替え・別のエージェント) も含むので、自分が見ていない間に何が動いたかが分かる。" +
      "**いま自分が書き換えたぶんも含まれる**ので、updated / created と重なる行がある"
  );

/** 書き込み応答に載せるボードの動き。全件が要るほど変わっていたら get_board へ誘導する (応答を重くしない)。
 * 組み立て自体は formatBoardUpdate (純粋関数) にあり、そちらでキーの取り違えを試験している */
function boardUpdate(since?: string) {
  return formatBoardUpdate(boardDelta(since), since);
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
            summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
            due: z.string().optional().describe("期限 YYYY-MM-DD"),
            blocked_by: z.array(z.number().int()).optional().describe(BLOCKED_BY_DESCRIPTION),
          })
        ),
        since: SINCE_ON_WRITE,
      },
    },
    async ({ tasks, since }) => {
      // #114: 書き込みは agentWrite に集約。以前はMCP側にガードが無く、
      // done指定がそのまま通って「AIが自主的にDoneへ移動」する事故が起きた
      const r = createTasksAsAgent(tasks as any);
      onEvent("board");
      return text({
        ok: true,
        created: (r.created as any[]).map((t: any) => brief(t, isPersonal)),
        ...(r.note ? { note: r.note } : {}),
        ...boardUpdate(since),
      });
    }
  );

  server.registerTool(
    "update_tasks",
    {
      description: UPDATE_TASKS_DESCRIPTION,
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
            summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
            context: z
              .string()
              .optional()
              .describe(CONTEXT_WRITE_DESCRIPTION),
            context_version: z
              .number()
              .int()
              .optional()
              .describe("context を渡すときのみ必須。直前に query_log で読んだ context_version をそのまま添える"),
            context_append: z.string().optional().describe(CONTEXT_APPEND_DESCRIPTION),
            due: z.string().nullable().optional().describe("期限 YYYY-MM-DD。解除はnull"),
            blocked_by: z.array(z.number().int()).nullable().optional().describe(`${BLOCKED_BY_DESCRIPTION}。全置換で、解除はnull`),
            rejected: flexBool.describe(REJECTED_DESCRIPTION),
          })
        ),
        since: SINCE_ON_WRITE,
      },
    },
    async ({ updates, since }) => {
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
        ...boardUpdate(since),
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
        // 失敗したら、直せるだけの材料を一緒に返す。チャットと同じ関数を使う
        const error = e?.message ?? String(e);
        return text({ ok: false, error, ...queryLogHelp(scope, error) });
      }
    }
  );

  // #107で並び順が「後で良い」の表現手段になったのに、MCPからは並べ替えられなかった
  server.registerTool(
    "reorder_tasks",
    {
      description: REORDER_DESCRIPTION,
      inputSchema: {
        status: z.enum(REORDERABLE_STATUSES).describe("対象の列"),
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
        "この接続の足場を取得する。対象プロジェクト(接続URLで固定)と、その前提情報(全員共有)。作業を始める前に一度読む。ボードの中身は query_log で引く。" +
        "前提情報に足りない節があると templateHint が付く。reference=true で呼ぶと書き方の参考が取れる",
      inputSchema: {
        reference: flexBool
          .describe(
            "trueなら前提情報の書き方のリファレンスも返す。雛形ではなく「こういう使い方がある」の一覧で、このプロジェクトに合うものを選んで採る"
          ),
      },
    },
    async ({ reference }) => {
      const row = getProjectContextRow();
      // テンプレートは新規プロジェクトにしか入らないので、直しても既存は取り残される。
      // 足りない節があることだけ知らせ、雛形は求められたときに渡す (常に返すと600字が毎回乗る)
      const hint = contextTemplateHint(row.text);
      return text({
        // #96: 接続がどのプロジェクトに向いているか。SQL窓口は
        // プロジェクトDBしか見えないので、これはここでしか確認できない
        project: currentProject(),
        ...row, // text と version (上書きするとき版が要る #115)
        ...(hint ? { templateHint: hint } : {}),
        ...(reference
          ? {
              reference: contextReference(),
              referenceNote:
                "これをそのまま書き戻さないこと。並んでいるのは選択肢で、このプロジェクトに当てはまるものだけを選ぶ。" +
                "書き戻すときは、いまの text を1文字も削らずに、選んだものを足した全文を update_project_context に渡す" +
                "(既存の記述はそのプロジェクトの決めごとなので、参考の文言で置き換えない)。" +
                "どれを選ぶか判断がつかないときは、人間に聞いてから書く",
            }
          : {}),
        // #108: 要約の再生成は15〜80秒かかる。生成中に「完了した」と誤認しないように知らせる
        ...(archiveState.running.get(currentProjectId())
          ? { archiveRunning: "要約カードを再生成中。結果を見るなら少し待って引き直すこと" }
          : {}),
      });
    }
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

  server.registerTool(
    "get_board",
    {
      description:
        "ボードの現在の状況と**状況ID**を返す。作業を始める前に一度呼ぶ。" +
        "状況IDを since に渡すと、そのとき以降に変わったぶんだけが返る (#4 は todo -> inprogress のような形)。" +
        "**自分が最後に読んだ一覧は古くなっている**ので、間が空いたときや他所の変更が入りうるときは、記憶で判断せずこれを呼ぶこと。" +
        "since が保持期間(60分)を過ぎていても失敗しない — 黙って最新の全件と新しい状況IDが返るので、そのまま使い直せばよい。",
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe("前回この道具が返した状況ID。省略すると全件返る"),
      },
    },
    async ({ since }) => {
      const d = boardDelta(since);
      if (!d.full) {
        return text({
          stateId: d.stateId,
          since: d.since,
          changes: d.changes,
          ...(d.changes && d.changes.length === 0 ? { note: "前回の状況IDから変化なし" } : {}),
        });
      }
      return text({
        stateId: d.stateId,
        ...(d.note ? { note: d.note } : {}),
        project: currentProject(),
        projectContext: getProjectContext() ?? "",
        // checked は brief に無いのでここで足す。**人が検収したかどうかは全件応答からも
        // 読めないといけない** — 差分だけ直しても、取り直したときに分からなければ同じ事故が起きる
        tasks: listTasks().map((t) => ({ ...brief(t, isPersonal)!, checked: !!t.checkedAt })),
        summaryCards: listSummaryCards().map((c) => ({
          id: c.id,
          title: c.title,
          elements: c.elements.map((e) => e.text),
        })),
      });
    }
  );

  return server;
}
