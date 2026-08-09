import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { onTaskReopened, onTasksCompleted } from "./archive.js";
import { fetchBillingUsage } from "./llm.js";
import { generateSuggestions, runChatTurn } from "./chat.js";
import { hooks } from "./hooks.js";
import { log } from "./log.js";
import { buildMcpServer } from "./mcp.js";
import {
  auditLog,
  createTask,
  deleteTask,
  exportAll,
  getProjectContextRow,
  getTask,
  listChatMessages,
  listMembers,
  listPendingProposals,
  listSummaryCards,
  listTasks,
  metrics,
  resolveProposal,
  saveChatMessage,
  updateTask,
  updateTasks,
} from "./db.js";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" })); // #68: 添付(画像/PDFのbase64)を受けるため拡大

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

function broadcastBoard() {
  io.emit("board:changed", { tasks: listTasks(), summaryCards: listSummaryCards() });
}
function broadcastProposals() {
  io.emit("proposals:changed", { proposals: listPendingProposals() });
}

// 要約再生成は非同期で15〜30秒かかるため、実行中件数をUIへ通知する (#56)
let archiveJobs = 0;
function archiveJobDelta(delta: number) {
  archiveJobs = Math.max(0, archiveJobs + delta);
  io.emit("archive:working", { count: archiveJobs });
}

// 完了→即アーカイブ+要約合流 (E2E等ではAUTO_ARCHIVE=0で無効化)
// #60: 完了は常にバッチで届く (単一done=長さ1)。N件一括検収でも要約再生成(LLM呼び出し)は1回
if (process.env.AUTO_ARCHIVE !== "0") {
  hooks.tasksCompleted = (taskIds) => {
    archiveJobDelta(1);
    onTasksCompleted(taskIds)
      .then(() => broadcastBoard())
      .catch((e) => log("archive", `tasksCompleted [${taskIds.join(",")}] failed: ${e?.message ?? e}`))
      .finally(() => archiveJobDelta(-1));
  };
  hooks.taskReopened = (taskId) => {
    archiveJobDelta(1);
    onTaskReopened(taskId)
      .then(() => broadcastBoard())
      .catch((e) => log("archive", `taskReopened #${taskId} failed: ${e?.message ?? e}`))
      .finally(() => archiveJobDelta(-1));
  };
}

app.get("/api/board", (_req, res) => {
  res.json({
    tasks: listTasks(),
    members: listMembers(),
    proposals: listPendingProposals(),
    summaryCards: listSummaryCards(),
  });
});

app.post("/api/tasks", (req, res) => {
  const { title, status, assignee, reason } = req.body ?? {};
  if (!title) return res.status(400).json({ error: "title required" });
  const task = createTask(title, status ?? "todo", assignee ?? null, reason ?? null);
  broadcastBoard();
  res.json(task);
});

// 一括検収 (#57/#60): Review→Doneの確定。複数前提の1ルート (単一もここを通る)
app.post("/api/tasks/approve", (req, res) => {
  const ids = (req.body?.ids ?? []) as number[];
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids required" });
  const updated = updateTasks(ids.map((id) => ({ id, patch: { status: "done" as const } })));
  broadcastBoard();
  res.json({ ok: true, updated });
});

// アーカイブ済み含む単一タスク取得 (#59: 要約カードの#xxリンクから詳細を開く用)
app.get("/api/tasks/:id", (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: "not found" });
  res.json(task);
});

app.patch("/api/tasks/:id", (req, res) => {
  const task = updateTask(Number(req.params.id), req.body ?? {});
  if (!task) return res.status(404).json({ error: "not found" });
  broadcastBoard();
  res.json(task);
});

app.delete("/api/tasks/:id", (req, res) => {
  const ok = deleteTask(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "not found" });
  broadcastBoard();
  res.json({ ok: true });
});

app.post("/api/proposals/:id/:action", (req, res) => {
  const action = req.params.action;
  if (action !== "approve" && action !== "reject") return res.status(400).json({ error: "bad action" });
  const p = resolveProposal(Number(req.params.id), action === "approve" ? "approved" : "rejected");
  if (!p) return res.status(404).json({ error: "not found" });
  broadcastProposals();
  if (action === "approve") broadcastBoard();
  res.json(p);
});

let chatSeq = 0;
app.post("/api/chat", async (req, res) => {
  const { message, history, speaker, attachments } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "message required" });
  const id = ++chatSeq;
  const t0 = Date.now();
  log(
    "chat",
    `#${id} REQ${speaker ? ` [${speaker}]` : ""} "${String(message).slice(0, 120)}" (history=${history?.length ?? 0}${attachments?.length ? ` attachments=${attachments.length}` : ""})`
  );
  // クライアント切断もログに残す (再起動巻き添え・ブラウザ側中断の追跡用)
  res.on("close", () => {
    if (!res.writableEnded) log("chat", `#${id} CLIENT DISCONNECTED after ${Date.now() - t0}ms`);
  });
  try {
    const result = await runChatTurn(
      message,
      history ?? [],
      (kind) => {
        if (kind === "board") broadcastBoard();
        else broadcastProposals();
      },
      (label) => io.emit("chat:progress", { label }), // 応答完了前の逐次フィードバック
      undefined,
      speaker,
      attachments
    );
    // 会話ログはサーバーに永続化する (添付は原本を保存せず名前だけ記録 #68)
    saveChatMessage("user", message + (attachments?.length ? ` [添付: ${attachments.map((a: any) => a.name).join(", ")}]` : ""));
    saveChatMessage("assistant", result.reply, result.trace, result.usage);
    log(
      "chat",
      `#${id} OK ${Date.now() - t0}ms rounds=${result.usage.rounds} tools=[${result.trace.map((t) => t.tool).join(",")}] reply=${result.reply.length}ch`
    );
    res.json(result);
  } catch (e: any) {
    log("chat", `#${id} FAILED ${Date.now() - t0}ms: ${e?.message ?? e}`);
    res.status(500).json({ error: e?.message ?? "chat failed" });
  }
});

app.get("/api/chat/log", (req, res) => {
  const taskId = req.query.taskId != null ? Number(req.query.taskId) : undefined;
  res.json({ messages: listChatMessages(Number(req.query.limit ?? 50), taskId) });
});

// タスク専用チャット (#24): 対象タスクの全詳細をシステムプロンプトに注入し、会話はtask_id付きで分離保存
app.post("/api/tasks/:id/chat", async (req, res) => {
  const taskId = Number(req.params.id);
  const { message, history, speaker, attachments } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "message required" });
  const id = ++chatSeq;
  const t0 = Date.now();
  log("chat", `#${id} TASK-CHAT(task=${taskId})${speaker ? ` [${speaker}]` : ""} REQ "${String(message).slice(0, 120)}"`);
  try {
    const result = await runChatTurn(
      message,
      history ?? [],
      (kind) => {
        if (kind === "board") broadcastBoard();
        else broadcastProposals();
      },
      (label) => io.emit("chat:progress", { label, taskId }),
      taskId,
      speaker,
      attachments
    );
    saveChatMessage(
      "user",
      message + (attachments?.length ? ` [添付: ${attachments.map((a: any) => a.name).join(", ")}]` : ""),
      undefined,
      undefined,
      taskId
    );
    saveChatMessage("assistant", result.reply, result.trace, result.usage, taskId);
    log("chat", `#${id} OK ${Date.now() - t0}ms rounds=${result.usage.rounds} tools=[${result.trace.map((t) => t.tool).join(",")}]`);
    res.json(result);
  } catch (e: any) {
    log("chat", `#${id} FAILED ${Date.now() - t0}ms: ${e?.message ?? e}`);
    res.status(500).json({ error: e?.message ?? "chat failed" });
  }
});

app.get("/api/metrics", async (_req, res) => {
  // #21: OrcaRouter請求サマリー(実$)を合流。外部API失敗時はnull (トークン集計は常に返す)
  const billing = await fetchBillingUsage();
  res.json({ ...metrics(), billing });
});

// オーディットログ (#33): 会話・LLM呼び出し・割り振り履歴の閲覧
app.get("/api/audit", (_req, res) => {
  res.json(auditLog());
});

// AI提案チップ (#75): ボードの文脈から「いま価値のある操作」を最大3つ。失敗時は空配列 (固定チップが保険)
app.get("/api/suggestions", async (_req, res) => {
  try {
    res.json({ suggestions: await generateSuggestions() });
  } catch (e: any) {
    log("chat", `suggestions failed: ${e?.message ?? e}`);
    res.json({ suggestions: [] });
  }
});

// 全ログExport (#83): 全テーブルのフルダンプをJSONダウンロード (検証利用)
app.get("/api/audit/export", (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 14);
  res.setHeader("Content-Disposition", `attachment; filename="chatban-audit-${stamp}.json"`);
  res.json(exportAll());
});

// プロジェクト前提情報の閲覧 (#73)。編集はチャット経由のみ (update_project_context)
app.get("/api/project-context", (_req, res) => {
  res.json(getProjectContextRow());
});

// MCPエンドポイント (Streamable HTTP, stateless: リクエストごとに接続を組み立てる)
app.post("/mcp", async (req, res) => {
  const mcpServer = buildMcpServer((kind) => {
    if (kind === "board") broadcastBoard();
    else broadcastProposals();
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    mcpServer.close();
  });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("mcp error:", e);
    if (!res.headersSent) res.status(500).json({ error: "mcp failed" });
  }
});
app.get("/mcp", (_req, res) => res.status(405).json({ error: "stateless server: POST only" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "stateless server: POST only" }));

server.listen(PORT, () => {
  console.log(`ChatBan backend listening on http://localhost:${PORT}`);
});
