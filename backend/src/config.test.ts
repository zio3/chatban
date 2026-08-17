import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { expandHome, isGitignored, parseLlmConfig } from "./config.js";

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

test("モデルIDは加工されずそのまま送られる (接頭辞を剥がさない)", () => {
  // #182: 以前は `anthropic/` 接頭辞で経路を判定していたので、直接APIへ出すときに
  // 剥がす処理が要ると考えていた。経路が apiStyle に移ったので、加工は一切しない
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

test("models のどれか1つでも欠けていれば、欠けた項目を名指しで落ちる", () => {
  assert.throws(
    () => parseLlmConfig({ ...VALID, models: { main: "m", cheap: "c" } }, noFiles),
    /models\.archive/
  );
});

test("baseURL が http:// または https:// で始まらなければ弾かれる", () => {
  // `new URL("localhost:11434")` は成功してしまう (localhost: をプロトコルと解釈する) ので、
  // URLとして妥当かどうかだけでは Ollama の宛先の書き間違いを捕まえられない
  assert.throws(() => parseLlmConfig({ ...VALID, baseURL: "localhost:11434" }, noFiles), /baseURL/);
  assert.throws(() => parseLlmConfig({ ...VALID, baseURL: "api.openai.com/v1" }, noFiles), /baseURL/);
  // http は通す (ローカルLLMの宛先は http://localhost:11434/v1)
  assert.equal(parseLlmConfig({ ...VALID, baseURL: "http://localhost:11434/v1" }, noFiles).baseURL, "http://localhost:11434/v1");
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
