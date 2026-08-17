import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  baseUrlProblem,
  expandHome,
  gitCheckIgnore,
  ignoreEntryFor,
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

const REPO_ROOT = path.join(process.cwd(), "..");

test("**このリポジトリで backend/config.json が git に無視されている**", () => {
  // **git 本体に聞く。**自前で .gitignore を読む判定は、否定パターン (`!backend/config.json`) や
  // ワイルドカードを解釈できず「無視されていないのに無視されている」と答えた (Codexレビュー指摘)。
  // .gitignore の行を消すとこのテストが落ちる
  assert.equal(
    gitCheckIgnore(REPO_ROOT, path.join(REPO_ROOT, "backend", "config.json")),
    true,
    "backend/config.json が git に無視されていない (APIキーがコミットされる)"
  );
});

test("**見本ファイルは git に無視されていない** (コミットしたつもりで入っていない、を防ぐ)", () => {
  // ignore をワイルドカード (`config*.json`) にすると examples/ まで消える。
  // 文字列比較では `*.json` のようなパターンを解釈できないので、ここも git に聞く
  for (const name of ["openai", "anthropic", "local", "orcarouter"]) {
    const p = path.join(REPO_ROOT, "backend", "examples", `config.${name}.json`);
    assert.equal(gitCheckIgnore(REPO_ROOT, p), false, `見本 ${name} が無視されている`);
  }
});

test("設定ファイルがリポジトリの外にあれば、警告の対象にしない", () => {
  assert.equal(ignoreEntryFor(path.join(path.sep, "home", "zio", ".chatban", "config.json"), path.join(path.sep, "repo")), null);
  assert.equal(ignoreEntryFor(path.join(path.sep, "elsewhere", "config.json"), path.join(path.sep, "repo")), null);
});

test("`..` で始まる名前のファイルは「リポジトリ外」と誤判定しない", () => {
  // `startsWith("..")` だと `..secret.json` (リポジトリ直下の正当な名前) が外扱いになり、
  // **リポジトリ内なのに警告が黙る** (Codexレビュー指摘・Windowsで再現)
  const repo = path.join(path.sep, "repo");
  assert.equal(ignoreEntryFor(path.join(repo, "..secret.json"), repo), "..secret.json");
  assert.equal(ignoreEntryFor(path.join(repo, "backend", "..config.json"), repo), "backend/..config.json");
});

test("警告に出す行は、実際に使うパスから決まる", () => {
  // CHATBAN_CONFIG で別名を指した場合、固定の backend/config.json を見ても意味がない
  const repo = path.join(path.sep, "repo");
  assert.equal(ignoreEntryFor(path.join(repo, "backend", "config.json"), repo), "backend/config.json");
  assert.equal(ignoreEntryFor(path.join(repo, "backend", "config.work.json"), repo), "backend/config.work.json");
});

test("リポジトリ内の設定ファイルが無視されていなければ警告が出る", () => {
  // **警告の出方そのもの**を確かめる。git判定は注入して固定する
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-cfg-"));
  try {
    fs.mkdirSync(path.join(dir, "backend"));
    const cfg = path.join(dir, "backend", "config.work.json");
    fs.writeFileSync(cfg, "{}");

    const warnings: string[] = [];
    warnIfConfigNotIgnored(cfg, dir, (m) => warnings.push(m), () => false);
    assert.equal(warnings.length, 1, "無視されていないのに警告が出ない");
    assert.match(warnings[0], /backend\/config\.work\.json/);

    const quiet: string[] = [];
    warnIfConfigNotIgnored(cfg, dir, (m) => quiet.push(m), () => true);
    assert.deepEqual(quiet, [], "無視されているのに警告が出た");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git の判定が取れないときは黙る (gitが無い環境で雑音を出さない)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-cfg-"));
  try {
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, "{}");
    const warnings: string[] = [];
    warnIfConfigNotIgnored(cfg, dir, (m) => warnings.push(m), () => null);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gitの管理下にないディレクトリでは判定不能 (null) が返る", () => {
  // 「無視されていない (false)」と区別できないと、gitを使っていない人に警告が出続ける
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatban-nogit-"));
  try {
    assert.equal(gitCheckIgnore(dir, path.join(dir, "config.json")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("設定ファイルが無ければ、警告も出ない (まだ作っていないだけ)", () => {
  const warnings: string[] = [];
  warnIfConfigNotIgnored(path.join(os.tmpdir(), "chatban-does-not-exist.json"), os.tmpdir(), (m) => warnings.push(m), () => false);
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

test("短いAPIキーも伏せられる (長さで手加減しない)", () => {
  // 8文字未満を素通りさせていたため、**設定が許す短いキーだけ漏れる**穴になっていた
  // (Codexレビュー指摘)。ローカルLLM向けのダミー ("ollama") が伏字になる副作用は受け入れる
  assert.equal(redactSecrets("invalid key abc123", ["abc123"]), "invalid key ***");
  assert.equal(redactSecrets("model qwen3:8b via ollama failed", ["ollama"]), "model qwen3:8b via *** failed");
});

test("空の値は伏字にしない (すべての位置に一致してしまう)", () => {
  assert.equal(redactSecrets("some error", [undefined, null, ""]), "some error");
});

// #191: **上流が中間をマスクして返す形が漏れていた (失効キーで実測)。**
// OpenAI は 401 の本文にキーを部分マスクで載せる:
//   Incorrect API key provided: sk-ant-a****…IgAA
// 元のキーと文字列が違うので完全一致の置換が発火せず、**先頭7文字と末尾4文字が
// ログとHTTP応答に残った** (当日のログで3行)。

test("部分マスクされたキーも伏せる (完全一致では捕まらない形)", () => {
  const key = "sk-ant-api03-REALSECRETVALUE-abcdefghijklmnop-IgAA";
  const masked = "sk-ant-a" + "*".repeat(40) + "IgAA"; // 上流が中間を埋めて返した形
  const out = redactSecrets(`401 Incorrect API key provided: ${masked}. You can find...`, [key]);
  assert.equal(out, "401 Incorrect API key provided: ***. You can find...");
  // 断片が1つも残っていないこと (先頭も末尾も)
  assert.ok(!out.includes("sk-ant-a"), "先頭が残っている");
  assert.ok(!out.includes("IgAA"), "末尾が残っている");
});

test("設定に無いキーでも sk- の形なら伏せる (保険)", () => {
  const out = redactSecrets("upstream said: sk-proj-AbCdEfGhIjKlMnOpQrStUv is invalid", []);
  assert.equal(out, "upstream said: *** is invalid");
});

test("伏せすぎない — モデルIDやrequest_idは残す (診断の材料を消さない)", () => {
  const key = "sk-ant-api03-REALSECRETVALUE-abcdefghijklmnop-IgAA";
  const text = "model gpt-5.4-mini-2026-03-17 request_id=req_011CQ8xYz failed with 401";
  assert.equal(redactSecrets(text, [key]), text);
});

test("短いダミーキーでは前方一致を使わない (無関係な語を巻き込まない)", () => {
  // "ollama" は8文字未満なので、前方一致 (先頭8文字) の規則は適用しない。
  // 完全一致だけが効くので、"ollama-server-v2" のような語まで丸ごと消えたりしない
  assert.equal(
    redactSecrets("connect to ollama-server-v2 failed", ["ollama"]),
    "connect to ***-server-v2 failed"
  );
});
