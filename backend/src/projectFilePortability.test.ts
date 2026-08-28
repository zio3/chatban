import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/** #270: **Windows で作った板を Linux へ持ち込むと実DBを見失う**の番人。
 *
 * `projects.file` を `join("projects", ...)` で作っていたため、Windows では
 * `projects\1-chatban.db` と保存され、Linux ではバックスラッシュ含みの1ファイル名と
 * 解釈される。実DBを見つけられず**同名の空DBを黙って作り直す** — 起動は成功し
 * プロジェクト名も並ぶので、openCards=0 に気づくまで移行できたように見える
 * (miniPC 移行 2026-08-28 で server-ops が実際に踏んだ)。
 *
 * Linux の挙動 (バックスラッシュはただの文字) は Windows の実ファイルシステムでは
 * 再現できないので、書き込み側は保存された文字列そのもの、読み込み側は分解の
 * 純粋関数 (projectFileParts) を見る。 */

const { createProject, getProject, projectFileParts } = await import("./store.js");

test("新規プロジェクトの file 列は OS によらず / 区切りで保存される (#270)", () => {
  const p = createProject("portability-check");
  const row = getProject(p.id)!;
  assert.ok(!row.file.includes("\\"), `file 列にバックスラッシュが入っている: ${row.file}`);
  assert.match(row.file, /^projects\/\d+-.+\.db$/);
});

test("読み込みはどちらの区切りでも同じ部品に分解する (#270)", () => {
  // 既存DBに残る Windows join 由来の行 (移行せずそのまま読めることが要件)
  assert.deepEqual(projectFileParts("projects\\1-chatban.db"), ["projects", "1-chatban.db"]);
  assert.deepEqual(projectFileParts("projects/1-chatban.db"), ["projects", "1-chatban.db"]);
});

test("本番の読込口 (projectFilePath) が正規化を経由している (#270 Codexレビュー P2)", () => {
  // 上の2本だけだと、projectFilePath を `join(DATA_DIR, p.file)` に戻して helper を
  // 置き去りにしても通ってしまう (配線を見張れていない)。挙動では見張れない —
  // Windows ではバックスラッシュも区切りとして機能するので、正規化の有無が
  // ファイルシステム上で区別できない。だからソースを直接見る
  const src = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  const body = src.match(/function projectFilePath[\s\S]*?\n\}/)?.[0];
  assert.ok(body, "store.ts に projectFilePath が見つからない (改名したらこのテストも直す)");
  assert.match(
    body,
    /projectFileParts\(/,
    "projectFilePath が projectFileParts を通っていない。`join(DATA_DIR, p.file)` に戻すと Linux で実DBを見失う (#270)"
  );
});
