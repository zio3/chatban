import assert from "node:assert/strict";
import test from "node:test";

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
