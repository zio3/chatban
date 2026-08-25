import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import { Server } from "socket.io";
import { foldDoneColumn, foldedContainer, onCardReopened } from "./archive.js";
import { generateSuggestions, runChatTurn } from "./chat.js";
import { warnIfConfigNotIgnored } from "./config.js";
import { hooks } from "./hooks.js";
import { upstreamRefused } from "./llm.js";
import { attachmentsEnabled, jsonLimit } from "./demoMode.js";
import { llmConfig } from "./config.js";
import { log } from "./log.js";
import { buildMcpServer } from "./mcp.js";
import { argDetail, argShape, toolCalls } from "./mcpLog.js";
import { isAllowedOrigin, isBrowserCrossSite } from "./origin.js";
import { resetPromptState } from "./promptState.js";
import { assertTimezone } from "./timezone.js";
import type { Card, ViewEvent } from "./types.js";
import {
  activeProjectId,
  createProject,
  currentProjectId,
  getProject,
  listProjects,
  projectSummaries,
  renameProject,
  customLanes,
  setCustomLabel,
  ensureInitialProject,
  reportOrphanFiles,
  setActiveProjectId,
  setProjectArchived,
  trashProject,
  withProject,
} from "./store.js";
import {
  createCard,
  setChecked,
  listTrashedCards,
  purgeCard,
  restoreCard,
  trashCard,
  getProjectContextRow,
  getCard,
  listChatMessages,
  listCards,
  saveChatMessage,
  updateCard,
  approveChecked,
  DONE_GATE_RULE,
  DUE_FORMAT_RULE,
  isArchived,
  isDueDate,
  isUsableStatus,
  evacuateLane,
  CARD_STATUSES,
} from "./db.js";

const PORT = Number(process.env.PORT ?? 8787);

// #108: DBに触る前にタイムゾーンを確かめる。ずれたまま書き込むと元に戻せない
assertTimezone();
// #182: 設定ファイル自体は遅延で読む (LLMを使わない起動を止めないため) が、
// **キーがコミットされる恐れだけは起動時に言う。**リポジトリは公開なので「あとで消す」が効かない
warnIfConfigNotIgnored();
ensureInitialProject();
reportOrphanFiles();

const app = express();
// #180: 認証を廃止したので Cookie は載らない。守りは「待ち受けを 127.0.0.1 に固定 (PR #28)」と
// 「知らないページからの呼び出しを断る」の2つだけになった。
// Originヘッダの無い呼び出し (curl・同一オリジン・MCP) は通す
const ALLOWED_ORIGINS = (process.env.CHATBAN_ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:5199")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin, ALLOWED_ORIGINS)),
  })
);
// **cors() だけでは止まらない** (Codexレビュー指摘・実測)。許可しない Origin に対して
// cors は ACAO ヘッダを付けないだけで、リクエストはハンドラまで届き、状態も変わる
// (実測: `Origin: https://evil.example` で `POST /api/projects/1/activate` が 200)。
// ブラウザが遮るのは「レスポンスを読むこと」だけなので、書き込みは通ってしまう。
// 認証が無い以上ここが最後の砦なので、**明示的に 403 で断る**
app.use((req, res, next) => {
  // Sec-Fetch-Site はブラウザが自分で付ける (ページ側から偽装できない)。
  // Origin の付かない `<img src>` のような subresource GET を捕まえるのはこちら
  if (isBrowserCrossSite(req.header("Sec-Fetch-Site"))) {
    log("api", `他所のページからの要求を拒否しました (Sec-Fetch-Site): ${req.method} ${req.path}`);
    return res.status(403).json({ error: "forbidden origin" });
  }
  if (isAllowedOrigin(req.header("Origin"), ALLOWED_ORIGINS)) return next();
  log("api", `許可していないOriginからの要求を拒否しました: ${req.header("Origin")} ${req.method} ${req.path}`);
  res.status(403).json({ error: "forbidden origin" });
});
// #68: 添付(画像/PDFのbase64)を受けるため拡大。#213: デモでは添付を閉じるので小さくする
app.use(express.json({ limit: jsonLimit() }));

// #97: どのプロジェクトへの操作かはクライアントがヘッダで明示する (UIはURL /p/<id> が持つ)。
// 指定が無ければ既定プロジェクト (スクリプトやcurlからの素の呼び出し用)。
// MCPがURLで固定しているのと同じ考え方 — サーバー側に隠れた「いま見ているもの」を持たない
app.use((req, res, next) => {
  const raw = req.header("X-ChatBan-Project");
  if (raw == null || raw === "") return next(); // 無指定は既定プロジェクト (curl・スクリプト用)
  const id = Number(raw);
  if (Number.isFinite(id) && getProject(id)) return withProject(id, () => next());
  // #125: 指定したのに存在しないプロジェクトなら拒否する。既定へフォールバックすると
  // 「9999 のつもりの操作が黙って #1 に書き込まれる」。MCP (/mcp/:projectId) は
  // 同じ理由で400にしているので、RESTだけ緩いのは契約のズレ (#96)
  log("api", `存在しないプロジェクト #${raw} への操作を拒否しました`);
  return res.status(400).json({ error: `project #${raw} not found`, available: projectList() });
});

// #247: テストから実HTTPで叩けるように公開する (PORT=0 で空きポートに開ける)。
// **入口の記録はここを通らないと確かめられない** — JSON-RPCのバッチはSDKの内側で展開されるので、
// InMemoryTransport 越しのテストでは再現しない (Codexレビュー P2)
export const server = http.createServer(app);
// #113 → #180: ボードの中身は Socket.IO で流れるので、RESTだけ締めても意味がない。
// **WebSocketのハンドシェイクは CORS の対象外**なので、`cors` オプションは接続の可否に効かない
// (実測: 許可していない Origin から CONNECTED になった。Codexレビュー指摘)。
// 断るのは allowRequest の仕事。cors は polling 経路のヘッダ用に残す
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS },
  allowRequest: (req, cb) => {
    const ok = isAllowedOrigin(req.headers.origin, ALLOWED_ORIGINS);
    if (!ok) log("api", `許可していないOriginからのSocket接続を拒否しました: ${req.headers.origin}`);
    cb(null, ok);
  },
});

// #99: 配信はプロジェクト単位のroomへ。全クライアントへの一斉送信だと、
// タブごとに別プロジェクトを開けるようにした瞬間(#97)に他プロジェクトの更新で画面が壊れる。
// 「どのプロジェクトの通知か」を送信側が必ず意識する形にしておく。
//
// クライアントは接続時に project を指定できる (指定なし=表示中のプロジェクトに追従)。
// 追従組はプロジェクト切替時にサーバー側でroomを移し替える。
// 指定したのに存在しないプロジェクトなら、どのroomにも入れない (下の #125)
const room = (projectId: number) => `project:${projectId}`;

io.on("connection", (socket) => {
  const q = socket.handshake.query.project;
  // 指定なし (query が無い) = 表示中のプロジェクトに追従。指定あり = その1つに固定
  if (q == null || q === "") {
    socket.data.pinned = false;
    socket.join(room(activeProjectId()));
    return;
  }
  const requested = Number(q);
  // #125: 指定したのに存在しないプロジェクトなら、どのroomにも入れない。
  // 以前は「指定なし」と同じ扱いにして既定プロジェクトのroomへ入れていたので、
  // /p/999999 を開くと REST は400で読み込み失敗になる一方、Socket からは既定プロジェクトの
  // board:changed が届き、**存在しないURLの上に別プロジェクトのカードが並んだ**
  // (自動レビュー指摘)。RESTが拒否するものを Socket が黙って別物にすり替えない —
  // 入口ごとに境界が違うと、利用者はどちらを信じてよいか分からない
  if (!Number.isFinite(requested) || !getProject(requested)) {
    socket.data.pinned = true; // 追従の対象にもしない (あとから既定へ引き込まれないように)
    log("api", `存在しないプロジェクト #${String(q)} を指定したSocket接続をどのroomにも入れませんでした`);
    return;
  }
  socket.data.pinned = true;
  socket.join(room(requested));
});

/** 表示中プロジェクトが変わったとき、追従組を新しいroomへ移す (明示指定のクライアントはそのまま) */
function rejoinFollowers(projectId: number) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.pinned) continue;
    for (const r of socket.rooms) if (r.startsWith("project:")) socket.leave(r);
    socket.join(room(projectId));
  }
}

/** ボードが受け取る一式。**取得と配信で同じ関数を通す** —
 * 「初回だけ揃っていて以後ズレる」を型で防ぐ (#19 で lanes を足したとき、片方だけ直る形にしない) */
/** 書き込み経路 (チャット / MCP) からの通知を画面へ流す。**入口が3つあるので1か所にまとめる** —
 * 以前は `if (kind === "board")` が3か所に書いてあり、種類を足すときに片方だけ直る形だった。
 *
 * `context` は前提情報の更新 (レビュー指摘 2026-08-21)。📋前提の画面は**編集UIを持たず、
 * 変更経路がチャットだけ** (#73) なのに、開いたままだと古い本文が出続けていた。
 * 板を配り直すのではなく「変わった」とだけ伝え、見ている画面が取り直す (本文を二重に配らない) */
function notifyView(kind: ViewEvent, projectId = currentProjectId()): void {
  if (kind === "board") broadcastBoard(projectId);
  if (kind === "context") io.to(room(projectId)).emit("context:changed");
}

/** 断る理由を言い分ける。**「受け取れない」だけだと直し方が分からない** —
 * デモの方針なら諦めるしかないが、宛先の都合なら config.json を替えれば通る */
function attachmentRefusal(): string {
  try {
    if (llmConfig().apiStyle === "messages")
      return "いまの宛先 (apiStyle: messages) は添付を扱えません。添付を使うなら config.json を chat 形式の宛先にしてください";
  } catch {
    /* 設定が読めないときは下の一般的な文言で返す */
  }
  return "このデモでは添付を受け付けていません";
}

/** 添付 (画像/PDF) を受けられるか。**2つの理由をここで合わせる。**
 *
 * 1. デモでは受けない (#213: 認証なしで誰でも書けるうえ、入力トークンを大きく食う)
 * 2. **宛先が Messages API 形式のときは経路が持ち回れない** (レビュー指摘 2026-08-21)。
 *    toAnthropicMessages は添付パートを落とすので、モデルには原本が届かないまま
 *    「内容を読み取って活用すること」というテキストだけが届く = **推測で答えられる**
 *
 * 名前を1つにしておくのは、入口が3つ (板の配信・/api/chat・/api/cards/:id/chat) あるため。
 * `&&` を各所に書くと、次に条件が増えたときに片方だけ直る */
function canAcceptAttachments(): boolean {
  if (!attachmentsEnabled()) return false;
  try {
    return llmConfig().apiStyle !== "messages";
  } catch {
    // 設定が読めないならLLM自体が使えない。受け取れると言わない
    return false;
  }
}

/** #226: 板に配る1枚。**経緯メモの本文は載せない。**
 *
 * 実測 (2026-08-20、13枚): ペイロード 22,430字のうち 21,601字 = **96%が経緯メモ**だった。
 * これが REST の初回だけでなく **Socket の board:changed で毎回飛ぶ**ので、
 * カード1枚の status を変えるたびに全件の本文が配り直されていた。
 * 画面に常時出ているのはタイトルと現況だけで、本文を使うのは詳細パネルを開いたときだけ。
 *
 * MCP側は #108 で同じことを直している (brief())。**画面向けだけが全文を配り続けていた**ので、
 * 同じ形に揃える — 本文の代わりに contextChars (あるかどうか・どれくらいか) と
 * contextVersion (変わったかどうか) を載せる。パネルは版を見て取り直せる */
function briefCard(t: Card) {
  const { context, ...rest } = t;
  return { ...rest, contextChars: context?.length ?? 0 };
}

function boardPayload(projectId: number) {
  return {
    cards: listCards().map(briefCard),
    folded: foldedContainer(projectId) ?? [],
    lanes: customLanes(projectId),
    // #212: 上流に断られたまま (残高切れ・キー失効・混雑)。**板を開いた時点で伝わる**ようにする。
    // わざわざ確かめには行かない — 定期監視はそれ自体が課金経路になる (#183)
    llmRefused: upstreamRefused(),
    // #213: 添付の入口が開いているか。**画面を隠すだけでは足りない**ので下で断ってもいるが、
    // 押せないボタンを出しておく理由も無い
    attachments: canAcceptAttachments(),
  };
}

function broadcastBoard(projectId = currentProjectId()) {
  // **引数で別のプロジェクトを名指しできる**ので、中身の取得もそのスコープに入り直して行う
  // (#200 以前は非同期フックがリクエストの外で走るためにも必要だった。そちらは撤去済み)
  withProject(projectId, () => io.to(room(projectId)).emit("board:changed", boardPayload(projectId)));
}

// #200: 完了→Done列を畳み直す (E2E等では AUTO_ARCHIVE=0 で無効化)。
// **同期で完結する**ので、以前あった実行中件数の通知 (archive:working / #56) と
// 非同期スコープの入り直し (#98) は要らなくなった。LLMを待たないぶん、押した瞬間に board が確定する。
if (process.env.AUTO_ARCHIVE !== "0") {
  hooks.cardsCompleted = (cardIds) => {
    const projectId = currentProjectId();
    foldDoneColumn(projectId, cardIds);
    broadcastBoard(projectId);
  };
  hooks.cardReopened = (cardId) => {
    const projectId = currentProjectId();
    onCardReopened(projectId, cardId);
    broadcastBoard(projectId);
  };
}

app.get("/api/board", (_req, res) => {
  res.json(boardPayload(currentProjectId()));
});

app.post("/api/cards", (req, res) => {
  const { title, status } = req.body ?? {};
  if (!title) return res.status(400).json({ error: "title required" });
  const ng = badStatus(status) ?? badDue(req.body?.due);
  if (ng) return res.status(400).json({ error: ng });
  const created = createCard(title, status ?? "todo");
  // #153: **検証だけ足して保存を忘れていた** (Codexレビュー指摘)。この口は title と status しか
  // 見ていないので、正しい形式の due を渡しても 200 のまま黙って捨てていた —
  // 「弾く」を足すときは「通ったものが効く」までを対で確かめる。
  // 不正な値は上で400にしているので、ここへ来るのは実在する日付か解除だけ
  const due = normalizeDue(req.body?.due);
  const card = due === undefined ? created : (updateCard(created.id, { due }) ?? created);
  broadcastBoard();
  // 黙って別の列に入れない。指定と結果が違うことは必ず言う (#123と同じ形)
  res.json({
    ...card,
    ...(status === "done" ? { note: DONE_GATE_NOTE } : {}),
  });
});

// #108: 検収の印 (人が実物で確かめたという記録)。done とは別物で、
// done は列が動いたこと、checked_at は検収が進んだこと。片方からもう片方を推測しない。
// エージェントには読ませるが書かせない — この口はRESTにしか無い
app.post("/api/cards/:id/checked", (req, res) => {
  const { card, error } = setChecked(Number(req.params.id), !!req.body?.checked);
  if (error) return res.status(409).json({ error });
  if (!card) return res.status(404).json({ error: "not found" });
  broadcastBoard();
  res.json(card);
});

/** 外から来た列名を確かめる。TypeScriptの型は実行時には消えるので、RESTの入口で必ず通す。
 * 通してしまうと「保存はされたのにボードのどの列にも出ないカード」ができ、
 * 詳細を開くと画面が落ちる (自動レビュー指摘) */
function badStatus(status: unknown): string | null {
  const lanes = customLanes();
  if (status === undefined || isUsableStatus(status, lanes)) return null;
  // #19: 使える列はプロジェクトによって違うので、**そのプロジェクトで実際に置けるもの**を並べて返す。
  // CARD_STATUSES をそのまま出すと、有効化していない custom1 を「使える」と案内してしまう
  const usable = CARD_STATUSES.filter((v) => isUsableStatus(v, lanes));
  return `status は ${usable.join(" / ")} のいずれかです (受け取った値: ${JSON.stringify(status)})`;
}

/** #153: 期限も同じ形で確かめる。契約は YYYY-MM-DD と言っているのに検証が無く、
 * `not-a-date` がそのまま保存された (ユーザー報告)。解除の null / "" は通す */
function badDue(due: unknown): string | null {
  if (due === undefined || due === null || due === "" || isDueDate(due)) return null;
  return `${DUE_FORMAT_RULE} (受け取った値: ${JSON.stringify(due)})`;
}

/** 解除の "" を null に均す。**均さずにDBへ渡すと空文字が保存され**、画面では解除に見えるのに
 * `WHERE due IS NOT NULL` のSQLには残る (Codexレビュー指摘) — 見えているものと引けるものが食い違う。
 * エージェント経路 (agentWrite) は同じ正規化を持っていたので、RESTだけ抜けていた形。
 * undefined は「指定なし」なのでそのまま返す (patch に載せない印) */
function normalizeDue(due: unknown): string | null | undefined {
  if (due === undefined) return undefined;
  if (due === null || due === "") return null;
  return due as string;
}

// status:"done" を投げられたが動かさなかったときに添える。黙って無視すると
// 「APIは200を返したのに列が動かない」になり、UIのバグに見える
const DONE_GATE_NOTE = `Doneへは移していません。${DONE_GATE_RULE}。確定は POST /api/cards/approve (ボードの検収ボタン) が行います`;

// 一括検収 (#57/#60): Review→Doneの確定。複数前提の1ルート (単一もここを通る)
// 検収の確定。Doneへ至る唯一の扉なので、条件(Review列 + 検収済み + 生きている)はサーバーが持つ。
// 以前はUIのフィルタにだけ依存していて、直接叩けばTodoでもゴミ箱の中でもDoneにできた
app.post("/api/cards/approve", (req, res) => {
  const ids = (req.body?.ids ?? []) as number[];
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids required" });
  const { updated, skipped } = approveChecked(ids);
  if (updated.length > 0) broadcastBoard();
  res.json({
    // 1件でも通らなければ ok:false。押した数と通った数が違うことに気づける (#120/#123と同じ形)
    ok: skipped.length === 0,
    updated,
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(skipped.length > 0
      ? { note: `${ids.length}件のうち${updated.length}件をDoneへ確定しました。残りは条件を満たしていません (Review列にあり、検収チェックが付いているものだけが通ります)` }
      : {}),
  });
});

// アーカイブ済み含む単一カード取得 (#59: 「畳んだ完了」の箱の行や #xx リンクから詳細を開く用)
app.get("/api/cards/:id", (req, res) => {
  const card = getCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: "not found" });
  res.json(card);
});

app.patch("/api/cards/:id", (req, res) => {
  const ng = badStatus(req.body?.status) ?? badDue(req.body?.due);
  if (ng) return res.status(400).json({ error: ng });
  const body = req.body ?? {};
  // #153: 解除の "" は null に均してから渡す (空文字を保存しない)
  const card = updateCard(Number(req.params.id), "due" in body ? { ...body, due: normalizeDue(body.due) } : body);
  if (!card) return res.status(404).json({ error: "not found" });
  broadcastBoard();
  res.json({
    ...card,
    ...(req.body?.status === "done" && card.status !== "done" ? { note: DONE_GATE_NOTE } : {}),
  });
});

// #102: 削除はゴミ箱行き (論理削除)。自然言語UIでは解釈ミスが必ず起きるので、
// 「間違えないようにする」のではなく「間違えても取り返しがつく」形にする
app.delete("/api/cards/:id", (req, res) => {
  const id = Number(req.params.id);
  // アーカイブ済み (Doneへ確定して畳まれたもの) は消せない。
  // 「見つからない」と返すと、実在するのに存在しないことになって混乱する。
  //
  // #233: この文面は「要約カードに畳まれた」「要約から辿れなくなる」と、
  // #200 で撤去した仕組みを現在形で案内していた。**人が読むエラーなので、
  // 撤去した機能を指したままだと辿れない場所を教えることになる。**
  // frontend の番人 (e2e/staleUiCopy.spec.ts) は frontend/src しか見ないので、ここは届かない
  const cur = getCard(id);
  if (cur && !cur.trashedAt && isArchived(id))
    return res.status(409).json({
      error: "Doneへ確定して畳まれたカードは削除できません (Done列の「📦 畳んだ完了」から辿れます)",
    });
  const ok = trashCard(id);
  if (!ok) return res.status(404).json({ error: "not found" });
  broadcastBoard();
  res.json({ ok: true });
});

app.get("/api/trash", (_req, res) => {
  res.json({ cards: listTrashedCards() });
});

app.post("/api/cards/:id/restore", (req, res) => {
  const id = Number(req.params.id);
  const card = restoreCard(id);
  // #161: restoreCard はゴミ箱に無ければ undefined を返す。**理由で応答を分ける** —
  // 「そんなIDは無い」と「実在するがゴミ箱に無い」を同じ 404 にすると、
  // 実在するカードを不存在と報告することになる (Codexレビュー指摘)
  if (!card) {
    if (!getCard(id)) return res.status(404).json({ error: "not found" });
    return res.status(409).json({ error: "ゴミ箱に無いので戻せません (すでにボード上にあります)" });
  }
  broadcastBoard();
  res.json(card);
});

// 実体の削除。人間のUI操作からのみ通す (チャット・MCPにはこの口を出さない)
app.delete("/api/trash/:id", (req, res) => {
  const id = Number(req.params.id);
  // 生きているカードを名指しされたら、消さずに理由を返す。
  // 「ゴミ箱に無い」と「そもそも存在しない」を区別する — 前者は操作ミス、後者は古い一覧
  const alive = getCard(id);
  if (alive && !alive.trashedAt)
    return res.status(409).json({
      error: "ゴミ箱にないカードは完全削除できません。先に削除 (ゴミ箱へ移動) してください",
    });
  if (!purgeCard(id)) return res.status(404).json({ error: "not found" });
  // 消えたことを開いている画面へ伝える。以前は通知しておらず、DBから消えた後も
  // 次の更新までカードが残り、触って初めて404になった
  broadcastBoard();
  res.json({ ok: true });
});

let chatSeq = 0;


/** チャット1往復。**メインとカード専用で入口は2つだが、中身は1つ。**
 *
 * 以前は2つのルートにまるごと同じ処理が並んでいた (検証・呼び出し・進捗・保存・
 * 変化通知・ログ・エラー応答)。差分は `cardId` の有無だけなのに、
 * **「入口ごとにズレると事故る」と書いた #213 の注意書き自体が逐語で2箇所にあった** (#242)。
 * 実際ズレていて、**カード側にはクライアント切断のログが無かった。**
 *
 * `cardId` が付くと、ログの印・進捗の宛先・会話の保存先が変わる。それだけ。
 * **対象が居るかの確認はルート側に残す** — メイン側には確認する対象が無いため */
async function handleChat(req: Request, res: Response, cardId?: number) {
  const { message, history, attachments, view } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "message required" });
  // #213: **入口ごとにズレると事故る。**画面の「+」を隠しても curl では通るので、ここで断る。
  // 黙って捨てない — 送ったのに読まれていない、が一番たちが悪い (#123 と同じ線)
  if (attachments?.length && !canAcceptAttachments())
    return res.status(400).json({ error: attachmentRefusal() });
  const id = ++chatSeq;
  const t0 = Date.now();
  const where = cardId != null ? ` CARD-CHAT(card=${cardId})` : "";
  log(
    "chat",
    `#${id}${where} REQ "${String(message).slice(0, 120)}" (history=${history?.length ?? 0}${attachments?.length ? ` attachments=${attachments.length}` : ""})`
  );
  // クライアント切断もログに残す (再起動巻き添え・ブラウザ側中断の追跡用)
  res.on("close", () => {
    if (!res.writableEnded) log("chat", `#${id}${where} CLIENT DISCONNECTED after ${Date.now() - t0}ms`);
  });
  // #212: 断られた/直った の**変化があったときだけ**板に流す。
  // 直った側を流さないと、成功しても板が変わらない応答 (ツールを呼ばない会話) では
  // バナーが出たまま残る — 「通れば false が飛んでくる」が嘘になる
  const wasRefused = upstreamRefused();
  try {
    const result = await runChatTurn(
      message,
      history ?? [],
      (kind) => notifyView(kind),
      // 応答完了前の逐次フィードバック。カード専用チャットはそのカードの面だけに出す
      (label) => io.to(room(currentProjectId())).emit("chat:progress", { label, ...(cardId != null ? { cardId } : {}) }),
      cardId,
      attachments,
      view
    );
    // 会話ログはサーバーに永続化する (添付は原本を保存せず名前だけ記録 #68)
    saveChatMessage(
      "user",
      message + (attachments?.length ? ` [添付: ${attachments.map((a: any) => a.name).join(", ")}]` : ""),
      undefined,
      undefined,
      cardId
    );
    saveChatMessage("assistant", result.reply, result.trace, result.usage, cardId);
    log(
      "chat",
      `#${id}${where} OK ${Date.now() - t0}ms rounds=${result.usage.rounds} tools=[${result.trace.map((t) => t.tool).join(",")}] reply=${result.reply.length}ch`
    );
    if (wasRefused !== upstreamRefused()) broadcastBoard();
    res.json(result);
  } catch (e: any) {
    log("chat", `#${id}${where} FAILED ${Date.now() - t0}ms: ${e?.message ?? e}`);
    // #212: 上流に断られたことを板にも流す。**失敗そのものは板を変えない**ので、
    // ここで流さないと画面は次のリロードまで気づけない (E2Eで実際に踏んだ)
    if (wasRefused !== upstreamRefused()) broadcastBoard();
    res.status(500).json({ error: e?.message ?? "chat failed" });
  }
}

app.post("/api/chat", async (req, res) => {
  await handleChat(req, res);
});

app.get("/api/chat/log", (req, res) => {
  const cardId = req.query.cardId != null ? Number(req.query.cardId) : undefined;
  res.json({ messages: listChatMessages(Number(req.query.limit ?? 50), cardId) });
});

// カード専用チャット (#24): 対象カードの全詳細をシステムプロンプトに注入し、会話はcard_id付きで分離保存
app.post("/api/cards/:id/chat", async (req, res) => {
  const cardId = Number(req.params.id);
  // 対象が居ないなら、LLMを呼ぶ前に断る。以前は存在確認が無く、cardFocus が undefined のまま
  // 通常チャットに近い状態で有料の呼び出しが走り、存在しないIDの会話ログまで残っていた
  // (chat_messages.card_id に外部キーは無い。自動レビュー指摘)。
  // 削除・プロジェクト切替・古い画面から送ると踏むので、普通に起きる
  if (!getCard(cardId)) return res.status(404).json({ error: `カード #${req.params.id} は見つかりません` });
  await handleChat(req, res, cardId);
});

// #181: 計測系と監査ログのAPIを撤去した。ここにあったもの:
//  - POST /api/metrics — 📊コストタブ (請求サマリー + トークン集計 + 概算額)
//  - GET  /api/audit — 📜監査タブ (会話とLLM呼び出しの時系列)
//  - GET  /api/audit/export — 全ログExport (#83)
//  - POST /api/models — 単価つきモデルカタログ (182件)
//  - GET/POST /api/settings/models — 用途別モデルの実行時切り替え (#88)
// デバッグは backend/logs/ で足りる。モデルの供給元は backend/config.json (#182、config.ts)

// AI提案チップ (#75): ボードの文脈から「いま価値のある操作」を最大3つ。失敗時は空配列 (固定チップが保険)
// #180: **POST にしてあるのは副作用があるから。**ここは有料のLLM呼び出しを起こす。
// GET のままだと、悪意あるページが `<img src>` で撃つだけで課金を増やせる
// (Origin が付かないので Origin 判定では止まらない。自動レビュー指摘)。
// 「読み取りに見えるがお金が動く」ものは GET に置かない
app.post("/api/suggestions", async (_req, res) => {
  try {
    res.json({ suggestions: await generateSuggestions() });
  } catch (e: any) {
    log("chat", `suggestions failed: ${e?.message ?? e}`);
    res.json({ suggestions: [] });
  }
});

/** メンバー名の配列として受け取れる形か。書き込みを始める前に確かめる。
 *
 * 配列かどうかしか見ていなかったので、数値やnullが1つ混ざるとDB層の .trim() で例外になり、
 * **途中まで書けた状態で500** になっていた (自動レビュー指摘)。
 * 新規作成は管理DBの行とプロジェクトDBファイルを作った後に落ちるので、一覧に
 * 作りかけが残る。更新は名前を変えた後に落ちるので、500なのに名前だけ変わる。
 *
 * 「途中まで適用して失敗」は一番たちが悪い — 呼んだ側は失敗として扱うのに、
 * 実際には一部が残る。#120 で「版が合わない更新は同じ行の他のフィールドも保存しない」と
 * したのと同じ考え方を、入口の検証でも通す */
// プロジェクト (#86): SQLiteファイルごと分かれている。切り替えるとボード・チャット・
// 前提情報がまとめて入れ替わる (アクティブはサーバー側に1つ)
app.get("/api/projects", (_req, res) => {
  res.json({ projects: projectSummaries() });
});

app.post("/api/projects", (req, res) => {
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name required" });
  const p = createProject(String(name).trim());
  // 作成だけ配信していなかったので、ヘッダーの選択肢に出るのが再読み込み後だった。
  // 画面は「ヘッダーのプロジェクト選択から移動」と案内しているのに辿れない (自動レビュー指摘)
  io.emit("project:changed", { projects: projectSummaries() });
  res.json({ ok: true, project: p });
});

app.post("/api/projects/:id/activate", (req, res) => {
  try {
    setActiveProjectId(Number(req.params.id));
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? "activate failed" });
  }
  resetPromptState(); // ボードが総取っ替えになるのでプロンプトの基準スナップショットを作り直す
  rejoinFollowers(activeProjectId()); // 追従組を新しいプロジェクトのroomへ移してから配信する
  io.emit("project:changed", { projects: projectSummaries() });
  broadcastBoard();
  res.json({ ok: true, projects: projectSummaries() });
});

app.patch("/api/projects/:id", (req, res) => {
  const id = Number(req.params.id);
  // 存在確認をしないと、更新自体は0件で静かに通ったあと broadcastBoard(id) が投げて500になる。
  // 設定を古いタブで開いたまま別タブで削除する、という普通の競合で踏む (自動レビュー指摘)
  if (!getProject(id)) return res.status(404).json({ error: `project #${req.params.id} not found` });
  const { name, archived, custom1Label, custom2Label } = req.body ?? {};
  // 何も書き始める前にまとめて確かめる (途中まで適用して500、を作らない)。
  // 既定プロジェクトの無効化はDB層が投げるので、ここで先に同じ判定を通す —
  // 名前を変えた後に投げると「500なのに名前だけ変わる」になる
  if (archived === true && id === activeProjectId())
    return res.status(409).json({
      error:
        "既定のプロジェクトは無効にできません。ヘッダ指定のない操作の行き先として使われるため、一覧から消すと辿れなくなります",
    });
  if (typeof name === "string" && name.trim()) renameProject(id, name.trim());
  if (typeof archived === "boolean") setProjectArchived(id, archived);
  // #19: 任意レーンの表示名。**名前を消す = レーンを畳む**なので、先に中身を todo へ戻す。
  // 順序が逆だと、ボードが列を描かなくなった後にカードが取り残される (evacuateLane の注記)
  for (const [key, value] of [
    ["custom1", custom1Label],
    ["custom2", custom2Label],
  ] as const) {
    if (typeof value !== "string") continue;
    const folding = !value.trim();
    if (folding) {
      const moved = withProject(id, () => evacuateLane(key));
      if (moved > 0) log("api", `#${id} の ${key} を畳んだので ${moved}件を todo へ戻しました`);
    }
    setCustomLabel(id, key, value);
    resetPromptState(); // 索引の説明文が変わるのでプロンプトの基準を作り直す
  }
  // #167 → #199: 提案チップのON/OFF はここで受けていた。システム全体で1つの設定になったので
  // PATCH /api/settings へ移し、#209 でその設定ごと撤去した
  io.emit("project:changed", { projects: projectSummaries() });
  broadcastBoard(id);
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

// #180: ログイン設定 (/api/settings/auth) は認証ごと廃止した。個人利用に特化したので、
// 「誰を通すか」を決める窓口そのものを持たない。守るのは待ち受けアドレス (127.0.0.1固定) と、
// 他所のページからの要求を断ること (Origin / Sec-Fetch-Site の明示拒否) の2つ。
// **cors() は境界ではない** — ヘッダを付けないだけでリクエストは通る (origin.ts の注記)
//
// #181: モデル設定 (/api/settings/models) と候補一覧 (/api/models) も撤去した。
// 実行時切り替え (#88) は「182件のカタログから選ぶUI」が前提で、カタログごと消えたため
// 供給元を失う。**画面から変えられない値をDBに残すと「消したのに効き続ける」**ので、
// settings の model.* 行も起動時に削除している (store.ts)。
// #182: 供給元は backend/config.json (config.ts)。env から設定ファイルへ移した —
// 宛先・キー・APIの形式・モデル3つは常にセットで動くので、1枚にまとめて
// examples/ から丸ごとコピーさせれば、間違った組み合わせが作れなくなる

// #199 → #209: アプリ全体の設定 (/api/settings) はエンドポイントごと撤去した。
// 中身は提案チップのON/OFF 1つだけで、その設定が解いていた問題 (呼びすぎ・課金) は
// **#208 (1回あたりを半分に) と #209 (キャッシュをプロジェクト別に・起動猶予) で別の形で解けた**。
// 残すと空の設定画面と、タブ間で同期する状態が1つ残る。
//
// **UIだけ消して設定を残す選択は無い。**値はDBに残るので「画面から変えられない値が
// 実効値として優先され続ける」(#181と同じ事故) になる — 実際この撤去の直前、値は OFF だった。
// 起動時に settings の行も消している (store.ts)

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
  try {
    // #110: サーバーの組み立て自体をプロジェクトスコープ内で行う。
    // ツール定義がプロジェクトの状態(メンバーの有無)で変わるようになったため、
    // 構築時点でも対象プロジェクトのDBを見ている必要がある
    await withProject(projectId, async () => {
      // 書き込みはこの接続のプロジェクトに対して行う。UIへの通知は表示中のときだけ
      // #99: 接続先プロジェクトのroomへ送るだけでよい (購読していないクライアントには届かない)
      // #247: **SDKのZodで弾かれた呼び出しはハンドラまで来ない**ので、そのままだと
      // 記録に一切残らない。**使い方を間違え続けているツールが「呼ばれていない」に見える**のが
      // 一番まずい (この記録の目的が「呼ばれている/いない」の可視化なので、結論が逆になる)。
      // 受けた tools/call と、ハンドラが動いたかを突き合わせて、届かなかったぶんだけここで残す
      // **JSON-RPCは配列 (バッチ) でも来る**ので、id ごとに突き合わせる (Codexレビュー P2)。
      // 真偽値1つだと、バッチの1件目が届いた時点で残りの拒否を見逃す
      const pending = new Map(toolCalls(req.body).map((c) => [JSON.stringify(c.id), c]));
      const mcpServer = buildMcpServer(
        (kind) => notifyView(kind, projectId),
        (requestId) => pending.delete(JSON.stringify(requestId))
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      for (const c of pending.values()) {
        // 引数はキー名だけ (値は許可した項目のみ)。**どのキーが足りなかったのかは、キーの顔ぶれで分かる**
        // #252: ここでも値の扱いをハンドラ側と揃える。**行を作る場所が2つある**ので、
        // 片方だけ直すと「スキーマで弾かれたSQL」だけが測定から漏れる (一番見たい失敗例)
        // スキーマで弾かれた = ハンドラまで届いていない。**これも失敗**なので goal を残す
    const detail = argDetail(c.name, c.args, true);
        log(
          "mcp",
          `${c.name} NG スキーマで拒否 (ハンドラまで届かず) | ${argShape(c.args)} |` + (detail ? ` | ${detail}` : "")
        );
      }
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

// **待ち受けはループバックに限定する。**#180 で認証を廃止したあとの防壁は2つで、これはその1枚目
// (もう1枚は上の Origin / Sec-Fetch-Site の拒否 — こちらは「利用者自身が開いたページ」を止める)。
// ホストを省略するとNodeの既定で全インターフェース (0.0.0.0) に開き、
// 同じLANにいる誰でも板を読み書きできてしまう。ここが開くと、残る1枚はブラウザ由来の要求しか見ないので、
// **他の端末からの curl は素通りになる**。
// 環境変数で開ける逃げ道は用意しない (「開けられる」が残ると、いつか開ける日が来る)。
// 外から使いたくなったら、認証を戻すのではなく SSH ポートフォワードやトンネルを使う
server.listen(PORT, "127.0.0.1", () => {
  console.log(`ChatBan backend listening on http://localhost:${PORT}`);
});
