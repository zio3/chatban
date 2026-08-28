import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #268: **本番はこのプロセス1本でフロントも配る**の番人。
 *
 * miniPC (systemd + tailscale serve) では Vite dev server を飼わず、
 * `vite build` の成果物を backend が静的配信する。ここが黙って壊れると、
 * **miniPC に移した日に画面が出ない**という形で初めて分かる (開発機は 5173 を
 * 使い続けるので、開発中は誰も踏まない経路)。だからHTTPの実挙動で見張る。
 *
 * dist の実物には依存しない (ビルドしていない環境でも走るように、
 * 一時ディレクトリに index.html を置いて CHATBAN_STATIC_DIR で指す)。 */

// data/log は testEnv.ts (--import) が置いた一時パスをそのまま使う (掃除もそちらの仕組みに乗る)。
// 自前で持つのは staticDir だけなので、これだけ after で消す (Codexレビュー P2:
// 自前の mkdtemp は testEnv の掃除対象プレフィックスでないため、毎回永久に残っていた)
const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-test-staticdist-"));
fs.writeFileSync(path.join(staticDir, "index.html"), "<html><body id=\"static-probe\">ok</body></html>");
fs.writeFileSync(path.join(staticDir, "asset.txt"), "asset-body");
process.env.CHATBAN_STATIC_DIR = staticDir;
process.env.AUTO_ARCHIVE = "0";
process.env.PORT = "0"; // 空きポートに開く (開発サーバーの 8787 を奪わない)

const { server } = await import("./index.js");

let base = "";

after(() => {
  server.close();
  fs.rmSync(staticDir, { recursive: true, force: true });
});

before(async () => {
  if (!server.listening) await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object", "ポートが取れない");
  base = `http://127.0.0.1:${addr.port}`;
});

test("dist があれば / で index.html が返る (#268)", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /static-probe/);
});

test("SPAの経路 (/p/<id>) も index.html にフォールバックする (#268)", async () => {
  // URLが持つ状態は /p/<id> (#97)。直接開いたときに404だと、
  // ブックマークやプロジェクト切替 (location.href) が本番だけ壊れる
  const res = await fetch(`${base}/p/1`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /static-probe/);
});

test("静的ファイルはそのまま返る (#268)", async () => {
  const res = await fetch(`${base}/asset.txt`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "asset-body");
});

test("API はフォールバックに食われない (#268)", async () => {
  const res = await fetch(`${base}/api/projects`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { projects: unknown[] };
  assert.ok(Array.isArray(body.projects), "APIがJSONを返していない (index.html に化けている)");
});

test("MCP もフォールバックに食われない (#268)", async () => {
  // GET /mcp は 405 (POST only) が正しい。200 で index.html が返ったら食われている
  const res = await fetch(`${base}/mcp/1`);
  assert.equal(res.status, 405);
});

test("他所のリンクから開いても画面は出る (#268 Codexレビュー P2)", async () => {
  // 別サイトのリンクを踏んだ通常の遷移は `Sec-Fetch-Site: cross-site` で来る。
  // Origin/Sec-Fetch-Site の拒否を全 path に掛けると、公開URLをよそから開けない
  const res = await fetch(`${base}/`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /static-probe/);
});

test("画面を通しても API/書き込みの砦は残る (#268 Codexレビュー P2)", async () => {
  // 静的 GET を通す例外が守りの本体 (悪意あるページからの API 叩き #180) を崩していないこと
  const api = await fetch(`${base}/api/projects`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(api.status, 403);
  // 静的な path でも GET/HEAD 以外は断る (例外は「読み取りのみ」に限る)
  const post = await fetch(`${base}/`, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(post.status, 403);
});
