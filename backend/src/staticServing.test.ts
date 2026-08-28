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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-static-"));
const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-staticdist-"));
fs.writeFileSync(path.join(staticDir, "index.html"), "<html><body id=\"static-probe\">ok</body></html>");
fs.writeFileSync(path.join(staticDir, "asset.txt"), "asset-body");
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.CHATBAN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-staticlog-"));
process.env.CHATBAN_STATIC_DIR = staticDir;
process.env.AUTO_ARCHIVE = "0";
process.env.PORT = "0"; // 空きポートに開く (開発サーバーの 8787 を奪わない)

const { server } = await import("./index.js");

let base = "";

after(() => {
  server.close();
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
