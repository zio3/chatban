import { execFileSync } from "node:child_process";
import type { Plugin } from "vite";

/**
 * ビルドのたびに `dist/version.txt` を作る (#214)。
 *
 * これは「いま公開されているのがどのコミットか」を外から見るための唯一の窓口で、
 * 公開デモの README からも案内している (#183)。
 *
 * **手で dist に置くと、次のビルドで消える。**#213 をデモへ反映したとき実際に消えていて、
 * 気づかなければ 404 が返るだけ ＝ 「何が動いているか分からない」状態に黙って戻る。
 * だから**ビルドの副産物にする** — ビルドが消してビルドが作るなら、順番を守る人が要らない。
 *
 * gitが無い場所 (tarball を展開しただけ等) でも**ビルドは止めない**。
 * バージョン表示のために配布を失敗させる価値は無いので、`unknown` を書いて進む。
 */
export function versionFile(): Plugin {
  return {
    name: "chatban-version-file",
    apply: "build",
    generateBundle() {
      const source = [`commit: ${gitDescribe()}`, `built:  ${new Date().toISOString()}`, ""].join("\n");
      // emitFile で出す = dist の掃除より後に置かれるので、書いた先が消えることがない
      this.emitFile({ type: "asset", fileName: "version.txt", source });
    },
  };
}

function gitDescribe(): string {
  try {
    const sha = run(["rev-parse", "HEAD"]);
    // 未コミットの変更を持ったままデプロイしたことが後から分かるように印を付ける
    return run(["status", "--porcelain"]) ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

function run(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
