// #265: **テストが実データの管理DBを開かないようにする入口。**
//
// `store.ts` は**モジュール評価時に** `data/chatban-admin.db` を開き、`ensureAdminSchema()` を走らせる。
// この移行には古い設定の `DELETE` と旧テーブルの `DROP TABLE` が含まれるので、
// **`npm test` を流すだけで実データへ移行が当たりうる**。
//
// これを各テストファイルの先頭で `process.env.CHATBAN_DATA_DIR = ...` と書く約束にしていたが、
// **書き忘れが12件たまり、文書 (`mcpLogIsPure.test.ts`) と先例 (#264) があってもまた踏んだ**。
// 人の注意では止まらないので、**書かなくても守られる側**に倒す。
//
// これは `package.json` の test スクリプトから `--import` で先に読み込まれる。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** **環境変数が既にあっても、必ず上書きする** (Codexレビュー P1)。
 *
 * 最初は `??=` で「指定があれば尊重する」形にしていたが、**`CHATBAN_DATA_DIR` は
 * README にも載っている正式な本番設定**なので、シェルやCIに本番の絶対パスが入ったまま
 * `npm test` を流すと、その実データをそのまま開く。`store.ts` の2枚目の番人も
 * 「変数がある」ので黙って通す。**このPRが塞ぐはずだった経路がそこだけ空いていた**。
 *
 * 個別のテストファイルが自前の一時パスを置きたいときは、**ここより後に走る**ので今までどおり効く
 * (`--import` はテストファイルの評価より先)。つまり尊重すべきなのは
 * 「テストが自分で置いた値」だけで、外から来た値ではない。 */
function fresh(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const PREFIXES = ["chatban-test-data-", "chatban-test-log-"];

/** **前回の取りこぼしを掃除する。**
 *
 * 終了時の後始末 (下) だけでは足りなかった — 実測で `npm test` 1回につき12個残る。
 * SQLite のファイルを掴んだまま終わる子プロセスがあり、その瞬間は消せないため。
 * **プロセスが終われば掴みは外れる**ので、次に走ったときなら消せる。
 *
 * 1時間より古いものだけ触る。同時に走っている別の `npm test` のものを消さないため
 * (テスト1回は数十秒で終わる)。 */
function sweepStale(): void {
  const tmp = os.tmpdir();
  const cutoff = Date.now() - 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = path.join(tmp, name);
    try {
      if (fs.statSync(full).mtimeMs > cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // 消せなければ次の機会に回す
    }
  }
}

sweepStale();

const created: string[] = [];

function take(name: string, prefix: string): void {
  const dir = fresh(prefix);
  created.push(dir);
  process.env[name] = dir;
}

take("CHATBAN_DATA_DIR", "chatban-test-data-");
take("CHATBAN_LOG_DIR", "chatban-test-log-");

// **AUTO_ARCHIVE はここで触らない** (Codexレビュー P3)。データとログの隔離とは別の話で、
// **製品の挙動を全テストで無効化する**ことになる。必要な2件は自分のファイルで明示していて、
// そちらのほうが「このテストは自動アーカイブを止めている」と読める。
// ここで一括して止めると、将来「自動で畳む配線」を検証するテストが黙って無効化される。

// **作った一時ディレクトリは片づける** (Codexレビュー P2-1)。
// テストファイル1つにつき子プロセスが1つ立つので、`npm test` 1回で41×2個できる。
// 消していなかったので実測 data 247件 / log 288件 が溜まっていた。中身はDBとログ。
//
// SQLite のファイルが掴まれたままのことがある (Windows) ので、消せなくても止めない —
// ここは後始末であって、失敗させると本題のテスト結果が読めなくなる。
process.on("exit", () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 消せなければ諦める (一時領域なのでOS側でいずれ回収される)
    }
  }
});
