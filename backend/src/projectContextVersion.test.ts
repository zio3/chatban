import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #244: **前提情報は、版を添えないと書けない。**
 *
 * `setProjectContext` は以前 `version` を省略できた。「人間のUI経路は従来どおり上書きできる」
 * という緩和だったが、**その経路はもう無い** (📋前提は編集UIを持たず、変更経路はチャットだけ #73)。
 * 居なくなった呼び出し元のための緩和が、**LLMから届く経路として残っていた**。
 *
 * ツール定義では必須にしてあるが、**チャットの引数はLLMが組み立てるJSON**なので
 * スキーマを無視した値が届きえる (`security.md` §1 が言っているとおり)。MCP は Zod で
 * 弾くので、抜けていたのはチャット経路だけだった (Codexレビュー指摘)。
 *
 * 前提情報はシステムプロンプトに常時載る**全員の前提**なので、読まずに全文を書き戻されると
 * 運用ルールが黙って消える。**説明の誤差ではなく実データが消える。**
 *
 * ここをテストにしたのは、`security.md` に「前提情報は版を検査する」と書いたから。
 * **書いた保証と実装が合っているかを、文でなくコードで固定する。** */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-ctxtest-"));
process.env.CHATBAN_DATA_DIR = dataDir;
process.env.AUTO_ARCHIVE = "0";

const { ensureInitialProject } = await import("./store.js");
ensureInitialProject();

const { getProjectContextRow, setProjectContext } = await import("./db.js");

test("正しい版を添えれば書ける", () => {
  const before = getProjectContextRow();
  const r = setProjectContext("最初の前提", before.version);
  assert.equal(r.ok, true);
  assert.equal(getProjectContextRow().text, "最初の前提");
});

test("版が合わなければ断り、現在の全文を返す (マージして再実行させるため)", () => {
  const cur = getProjectContextRow();
  const r = setProjectContext("古い版から書き戻す", cur.version - 1);
  assert.equal(r.ok, false);
  assert.equal(r.current?.text, cur.text, "断るときは現在の全文を返す");
  assert.equal(getProjectContextRow().text, cur.text, "断ったのに書き込まれている");
});

// **本題。**版を省略した呼び出しは、競合として断る
test("版を省略したら書けない (省略は競合として扱う)", () => {
  const cur = getProjectContextRow();
  const r = setProjectContext("版を添えずに全部書き換える", undefined);
  assert.equal(r.ok, false, "版を省略した書き込みが通っている");
  assert.equal(getProjectContextRow().text, cur.text, "前提情報が黙って上書きされた");
  assert.equal(r.current?.version, cur.version, "現在の版を返して再実行させる");
});

// **既定値を持たせない。**#236 と同じ形 — 既定値があると渡し忘れが黙って通る形に戻る
test("version は呼び出し側が必ず渡す (既定値を持たない)", () => {
  assert.equal(setProjectContext.length, 2, "引数が2つでなくなっている = 省略可に戻した可能性がある");
});

// 断ったあとで、返された版を添えれば通る (案内どおりに再実行できる)
test("断られた側は、返された版を添えれば書ける", () => {
  const conflict = setProjectContext("通らない", undefined);
  assert.equal(conflict.ok, false);
  const retry = setProjectContext("マージして再実行", conflict.current!.version);
  assert.equal(retry.ok, true);
  assert.equal(getProjectContextRow().text, "マージして再実行");
});

// **本文が来ていない書き込みも断る。**version の穴を塞いだ直後に見つかった同じ形 —
// チャット側が `args.text ?? ""` と補っていたので、**欠落と null が「意図的な全消去」に化けた**。
// 正しい版さえ添えれば前提情報が空になる (Codexレビュー4周目の指摘)。
//
// **受け側で塞ぐ。**呼び出し元で補わない約束にしても、入口が増えたら同じことが起きる
test("本文が来ていなければ書けない (欠落・null が全消去に化けない)", () => {
  const cur = getProjectContextRow();
  for (const bad of [undefined, null]) {
    const r = setProjectContext(bad as unknown as string, cur.version);
    assert.equal(r.ok, false, `text=${String(bad)} が通っている`);
    assert.equal(r.missingText, true, "本文が無いことを呼び出し側に伝える (版の競合と区別する)");
    assert.equal(getProjectContextRow().text, cur.text, "前提情報が空にされた");
  }
});

// **空文字そのものは禁じない。**全部消す操作と区別が付かなくなるため。
// 「うっかり消える」を止めたいのであって、「消せない」ようにしたいのではない
test("空文字を明示したときは、正しい版なら書ける (全消去は正当な操作)", () => {
  const cur = getProjectContextRow();
  const r = setProjectContext("", cur.version);
  assert.equal(r.ok, true);
  assert.equal(getProjectContextRow().text, "");
});
