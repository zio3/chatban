import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  baseUrlProblem,
  expandHome,
  ignoreEntryFor,
  isGitignored,
  parseLlmConfig,
  redactSecrets,
  warnIfConfigNotIgnored,
} from "./config.js";

/** #182: LLM設定の読み込み。**判断だけを純粋関数に切り出してある**ので、
 * DBもHTTPもディスクも要らずに確かめられる (ファイル読み込みは引数で注入する)。
 *
 * ここが守っているのは2つ:
 *  - 壊れた設定で起動したとき、**どの項目が悪いか名指しで落ちる** (envだと最初のLLM呼び出しまで発覚しない)
 *  - **キーがコミットされる経路を塞ぐ** (.gitignore の書き忘れ検出) */

const VALID = {
  apiKey: "sk-test",
  baseURL: "https://api.openai.com/v1",
  apiStyle: "chat",
  models: { main: "gpt-5.4-mini-2026-03-17", archive: "gpt-5.6-luna", cheap: "gpt-5.6-luna" },
};
const noFiles = (p: string): string => {
  throw new Error(`読めません: ${p}`);
};

test("正しい設定はそのままの値で返る", () => {
  const c = parseLlmConfig(VALID, noFiles);
  assert.equal(c.apiKey, "sk-test");
  assert.equal(c.baseURL, "https://api.openai.com/v1");
  assert.equal(c.apiStyle, "chat");
  assert.equal(c.models.main, "gpt-5.4-mini-2026-03-17");
});

test("読み込み結果のモデルIDは、設定に書いた文字列と同一になる (接頭辞を剥がさない)", () => {
  // #182: 以前は `anthropic/` 接頭辞で経路を判定していたので、直接APIへ出すときに
  // 剥がす処理が要ると考えていた。経路が apiStyle に移ったので、読み込み時の加工は無い。
  // **実際に送られるかどうかはここでは見ていない** (chatCompletion に渡すのは呼び出し側)
  const c = parseLlmConfig({ ...VALID, models: { ...VALID.models, main: "openai/gpt-5.4-mini" } }, noFiles);
  assert.equal(c.models.main, "openai/gpt-5.4-mini");
});

test("apiKeyFile を指定するとその中身が読まれ、前後の空白は落ちる", () => {
  const c = parseLlmConfig({ ...VALID, apiKey: undefined, apiKeyFile: "/keys/openai.txt" }, (p) => {
    assert.equal(p, "/keys/openai.txt");
    return "  sk-from-file\n";
  });
  assert.equal(c.apiKey, "sk-from-file");
});

test("apiKeyFile の ~ はホームディレクトリに展開されてから読まれる", () => {
  let asked = "";
  parseLlmConfig({ ...VALID, apiKey: undefined, apiKeyFile: "~/.openai/apikey.txt" }, (p) => {
    asked = p;
    return "sk-x";
  }, "/home/zio");
  // 区切り文字は環境依存 (Windowsでは \) なので、期待値も path.join で組む
  assert.equal(asked, path.join("/home/zio", ".openai/apikey.txt"));
});

test("apiKey と apiKeyFile の両方があれば apiKey が使われ、ファイルは読まれない", () => {
  const c = parseLlmConfig({ ...VALID, apiKeyFile: "/keys/openai.txt" }, noFiles);
  assert.equal(c.apiKey, "sk-test");
});

test("apiKey も apiKeyFile も無ければ、その旨のエラーになる", () => {
  assert.throws(() => parseLlmConfig({ ...VALID, apiKey: undefined }, noFiles), /apiKeyFile/);
});

test("apiKeyFile が空ファイルなら、空のまま起動せずエラーになる", () => {
  // 空のキーで起動すると、最初のLLM呼び出しで 401 になるまで原因が分からない
  assert.throws(() => parseLlmConfig({ ...VALID, apiKey: undefined, apiKeyFile: "/k" }, () => "  \n"), /空です/);
});

test("apiKeyFile を読めなければ、探したパスを添えてエラーになる", () => {
  assert.throws(() => parseLlmConfig({ ...VALID, apiKey: undefined, apiKeyFile: "/nope" }, noFiles), /\/nope/);
});

test("知らない apiStyle は起動時に弾かれる", () => {
  // "openai" や "anthropic" と書きたくなるが、これはプロバイダ名ではなくAPIの形式
  assert.throws(() => parseLlmConfig({ ...VALID, apiStyle: "anthropic" }, noFiles), /apiStyle/);
});

test("models は3つのどれが欠けても、欠けた項目を名指しで落ちる", () => {
  // 1つだけ試すと「archiveだけ必須」という実装でも通ってしまう
  for (const slot of ["main", "archive", "cheap"] as const) {
    const models: Record<string, string> = { ...VALID.models };
    delete models[slot];
    assert.throws(() => parseLlmConfig({ ...VALID, models }, noFiles), new RegExp(`models\\.${slot}`), `${slot} が欠けても落ちない`);
  }
});

test("models の値が空白だけなら弾かれる", () => {
  // min(1) はスペース1文字を通してしまう。空のモデルIDで起動すると呼び出し時まで気づけない
  assert.throws(() => parseLlmConfig({ ...VALID, models: { ...VALID.models, main: "   " } }, noFiles), /models\.main/);
});

test("apiKey が空白だけなら弾かれ、前後の空白は落とされる", () => {
  assert.throws(() => parseLlmConfig({ ...VALID, apiKey: "  " }, noFiles), /apiKey/);
  // ファイル経由は trim していたのに、直接書いた場合だけ素通りしていた (Codexレビュー指摘)
  assert.equal(parseLlmConfig({ ...VALID, apiKey: "  sk-x  " }, noFiles).apiKey, "sk-x");
});

test("baseURL が http:// または https:// で始まらなければ弾かれる", () => {
  // `new URL("localhost:11434")` は成功してしまう (localhost: をプロトコルと解釈する) ので、
  // URLとして妥当かどうかだけでは Ollama の宛先の書き間違いを捕まえられない
  assert.equal(baseUrlProblem("localhost:11434"), "http:// または https:// で始める必要があります");
  assert.equal(baseUrlProblem("api.openai.com/v1"), "URLとして読めません");
  assert.match(String(baseUrlProblem("ftp://example.com")), /https?:\/\//);
  assert.throws(() => parseLlmConfig({ ...VALID, baseURL: "localhost:11434" }, noFiles), /baseURL/);
});

test("外部の宛先に http:// を使うと弾かれる (キーが平文で流れるため)", () => {
  // Authorization ヘッダも x-api-key も暗号化されないので、外向きの http は許さない
  assert.match(String(baseUrlProblem("http://example.com/v1")), /https:\/\//);
  assert.match(String(baseUrlProblem("http://192.168.1.5:8080/v1")), /https:\/\//);
  assert.throws(() => parseLlmConfig({ ...VALID, baseURL: "http://example.com/v1" }, noFiles), /baseURL/);
});

test("ローカル宛の http:// は通る (ローカルLLMの宛先)", () => {
  for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://[::1]:11434/v1"]) {
    assert.equal(baseUrlProblem(url), null, `通らない: ${url}`);
  }
  assert.equal(parseLlmConfig({ ...VALID, baseURL: "http://localhost:11434/v1" }, noFiles).baseURL, "http://localhost:11434/v1");
});

test("URLにユーザー名・パスワード・クエリが入っていれば弾かれる", () => {
  // ここを許すと、キーがURLに混ざったまま起動ログや画面表示に出る
  assert.match(String(baseUrlProblem("https://user:pass@api.example.com/v1")), /ユーザー名/);
  assert.match(String(baseUrlProblem("https://api.example.com/v1?key=sk-secret")), /クエリ/);
  assert.match(String(baseUrlProblem("https://api.example.com/v1#sk-secret")), /#/);
});

test("設定ファイルが空オブジェクトなら、足りない項目がまとめて出る", () => {
  try {
    parseLlmConfig({}, noFiles);
    assert.fail("エラーにならなかった");
  } catch (e: any) {
    // 起動時に落ちる側の人が読むメッセージなので、1つ直すたびに再実行させない
    assert.match(e.message, /baseURL/);
    assert.match(e.message, /apiStyle/);
    assert.match(e.message, /models/);
  }
});

test("expandHome はホーム以外のパスに触らない", () => {
  assert.equal(expandHome("/etc/keys.txt", "/home/zio"), "/etc/keys.txt");
  assert.equal(expandHome("relative/keys.txt", "/home/zio"), "relative/keys.txt");
  // "~foo" はユーザー名の指定 (bashの ~root など) なので展開しない
  assert.equal(expandHome("~foo/keys.txt", "/home/zio"), "~foo/keys.txt");
  assert.equal(expandHome("~", "/home/zio"), "/home/zio");
});

test("gitignore の判定は完全一致の行だけを見る", () => {
  assert.equal(isGitignored("node_modules/\nbackend/config.json\nlogs/"), true);
  assert.equal(isGitignored("  backend/config.json  "), true, "前後の空白は詰める");
  assert.equal(isGitignored("/backend/config.json"), true, "先頭スラッシュ付きも有効な書き方");
  assert.equal(isGitignored("node_modules/\nlogs/"), false);
});

test("gitignore のコメント行は無視される", () => {
  // コメントで言及しただけで「無視されている」と誤判定すると、警告が出ないまま公開リポジトリに置かれる
  assert.equal(isGitignored("# backend/config.json は各自で作る\nlogs/"), false);
});

test("ワイルドカードの行は gitignore 済みと見なさない", () => {
  // `config*.json` は examples/ 側まで無視してしまうので、正しい書き方ではない。
  // ここで true を返すと「サンプルがコミットされていない」構成を追認することになる
  assert.equal(isGitignored("backend/config*.json"), false);
  assert.equal(isGitignored("*.json"), false);
});

test("**このリポジトリの実際の .gitignore が backend/config.json を無視している**", () => {
  // ここまでの gitignore テストは文字列を渡しているだけなので、**実物が壊れても落ちない**
  // (Codexレビュー指摘: .gitignore の行を消しても全テストが通る状態だった)。
  // このテストだけは実ファイルを読む。行を消したらここが落ちる
  const repoRoot = path.join(process.cwd(), "..");
  const text = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.equal(isGitignored(text, "backend/config.json"), true, ".gitignore から backend/config.json の行が消えている");
});

test("**見本ファイルは無視されていない** (コミットしたつもりで入っていない、を防ぐ)", () => {
  // ignore をワイルドカードにすると examples/ まで消える。実物のパスで確かめる
  const repoRoot = path.join(process.cwd(), "..");
  const text = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  for (const name of ["openai", "anthropic", "local", "orcarouter"]) {
    assert.equal(isGitignored(text, `backend/examples/config.${name}.json`), false);
  }
});

test("設定ファイルがリポジトリの外にあれば、gitignore の警告はしない", () => {
  assert.equal(ignoreEntryFor("/home/zio/.chatban/config.json", "/repo"), null);
  assert.equal(ignoreEntryFor("/repo/../elsewhere/config.json", "/repo"), null);
});

test("gitignore に書かれているべき行は、実際に使うパスから決まる", () => {
  // CHATBAN_CONFIG で別名を指した場合、固定の backend/config.json を見ても意味がない
  assert.equal(ignoreEntryFor(path.join("/repo", "backend", "config.json"), "/repo"), "backend/config.json");
  assert.equal(ignoreEntryFor(path.join("/repo", "backend", "config.work.json"), "/repo"), "backend/config.work.json");
});

test("リポジトリ内の設定ファイルが無視されていなければ警告が出る", () => {
  // **警告の出方そのもの**を確かめる (これまでは判定関数しか通していなかった)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-cfg-"));
  try {
    fs.mkdirSync(path.join(dir, "backend"));
    const cfg = path.join(dir, "backend", "config.work.json");
    fs.writeFileSync(cfg, "{}");
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\nbackend/config.json\n");

    const warnings: string[] = [];
    warnIfConfigNotIgnored(cfg, dir, (m) => warnings.push(m));
    assert.equal(warnings.length, 1, "別名の設定ファイルが無視されていないのに警告が出ない");
    assert.match(warnings[0], /backend\/config\.work\.json/);

    // 無視されていれば黙る
    fs.appendFileSync(path.join(dir, ".gitignore"), "backend/config.work.json\n");
    const quiet: string[] = [];
    warnIfConfigNotIgnored(cfg, dir, (m) => quiet.push(m));
    assert.deepEqual(quiet, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("設定ファイルが無ければ、警告も出ない (まだ作っていないだけ)", () => {
  const warnings: string[] = [];
  warnIfConfigNotIgnored(path.join(os.tmpdir(), "chatban-does-not-exist.json"), os.tmpdir(), (m) => warnings.push(m));
  assert.deepEqual(warnings, []);
});

test("エラー本文に混ざったAPIキーは伏せられる", () => {
  // 互換宛先が認証失敗時に受け取ったキーを返すことがある (Codexレビューで再現)。
  // その本文はログにもHTTP応答にも流れる
  const key = "sk-secret-value-12345";
  assert.equal(redactSecrets(`messages 401: invalid key: ${key}`, [key]), "messages 401: invalid key: ***");
  // 同じ本文に複数回出ても全部消す
  assert.equal(redactSecrets(`${key} and ${key}`, [key]), "*** and ***");
});

test("短すぎる値や空の値は伏字にしない (無関係な文字列を壊さない)", () => {
  assert.equal(redactSecrets("model gpt-5.4 failed", ["gpt"]), "model gpt-5.4 failed");
  assert.equal(redactSecrets("some error", [undefined, null, ""]), "some error");
});
