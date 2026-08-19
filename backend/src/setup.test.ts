import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** #192: ルートの setup.mjs の判断部分。
 *
 * **本体は依存を入れる前に動く必要がある**ので、npmパッケージを一切 import していない
 * (Nodeの標準機能だけで書いてある)。テストだけは backend 側のランナーに相乗りする —
 * ここに置かないと、どのテストコマンドでも走らない場所にテストが増えることになる。
 *
 * 動的 import なのは、tsconfig の include が src だけで、ルートの .mjs を型解決の対象に
 * 入れたくないため (スクリプト1本のためにビルド構成を広げるのは割に合わない)。
 *
 * ts-ignore は、その .mjs に型定義が無いことに対するもの (TS7016)。
 * **型定義ファイルを別に置くと、setup.mjs と二重管理になる** — 中身が単純な関数4つなので、
 * 型で守るより、下のテストで挙動そのものを固めるほうが実質的。 */
// @ts-ignore -- 型定義の無い .mjs を、テストからだけ読む
const setup: any = await import("../../setup.mjs");

test("isSupportedNode: Node 20 以上を通す", () => {
  assert.equal(setup.isSupportedNode("v22.16.0"), true);
  assert.equal(setup.isSupportedNode("v20.0.0"), true);
  // 接頭辞の v が無い書き方でも判定できる (process.version 以外から渡されたとき)
  assert.equal(setup.isSupportedNode("22.16.0"), true);
  assert.equal(setup.isSupportedNode("v18.20.4"), false);
  // メジャーが2桁になっても文字列比較にしない ("9" > "20" のような取り違えを防ぐ)
  assert.equal(setup.isSupportedNode("v9.11.2"), false);
  assert.equal(setup.isSupportedNode("v100.0.0"), true);
  assert.equal(setup.isSupportedNode("banana"), false);
  assert.equal(setup.isSupportedNode(undefined), false);
});

test("parseProviderChoice: 番号でも名前でも選べる", () => {
  assert.equal(setup.parseProviderChoice("1").key, "openai");
  assert.equal(setup.parseProviderChoice("3").key, "orcarouter");
  assert.equal(setup.parseProviderChoice("openai").key, "openai");
  assert.equal(setup.parseProviderChoice("  Anthropic  ".toLowerCase().trim()).key, "anthropic");
  assert.equal(setup.parseProviderChoice(" 2 ").key, "anthropic");
  // 見本が消えた宛先は選べない (#206: config.local.json は #202 で削除された)
  assert.equal(setup.parseProviderChoice("ollama"), null);
  assert.equal(setup.parseProviderChoice("4"), null);
});

test("parseProviderChoice: 決められない入力は null (既定へ倒さない)", () => {
  // 空Enterを既定にすると、読まずに進んだ人がキーの要る構成を引く
  assert.equal(setup.parseProviderChoice(""), null);
  assert.equal(setup.parseProviderChoice("   "), null);
  assert.equal(setup.parseProviderChoice(undefined), null);
  assert.equal(setup.parseProviderChoice("0"), null);
  assert.equal(setup.parseProviderChoice("99"), null);
  assert.equal(setup.parseProviderChoice("gpt"), null);
});

test("expandHome: backend/src/config.ts と同じ規則", () => {
  const home = path.join("C:", "Users", "someone");
  assert.equal(setup.expandHome("~", home), home);
  assert.equal(setup.expandHome("~/.openai/apikey.txt", home), path.join(home, ".openai/apikey.txt"));
  // Windowsの区切りで書かれていても展開する (見本は ~/ だが、人が書き換える場所でもある)
  assert.equal(setup.expandHome("~\\.openai\\apikey.txt", home), path.join(home, ".openai\\apikey.txt"));
  // 途中の ~ は展開しない
  assert.equal(setup.expandHome("/opt/~/key.txt", home), "/opt/~/key.txt");
  assert.equal(setup.expandHome("C:/keys/api.txt", home), "C:/keys/api.txt");
});

test("keyStatus: 直書きのキーは置き場を案内しない", () => {
  // apiKey を直に書いた設定 (キーをファイルに逃がさない書き方)。
  // ここで missing を返すと、置き場所の無いキーを置けと言い出す
  const st = setup.keyStatus({ apiKey: "sk-written-directly" }, () => false);
  assert.equal(st.kind, "not-needed");
});

test("keyStatus: apiKeyFile の有無を見る", () => {
  const home = path.join("C:", "Users", "someone");
  const conf = { apiKeyFile: "~/.openai/apikey.txt" };
  const target = path.join(home, ".openai/apikey.txt");

  const present = setup.keyStatus(conf, (p: string) => p === target, home);
  assert.equal(present.kind, "present");
  assert.equal(present.file, target);

  const missing = setup.keyStatus(conf, () => false, home);
  assert.equal(missing.kind, "missing");
  // 案内に出すのは展開後の実パス。"~/..." のまま出すと、置いた先が合っているか確かめられない
  assert.equal(missing.file, target);
});

test("keyStatus: どちらも無い設定は unknown (勝手に直さない)", () => {
  assert.equal(setup.keyStatus({}, () => false).kind, "unknown");
  assert.equal(setup.keyStatus(null, () => false).kind, "unknown");
});

test("parseArgs: 知らない引数を黙って捨てない", () => {
  assert.deepEqual(setup.parseArgs(["--check"]).check, true);
  assert.deepEqual(setup.parseArgs(["--provider", "openai"]).provider, "openai");
  assert.deepEqual(setup.parseArgs(["--provider=orcarouter"]).provider, "orcarouter");
  assert.deepEqual(setup.parseArgs([]).provider, null);
  // 打ち間違いに気づけるように、拾えなかったものを残す
  assert.deepEqual(setup.parseArgs(["--chek"]).unknown, ["--chek"]);
  assert.deepEqual(setup.parseArgs(["--help"]).help, true);
});

test("PROVIDERS: 番号は並び順どおり", () => {
  const keys = setup.PROVIDERS.map((p: any) => p.key);
  assert.deepEqual(keys, ["openai", "anthropic", "orcarouter"]);
  // 番号での選択は並び順に依存するので、順序が変わったらこのテストで気づく
  for (const [i, p] of setup.PROVIDERS.entries()) {
    assert.equal(setup.parseProviderChoice(String(i + 1)).file, p.file);
  }
});

/** #206: **見本ファイルが実在することまで見る。**
 *
 * #202 が `backend/examples/config.local.json` を消したとき、setup.mjs の PROVIDERS には
 * ollama が残っていたので `--provider ollama` が必ず「見本が見つかりません」で落ちた。
 * 2つのPRが並行していて、どちらも自分の変更の中では正しく、gitも衝突として検出しない。
 * **名前の対応だけを見るテストでは、参照先が消えたことに気づけない** — 実在を見て初めて落ちる */
test("PROVIDERS: 見本ファイルが backend/examples/ に実在する", () => {
  const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");
  for (const p of setup.PROVIDERS) {
    assert.ok(existsSync(path.join(examples, p.file)), `見本が無い: ${p.file}`);
  }
});
