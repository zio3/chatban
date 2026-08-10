import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { onTaskReopened, onTasksCompleted } from "./archive.js";
import { estimateCallCost, fetchBillingUsage, fetchModelCatalog, getModel, MODEL_DEFAULTS, type ModelSlot } from "./llm.js";
import { generateSuggestions, runChatTurn } from "./chat.js";
import { hooks } from "./hooks.js";
import { log } from "./log.js";
import { buildMcpServer } from "./mcp.js";
import { resetPromptState } from "./promptState.js";
import {
  activeProjectId,
  createProjectWithMembers,
  currentProjectId,
  getProject,
  listProjects,
  migrateLegacyDbIfNeeded,
  projectSummaries,
  renameProject,
  reportOrphanFiles,
  setActiveProjectId,
  setProjectMembers,
  trashProject,
  withProject,
} from "./store.js";
import {
  auditLog,
  createTask,
  deleteSetting,
  listTrashedTasks,
  purgeTask,
  restoreTask,
  trashTask,
  exportAll,
  getSetting,
  setSetting,
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

// #86: 旧構成 (backend/chatban.db 単一ファイル) があればプロジェクト1として取り込む。
// 以降は data/ 配下 (管理DB + プロジェクトDB) だけを見る。DBに触る前に必ず通す
migrateLegacyDbIfNeeded();
reportOrphanFiles();

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
// #98: フックはリクエストが終わった後に走るので、そのままだとプロジェクトのスコープから外れる。
// 「MCPでプロジェクト3のタスクを完了 → プロジェクト1の要約カードに合流」という静かな事故を防ぐため、
// 呼ばれた時点(=まだスコープ内)のプロジェクトIDを捕まえ、非同期処理の中で入り直す。
// UIへの通知は、そのプロジェクトが表示中のときだけ送る (別プロジェクトの画面を汚さない)
if (process.env.AUTO_ARCHIVE !== "0") {
  const runScoped = (label: string, job: () => Promise<unknown>) => {
    const projectId = currentProjectId();
    archiveJobDelta(1);
    withProject(projectId, job)
      .then(() => {
        if (projectId === activeProjectId()) withProject(projectId, async () => broadcastBoard());
      })
      .catch((e) => log("archive", `${label} (project #${projectId}) failed: ${e?.message ?? e}`))
      .finally(() => archiveJobDelta(-1));
  };
  hooks.tasksCompleted = (taskIds) => runScoped(`tasksCompleted [${taskIds.join(",")}]`, () => onTasksCompleted(taskIds));
  hooks.taskReopened = (taskId) => runScoped(`taskReopened #${taskId}`, () => onTaskReopened(taskId));
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

// #102: 削除はゴミ箱行き (論理削除)。自然言語UIでは解釈ミスが必ず起きるので、
// 「間違えないようにする」のではなく「間違えても取り返しがつく」形にする
app.delete("/api/tasks/:id", (req, res) => {
  const ok = trashTask(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "not found" });
  broadcastBoard();
  res.json({ ok: true });
});

app.get("/api/trash", (_req, res) => {
  res.json({ tasks: listTrashedTasks() });
});

app.post("/api/tasks/:id/restore", (req, res) => {
  const task = restoreTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: "not found" });
  broadcastBoard();
  res.json(task);
});

// 実体の削除。人間のUI操作からのみ通す (チャット・MCPにはこの口を出さない)
app.delete("/api/trash/:id", (req, res) => {
  const ok = purgeTask(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "not found" });
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
  const m = metrics();
  // 直近リストの各行にコスト概算を付ける。単価が引けない/カタログ取得失敗なら null のまま
  const recent = await Promise.all(
    m.recent.map(async (r: any) => ({
      ...r,
      estimatedUsd: await estimateCallCost(r.routed_model, r.model, r.prompt_tokens, r.completion_tokens, r.cached_tokens ?? 0).catch(
        () => null
      ),
    }))
  );
  res.json({ ...m, recent, billing });
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

// プロジェクト (#86): SQLiteファイルごと分かれている。切り替えるとボード・チャット・
// 前提情報・メンバーがまとめて入れ替わる (アクティブはサーバー側に1つ)
app.get("/api/projects", (_req, res) => {
  res.json({ projects: projectSummaries() });
});

app.post("/api/projects", (req, res) => {
  const { name, members } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name required" });
  const p = createProjectWithMembers(String(name).trim(), Array.isArray(members) ? members : []);
  res.json({ ok: true, project: p });
});

app.post("/api/projects/:id/activate", (req, res) => {
  try {
    setActiveProjectId(Number(req.params.id));
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? "activate failed" });
  }
  resetPromptState(); // ボードが総取っ替えになるのでプロンプトの基準スナップショットを作り直す
  io.emit("project:changed", { projects: projectSummaries() });
  broadcastBoard();
  broadcastProposals();
  res.json({ ok: true, projects: projectSummaries() });
});

app.patch("/api/projects/:id", (req, res) => {
  const id = Number(req.params.id);
  const { name, members } = req.body ?? {};
  if (typeof name === "string" && name.trim()) renameProject(id, name.trim());
  if (Array.isArray(members)) setProjectMembers(id, members);
  io.emit("project:changed", { projects: projectSummaries() });
  if (id === activeProjectId()) broadcastBoard();
  res.json({ ok: true, projects: projectSummaries() });
});

app.delete("/api/projects/:id", (req, res) => {
  try {
    trashProject(Number(req.params.id));
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? "delete failed" });
  }
  io.emit("project:changed", { projects: projectSummaries() });
  res.json({ ok: true, projects: projectSummaries() });
});

// 管理画面 (#88): 用途別モデルの実効値と既定値。source=どこから来た値か
const SLOTS: ModelSlot[] = ["main", "archive", "cheap"];
app.get("/api/settings/models", (_req, res) => {
  res.json({
    slots: SLOTS.map((slot) => ({
      slot,
      model: getModel(slot),
      default: MODEL_DEFAULTS[slot],
      source: getSetting(`model.${slot}`) ? "settings" : "default",
    })),
  });
});

// 切り替えは即時反映 (getModelが呼び出しごとにDBを引くため再起動不要)。
// null/空文字を渡すと設定を削除して既定値に戻る
app.post("/api/settings/models", (req, res) => {
  const updates = (req.body ?? {}) as Partial<Record<ModelSlot, string | null>>;
  for (const slot of SLOTS) {
    if (!(slot in updates)) continue;
    const v = updates[slot];
    if (v) setSetting(`model.${slot}`, v);
    else deleteSetting(`model.${slot}`);
  }
  log("settings", `models -> ${SLOTS.map((s) => `${s}=${getModel(s)}`).join(" ")}`);
  io.emit("settings:changed", {});
  res.json({ ok: true, slots: SLOTS.map((slot) => ({ slot, model: getModel(slot) })) });
});

// モデル候補一覧 (単価つき)。外部API失敗時は空配列 — 手入力のフォールバックがあるので致命的でない
app.get("/api/models", async (_req, res) => {
  try {
    res.json({ models: await fetchModelCatalog() });
  } catch (e: any) {
    log("settings", `model catalog failed: ${e?.message ?? e}`);
    res.json({ models: [] });
  }
});

// プロジェクト前提情報の閲覧 (#73)。編集はチャット経由のみ (update_project_context)
app.get("/api/project-context", (_req, res) => {
  res.json(getProjectContextRow());
});

// MCPエンドポイント (Streamable HTTP, stateless: リクエストごとに接続を組み立てる)
//
// #96: 対象プロジェクトは接続URLで固定する。ツールの引数には出さない
// (引数が増えるほどLLMは迷う)。UIの表示中プロジェクトが変わっても影響を受けないので、
// 「エージェントが作業中に人間が切り替えて、次の書き込みが別プロジェクトに落ちる」事故が起きない。
// 複数プロジェクトを扱いたければ .mcp.json のエントリを分ける (ツール名の接頭辞で判別できる)。
app.post("/mcp/:projectId", async (req, res) => {
  const projectId = Number(req.params.projectId);
  const project = Number.isFinite(projectId) ? getProject(projectId) : undefined;
  if (!project) {
    log("mcp", `存在しないプロジェクト #${req.params.projectId} への接続を拒否`);
    return res.status(400).json({ error: `project #${req.params.projectId} not found`, available: projectList() });
  }
  // 書き込みはこの接続のプロジェクトに対して行う。UIへの通知は表示中のときだけ
  const mcpServer = buildMcpServer((kind) => {
    if (projectId !== activeProjectId()) return;
    if (kind === "board") broadcastBoard();
    else broadcastProposals();
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    mcpServer.close();
  });
  try {
    await withProject(projectId, async () => {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  } catch (e) {
    console.error("mcp error:", e);
    if (!res.headersSent) res.status(500).json({ error: "mcp failed" });
  }
});

const projectList = () => listProjects().map((p) => ({ id: p.id, name: p.name, url: `/mcp/${p.id}` }));

// プロジェクト未指定は受け付けない。フォールバックすると事故の原因が残り続けるため。
// MCPの接続失敗はクライアント側で潰れて見えなくなるので、直し方をログとレスポンスの両方に出す
app.post("/mcp", (_req, res) => {
  log(
    "mcp",
    `プロジェクト未指定の接続を拒否しました。.mcp.json の url を http://localhost:${PORT}/mcp/<projectId> にしてください。利用可能: ${listProjects()
      .map((p) => `#${p.id} ${p.name}`)
      .join(" / ")}`
  );
  res.status(400).json({
    error: "プロジェクトを指定してください。url を /mcp/<projectId> にしてください",
    available: projectList(),
  });
});
app.get(["/mcp", "/mcp/:projectId"], (_req, res) => res.status(405).json({ error: "stateless server: POST only" }));
app.delete(["/mcp", "/mcp/:projectId"], (_req, res) => res.status(405).json({ error: "stateless server: POST only" }));

server.listen(PORT, () => {
  console.log(`ChatBan backend listening on http://localhost:${PORT}`);
});
