import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { getSetting, setSetting } from "./db.js";
import { log } from "./log.js";

// #113: Googleログイン。「本番で通用する」ことを示すのが目的なので、
// 見た目だけの認証にはしない — IDトークンはGoogleの公開鍵で検証し、
// セッションはHttpOnlyの署名Cookieで持つ。
//
// 通す相手は設定DB (auth.allowedEmails) で決める。env にしないのは、
// ⚙設定タブから再起動なしで変えられるようにするため (#88と同じ経路)。
// ただし空のままだと誰もログインできず、設定タブ自体が認証の内側にあるので詰む。
// そこで「リストが空なら最初にログインした人を登録する」= オーナー確定にする。
//
// MCP (/mcp/:projectId) は保護しない (zio判断)。ローカルのエージェント用の口で、
// ここを塞ぐとClaude Codeから繋がらなくなる。外部公開するなら別のトークンを足す段階。

const COOKIE = "chatban_session";
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** 認証を無効にする (E2E・開発サーバー)。既定はoff = 素通し。
 * 「設定し忘れたら開放される」ではなく「設定して初めて閉じる」向きだが、
 * 閉じているかは画面上部と /api/auth/me で常に見えるようにする */
export const authEnabled = () => process.env.CHATBAN_AUTH === "on";

function secret(): string {
  let s = getSetting("auth.sessionSecret");
  if (!s) {
    s = randomBytes(32).toString("hex");
    setSetting("auth.sessionSecret", s);
  }
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function issue(email: string, name: string, picture: string): string {
  const body = Buffer.from(JSON.stringify({ email, name, picture, exp: Date.now() + MAX_AGE_MS })).toString(
    "base64url"
  );
  return `${body}.${sign(body)}`;
}

export interface SessionUser {
  email: string;
  name: string;
  picture: string;
}

function verify(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = sign(body);
  // 長さが違うと timingSafeEqual が投げるので先に弾く
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return { email: p.email, name: p.name, picture: p.picture };
  } catch {
    return null;
  }
}

function allowedEmails(): string[] {
  return (getSetting("auth.allowedEmails") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** リストに載っているか。空 = まだ誰も登録されていない初期状態なので通す
 * (ここで閉じると、設定タブ自体が認証の内側にあるので詰む)。
 * ログイン時とリクエストごとの再確認で同じ判定を使う */
export function isAllowed(email: string, list: string[]): boolean {
  return list.length === 0 || list.includes(email.toLowerCase());
}

/** 通してよい相手か。リストが空なら最初の1人を登録する (詰み回避) */
function admit(email: string): boolean {
  const list = allowedEmails();
  if (list.length === 0) {
    setSetting("auth.allowedEmails", email.toLowerCase());
    log("auth", `許可リストが空だったので ${email} をオーナーとして登録しました`);
  }
  return isAllowed(email, list);
}

/** Googleが発行したIDトークンを検証してセッションを張る */
export async function loginWithGoogle(idToken: string): Promise<{ user: SessionUser; cookie: string } | { error: string }> {
  const clientId = getSetting("auth.googleClientId") ?? process.env.GOOGLE_CLIENT_ID ?? "";
  if (!clientId) return { error: "GoogleクライアントIDが設定されていません (設定タブ or GOOGLE_CLIENT_ID)" };
  try {
    const ticket = await new OAuth2Client(clientId).verifyIdToken({ idToken, audience: clientId });
    const p = ticket.getPayload();
    if (!p?.email || !p.email_verified) return { error: "メールアドレスを確認できませんでした" };
    if (!admit(p.email)) {
      log("auth", `許可されていないアカウントを拒否: ${p.email}`);
      return { error: "このアプリを使う権限がありません" };
    }
    const user: SessionUser = { email: p.email, name: p.name ?? p.email, picture: p.picture ?? "" };
    log("auth", `login: ${user.email}`);
    return { user, cookie: issue(user.email, user.name, user.picture) };
  } catch (e: any) {
    log("auth", `IDトークンの検証に失敗: ${e?.message ?? e}`);
    return { error: "ログインを確認できませんでした" };
  }
}

export const cookieName = COOKIE;
export const cookieMaxAge = MAX_AGE_MS;

/** #113: セッションが生きていることと、いま通してよい相手であることは別。
 * Cookieは最大30日有効なので、許可リストから外した相手が最長1か月そのまま入れてしまう
 * (自動レビュー指摘)。署名の検証だけで済ませず、毎回いまのリストと突き合わせる。
 *
 * 判定を requireAuth ではなく currentUser 側に置くのは、requireAuth を通らない口
 * (/api/auth/me、Socket.IOのハンドシェイク) が取り残されるため。
 * 入口ごとに書き分けると必ずズレる (#92 #108 #114 #125 #126 と同じ形) */
function stillAllowed(user: SessionUser | null): SessionUser | null {
  if (!user) return null;
  if (isAllowed(user.email, allowedEmails())) return user;
  log("auth", `許可リストから外れたセッションを無効化: ${user.email}`);
  return null;
}

export function currentUser(req: Request): SessionUser | null {
  return stillAllowed(verify((req as any).cookies?.[COOKIE]));
}

/** Socket.IOのハンドシェイク用。cookie-parser を通らないので生のCookieヘッダから取る */
export function userFromCookieHeader(header: string | undefined): SessionUser | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== COOKIE) continue;
    return stillAllowed(verify(decodeURIComponent(part.slice(i + 1).trim())));
  }
  return null;
}

/** #126: 誰の発言かはシステムが決める。ログイン済みならセッションの本人、
 * していなければクライアントの自己申告 (email は付かない = 検証されていない印)。
 * 本文中の「佐藤です」は発言者にしない。
 *
 * メインチャットとタスクチャットで同じものを使う。以前はメインだけに実装があり、
 * タスクチャットはリクエストの speaker を素通しして保存もしていなかったので、
 * ログイン中でも任意の名前を名乗れて、監査ログから実際の指示者を追えなかった。
 * 入口ごとに書き分けると必ずズレる (#92 #108 #114 #125 と同じ形) なので、
 * 判断の本体は pickSpeaker に置いて req から切り離す */
export function pickSpeaker(me: SessionUser | null, selfReported: unknown) {
  return {
    name: me?.name ?? (typeof selfReported === "string" && selfReported.trim() !== "" ? selfReported : null),
    email: me?.email ?? null,
  };
}

export function resolveSpeaker(req: Request, selfReported: unknown) {
  return pickSpeaker(currentUser(req), selfReported);
}

/** ループバックからの呼び出しか (初期設定の足場)。プロキシ越しは信用しない */
function isLocal(req: Request): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
}

/** #113: ログイン設定そのものを触れる相手。
 *
 * 他のAPIと違い、ここは「いまのデータ」ではなく「これから誰を通すか」を決める。
 * 認証offのあいだ誰でも allowedEmails を書けると、自分のメールを仕込んでおいて
 * onにした瞬間に入れる — 認証を先回りして乗っ取れてしまう (自動レビュー指摘)。
 *
 * オーナーが決まっていれば本人だけ、まだ誰も居なければローカルからだけ。
 * 認証のon/offに関わらず同じ判定にする (offだから緩い、にしない) */
export function canEditAuthSettings(req: Request): boolean {
  const list = allowedEmails();
  if (list.length === 0) return isLocal(req);
  const me = currentUser(req);
  return !!me && list.includes(me.email.toLowerCase());
}

/** 保護。認証offなら素通し。MCPはこのミドルウェアの外に置く */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled()) return next();
  if (currentUser(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}
