import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CONTEXT_APPEND_DESCRIPTION,
  createCardsAsAgent,
  RESTORE_DESCRIPTION,
  restoreCardsAsAgent,
  updateCardsAsAgent,
} from "./agentWrite.js";
import {
  BLOCKED_BY_DESCRIPTION,
  CONTEXT_WRITE_DESCRIPTION,
  DUE_DESCRIPTION,
  SEARCH_DESCRIPTION,
  PROJECT_CONTEXT_WRITE_DESCRIPTION,
  QUERY_LOG_DESCRIPTION,
  REJECTED_DESCRIPTION,
  REORDER_DESCRIPTION,
  reorderResult,
  searchResult,
  agentStatusValues,
  reorderableStatuses,
  statusDescription,
  SUMMARY_DESCRIPTION,
  UPDATE_TASKS_DESCRIPTION,
} from "./chat.js";
import { z } from "zod";
import {
  queryLogHelp,
  queryProjectData,
  reorderCards,
  trashCard,
  getProjectContextRow,
  getCard,
  listCards,
  searchCards,
  setProjectContext,
} from "./db.js";
import { boardDelta, formatBoardUpdate } from "./boardState.js";
import { contextReference, contextTemplateHint } from "./contextTemplate.js";
import { currentProjectId, customLanes, getProject } from "./store.js";
import type { CardStatus, ViewEvent } from "./types.js";

// 値の一覧はチャット側と共有する。入口ごとに書き分けると必ずズレる (#92 #108 #114 #125 #126)
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
const SYNC_TOKEN_ON_WRITE = z
  .string()
  .optional()
  .describe(
    "直前に受け取った同期トークン (syncToken)。渡すと、その時点から**いま書き込んだ結果まで**の変化が boardChanges に返る。" +
      "他所からの更新 (人間の検収・UIでの並べ替え・別のエージェント) も含むので、自分が見ていない間に何が動いたかが分かる。" +
      "**いま自分が書き換えたぶんも含まれる**ので、updated / created と重なる行がある"
  );

/** 書き込み応答に載せるボードの動き。全件が要るほど変わっていたら sync_board へ誘導する (応答を重くしない)。
 * 組み立て自体は formatBoardUpdate (純粋関数) にあり、そちらでキーの取り違えを試験している */
function boardUpdate(syncToken?: string) {
  return formatBoardUpdate(boardDelta(syncToken), syncToken);
}

/** #108: 更新結果は要点だけ返す。以前は context を含む全フィールドが返っており、
 * 経緯メモを更新するたびに自分が書いた1,800字がそっくり戻ってきていた (トークンの無駄) */
function brief(t: ReturnType<typeof getCard>) {
  if (!t) return null;
  return {
    id: t.id,
    title: t.title,
    status: t.status,
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
export function buildMcpServer(onEvent: (kind: ViewEvent) => void): McpServer {
  const server = new McpServer({ name: "chatban", version: "0.1.0" });

  // #19: このサーバーは接続ごと (=プロジェクトごと) に組み立てられるので、
  // **有効な任意レーンだけを enum に入れられる。**#110 でメンバーの有無でスキーマを変えていたのと同じ形。
  // 値と説明はチャットと同じ関数から作る — 入口ごとに書くとズレる (#92 #108 #114)。
  // **モジュール直下では作れない** (プロジェクトスコープの外で走り、既定プロジェクトのレーンで固まる)
  const LANES = customLanes();
  const STATUS = z.enum(agentStatusValues(LANES) as [string, ...string[]]);
  const STATUS_DESC = statusDescription(LANES);

  // #179: 以前はここで「メンバーが居ないプロジェクトなら assignee をスキーマから外す」
  // という分岐 (#109/#110) をしていた。担当者そのものが無くなったので分岐ごと消えている

  server.registerTool(
    "create_cards",
    {
      description: "カードをボードに追加する(複数可)。UIにはリアルタイム反映される",
      inputSchema: {
        cards: z.array(
          z.object({
            title: z.string(),
            status: STATUS.optional().describe(`省略時はtodo。${STATUS_DESC}`),
            context: z.string().optional().describe("登録に至った経緯・論点・決定事項 (経緯メモの初期値)"),
            summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
            due: z.string().optional().describe(DUE_DESCRIPTION),
            blocked_by: z.array(z.number().int()).optional().describe(BLOCKED_BY_DESCRIPTION),
          })
        ),
        sync_token: SYNC_TOKEN_ON_WRITE,
      },
    },
    async ({ cards, sync_token }) => {
      // #114: 書き込みは agentWrite に集約。以前はMCP側にガードが無く、
      // done指定がそのまま通って「AIが自主的にDoneへ移動」する事故が起きた
      const r = createCardsAsAgent(cards as any);
      onEvent("board");
      return text({
        ok: true,
        created: (r.created as any[]).map((t: any) => brief(t)),
        // #153: 期限の形が違って捨てたものは名指しで返す (保存されたつもりにさせない)
        ...(r.badDue ? { badDue: r.badDue } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...boardUpdate(sync_token),
      });
    }
  );

  server.registerTool(
    "update_cards",
    {
      description: UPDATE_TASKS_DESCRIPTION,
      inputSchema: {
        updates: z.array(
          z.object({
            id: z.number().int().describe("カードID。会話で「#112」と呼ばれるものと同じで、cards テーブルの主キー(id)。プロジェクトごとに1から振られるので、別プロジェクトの#112とは別物"),
            title: z.string().optional(),
            status: STATUS.optional().describe(STATUS_DESC),
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
            due: z.string().nullable().optional().describe(`${DUE_DESCRIPTION}。解除はnull`),
            blocked_by: z.array(z.number().int()).nullable().optional().describe(`${BLOCKED_BY_DESCRIPTION}。全置換で、解除はnull`),
            rejected: flexBool.describe(REJECTED_DESCRIPTION),
          })
        ),
        sync_token: SYNC_TOKEN_ON_WRITE,
      },
    },
    async ({ updates, sync_token }) => {
      const { ok, status, updated, note, conflicts, notFound, badDue } = updateCardsAsAgent(updates as any);
      onEvent("board");
      return text({
        // #120/#123: 1件でも適用できなければ ok:false。
        // 全部ダメだったのか一部だけかは status で言う (配列を数えさせない)
        ok,
        status,
        updated: (updated as any[]).map((t: any) => brief(t)),
        // #112: 経緯メモの版が合わなかったものは適用していない。現在の全文を返すのでマージして再実行する
        ...(conflicts ? { conflicts } : {}),
        ...(notFound ? { notFound } : {}),
        // #153: 期限だけ捨てた行。**フィールドを列挙して返しているので、増やしたら
        // ここも足さないと入口ごとにズレる** (#92 #108 #114 と同じ形で、実際にズレた)
        ...(badDue ? { badDue } : {}),
        ...(note ? { note } : {}),
        ...boardUpdate(sync_token),
      });
    }
  );

  server.registerTool(
    "delete_cards",
    {
      description: "カードをゴミ箱に入れる(複数可)。実データは残り restore_cards で戻せる",
      inputSchema: { ids: z.array(z.number().int()), sync_token: SYNC_TOKEN_ON_WRITE },
    },
    async ({ ids, sync_token }) => {
      const results = ids.map((id) => ({ id, trashed: trashCard(id) }));
      onEvent("board");
      return text({
        ok: true,
        results,
        note: "ゴミ箱に入れました (実データは残っています)。復元は restore_cards",
        ...boardUpdate(sync_token),
      });
    }
  );

  server.registerTool(
    "restore_cards",
    {
      description: RESTORE_DESCRIPTION,
      inputSchema: { ids: z.array(z.number().int()), sync_token: SYNC_TOKEN_ON_WRITE },
    },
    async ({ ids, sync_token }) => {
      // #161: 判定と報告は agentWrite に集約 (入口ごとに ok の意味が違わないように)。
      // 返す形も共通側で絞ってあるので、ここで brief() を通す必要はない —
      // **チャットとMCPで応答の形まで同じ**になる (以前は片方だけ要約していた)
      onEvent("board");
      return text({ ...restoreCardsAsAgent(ids), ...boardUpdate(sync_token) });
    }
  );

  server.registerTool(
    "search_cards",
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: { terms: z.array(z.string()).describe("検索語(最大10)。言い換え・英日表記を並べる") },
    },
    async ({ terms }) => text(searchResult(searchCards(terms)))
  );

  // #108: 記録へのSQL窓口。チャットにしか無く、MCP越しの外部エージェントからは引けなかった。
  // 検収の印(checked_at)を「専用ツールで返す」のではなくこの窓口から読ませるのは、
  // readonly接続が「読めるが書けない」を構造で保証するため — プロンプトで禁じる必要がない
  server.registerTool(
    "query_log",
    {
      description: QUERY_LOG_DESCRIPTION,
      inputSchema: {
        sql: z.string().describe("SELECT または WITH で始まる1文"),
      },
    },
    async ({ sql }) => {
      try {
        return text(queryProjectData(sql));
      } catch (e: any) {
        // 失敗したら、直せるだけの材料を一緒に返す。チャットと同じ関数を使う
        const error = e?.message ?? String(e);
        return text({ ok: false, error, ...queryLogHelp(error) });
      }
    }
  );

  // #107で並び順が「後で良い」の表現手段になったのに、MCPからは並べ替えられなかった
  server.registerTool(
    "reorder_cards",
    {
      description: REORDER_DESCRIPTION,
      inputSchema: {
        status: z.enum(reorderableStatuses(LANES) as [string, ...string[]]).describe("対象の列"),
        ids: z.array(z.number().int()).describe("その列のカードを並べたい順に"),
        sync_token: SYNC_TOKEN_ON_WRITE,
      },
    },
    async ({ status, ids, sync_token }) => {
      const r = reorderCards(ids, status as CardStatus);
      onEvent("board");
      return text({ ...reorderResult(r), ...boardUpdate(sync_token) });
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
      // 外部エージェントが書き換えたときも、開いている画面に伝える (入口で挙動を変えない)
      if (r.ok) onEvent("context");
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
    "sync_board",
    {
      description:
        "手持ちのボードの認識を最新に合わせる。**作業を始める前に一度呼ぶ。**" +
        "sync_token を渡すと、そのとき以降に変わったぶんだけが返る (#4 は todo -> inprogress のような形)。省略すると全件返る。" +
        "**自分が最後に読んだ一覧は古くなっている**ので、間が空いたときや他所の変更が入りうるときは、記憶で判断せずこれを呼ぶこと。" +
        "sync_token が保持期間(60分)を過ぎていても失敗しない — 黙って最新の全件と新しい同期トークンが返るので、そのまま使い直せばよい。" +
        "プロジェクトの前提情報は**版 (projectContextVersion) だけ**返る。中身は get_project_context で取る (最初の1回と、版が変わったときだけでよい)。",
      inputSchema: {
        sync_token: z
          .string()
          .optional()
          .describe("前回この道具が返した同期トークン (syncToken)。省略すると全件返る"),
      },
    },
    async ({ sync_token }) => {
      const d = boardDelta(sync_token);
      if (!d.full) {
        return text({
          syncToken: d.syncToken,
          fromSyncToken: d.fromSyncToken,
          projectContextVersion: d.projectContextVersion,
          // 空配列は返さない (書き込み応答の formatBoardUpdate と同じ扱い)。
          // 「[] と note が両方載っている」は読む側に一瞬考えさせるだけで、何も足さない
          ...(d.changes?.length ? { boardChanges: d.changes } : { note: "前回の同期トークンから変化なし" }),
        });
      }
      return text({
        syncToken: d.syncToken,
        ...(d.note ? { note: d.note } : {}),
        project: currentProject(),
        // #187: 前提情報は**本文を載せず版だけ**。3,000字級の本文がボードを取るたびに乗っていた。
        // 中身が要るとき (最初の1回・版が変わったとき) だけ get_project_context を呼べばよい
        projectContextVersion: d.projectContextVersion,
        // checked は brief に無いのでここで足す。**人が検収したかどうかは全件応答からも
        // 読めないといけない** — 差分だけ直しても、取り直したときに分からなければ同じ事故が起きる
        cards: listCards().map((t) => ({ ...brief(t)!, checked: !!t.checkedAt })),
      });
    }
  );

  return server;
}
