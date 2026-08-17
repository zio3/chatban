/** 記事用スクショの撮影サーバー。**ブラウザを出したまま置いておき、頼まれたら撮る。**
 *
 * 撮影の状況 (チャットの中身・カードの位置・どのタブか) は人が手で作る。
 * Playwrightを使うのは自動操作のためではなく、**全カットで解像度とウィンドウ幅を
 * 確実に揃えるため**。手でウィンドウを合わせると1枚ごとに数pxずれて、記事に並べたときに
 * 幅が揃わない。
 *
 * 使い方:
 *   cd frontend && node scripts/shot-server.mjs [URL]
 *     → ブラウザが1枚開く。あとは普通に触って、撮りたい状態を作る
 *   別のターミナル (またはClaude) から:
 *     curl "http://localhost:9800/shot?name=S01"          … 見えている範囲
 *     curl "http://localhost:9800/shot?name=S02a&full=1"  … ページ全体 (縦に長いもの)
 *     curl "http://localhost:9800/shot?name=S04&sel=.foo" … 特定の要素だけ
 *   保存先は ~/Downloads/<name>.png (同名は上書き = 撮り直しやすさを優先)
 *
 * ウィンドウの大きさを変えたいとき: SHOT_W / SHOT_H を指定して起動し直す
 *   SHOT_W=1700 SHOT_H=1214 node scripts/shot-server.mjs
 */
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const TARGET = process.argv[2] ?? "http://localhost:5173";
// 既定は既存カット (S02a) と同じ 1700×1214。撮り直さずに混ぜられるように合わせてある
const W = Number(process.env.SHOT_W ?? 1700);
const H = Number(process.env.SHOT_H ?? 1214);
const PORT = Number(process.env.SHOT_PORT ?? 9800);
/** 画素密度。2 なら 1700x1214 のウィンドウが 3400x2428 の画像で出る。
 * **これだけは起動時にしか決められない** (Playwrightのcontext生成時オプションで、あとから変えられない)。
 * ウィンドウの見た目の大きさは変わらず、解像度だけ上がる */
const SCALE = Number(process.env.SHOT_SCALE ?? 2);
const OUT = path.join(os.homedir(), "Downloads");
// ログイン状態を残す (公開環境を撮るとき、起動のたびにログインし直さなくて済む)
const PROFILE = path.join(os.tmpdir(), "chatban-shot-profile");

fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: W, height: H },
  deviceScaleFactor: SCALE,
  // ウィンドウの外枠ぶんを足しておかないと、viewport が指定値より小さくなる
  args: [`--window-size=${W + 16},${H + 130}`],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(TARGET);

/** いま撮る対象 = **人がいま見ているタブ**。
 * 「最後に開いたタブ」だと、ChatBanとNotionを行き来しているときに狙いと違うほうが撮れる。
 * document.visibilityState で実際に表に出ているものを選ぶ */
async function current() {
  const pages = ctx.pages();
  for (const p of pages) {
    try {
      if (await p.evaluate(() => document.visibilityState === "visible")) return p;
    } catch {
      // 遷移中などで evaluate できないページは飛ばす
    }
  }
  return pages.at(-1) ?? page;
}

const ok = (res, line) => {
  console.log(line);
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(line + "\n");
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // 拡大率。1枚に収まらない/文字が小さいときに、撮り直しの前に手早く試せるようにしておく。
    // 起動し直さずに変えられる (再起動するとブラウザが閉じて、作った状態が消える)
    if (url.pathname === "/zoom") {
      const level = Number(url.searchParams.get("level") ?? 1);
      if (!(level > 0.1 && level <= 3)) {
        res.writeHead(400).end("level は 0.1〜3\n");
        return;
      }
      const p = await current();
      await p.evaluate((z) => (document.documentElement.style.zoom = String(z)), level);
      ok(res, `拡大率: ${level}`);
      return;
    }

    // ウィンドウ(viewport)の大きさ。縦をもう少し欲しい、のような調整用
    if (url.pathname === "/size") {
      const w = Number(url.searchParams.get("w") ?? W);
      const h = Number(url.searchParams.get("h") ?? H);
      if (!(w > 320 && w <= 4000 && h > 240 && h <= 4000)) {
        res.writeHead(400).end("w/h の指定が範囲外\n");
        return;
      }
      const p = await current();
      await p.setViewportSize({ width: w, height: h });
      ok(res, `ウィンドウ: ${w}x${h}`);
      return;
    }

    // スプリッター(チャットとボードの境目)の位置。手でドラッグすると1枚ごとに数pxずれるので、
    // 比率で決められるようにする。ChatBan側は localStorage の chatban.logHeight を初期値に読む
    // (Chat.tsx)。**反映にリロードが要るので、チャットに会話を入れる前に決めること** —
    // メインチャットはリロードで新規になる (#72)
    if (url.pathname === "/splitter") {
      const ratio = Number(url.searchParams.get("ratio") ?? 0.5);
      if (!(ratio > 0.1 && ratio < 0.9)) {
        res.writeHead(400).end("ratio は 0.1〜0.9 (画面に占めるチャットの割合)\n");
        return;
      }
      const p = await current();
      const h = await p.evaluate((r) => {
        // チャット全体 = スプリッター(24) + ログ欄 + 入力欄まわり(約80)。ログ欄だけがこの値
        const target = Math.round(window.innerHeight * r) - 104;
        const v = Math.min(Math.max(target, 120), Math.round(window.innerHeight * 0.75));
        localStorage.setItem("chatban.logHeight", String(v));
        return v;
      }, ratio);
      await p.reload();
      await p.waitForTimeout(1200);
      ok(res, `スプリッター: チャット ${Math.round(ratio * 100)}% (logHeight=${h}) ※リロードしたので会話は消えています`);
      return;
    }

    if (url.pathname !== "/shot") {
      res.writeHead(404).end("/shot?name=xxx[&full=1][&sel=CSS] / /zoom?level=0.8 / /size?w=1700&h=1214\n");
      return;
    }
    const name = url.searchParams.get("name");
    if (!name || !/^[\w.-]+$/.test(name)) {
      res.writeHead(400).end("name は英数字・ハイフン・アンダースコアのみ\n");
      return;
    }
    const file = path.join(OUT, `${name}.png`);
    try {
      const p = await current();
      const sel = url.searchParams.get("sel");
      const target = sel ? p.locator(sel).first() : p;
      await target.screenshot({ path: file, fullPage: sel ? undefined : url.searchParams.get("full") === "1" });
      const { width, height } = p.viewportSize() ?? { width: W, height: H };
      const kb = Math.round(fs.statSync(file).size / 1024);
      // 実寸は viewport × scale。記事に貼るときに縮小率を決める材料になるので出しておく
      const size = sel
        ? `要素 ${sel}`
        : url.searchParams.get("full") === "1"
          ? "ページ全体"
          : `${width}x${height} @${SCALE}x = ${width * SCALE}x${height * SCALE}px`;
      ok(res, `撮影: ${file} (${kb}KB) ${size}`);
    } catch (e) {
      const msg = `撮影に失敗: ${e?.message ?? e}`;
      console.error(msg);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(msg + "\n");
    }
  })
  .listen(PORT, () => {
    console.log(`撮影サーバー: http://localhost:${PORT}/shot?name=xxx`);
    console.log(`  ブラウザ: ${TARGET}  /  ${W}x${H} @${SCALE}x (画像 ${W * SCALE}x${H * SCALE}px)  /  保存先 ${OUT}`);
  });

// ブラウザを閉じたら終わる (人が閉じる = 撮影終了)
ctx.on("close", () => process.exit(0));
