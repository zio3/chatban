import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reorderResult, searchResult } from "./chat.js";

// #227: 道具の応答をチャットとMCPで揃える。
// 説明文は既に共通定数だったのに応答の組み立ては入口ごとに書かれていて、
// **外部エージェントだけが注意書きを受け取れない**状態になっていた。

// #257: 誘導先は query_log から get_cards へ変わった (全文を読むのに道具ができた)
test("searchResult: 当たりがあるときだけ get_cards へ誘導する", () => {
  const hit = searchResult({ hits: [{ id: 1 }] }) as any;
  assert.match(hit.note, /get_cards/);
  assert.match(hit.note, /snippet/);
  assert.equal((searchResult({ hits: [] }) as any).note, undefined);
});

test("reorderResult: 指定漏れがあったときだけ件数を添える", () => {
  const some = reorderResult({ appended: 3 }) as any;
  assert.equal(some.ok, true);
  assert.match(some.note, /3件/);
  assert.equal((reorderResult({ appended: 0 }) as any).note, undefined);
});

/** 番人。**書き込みは全部 sync_token を受け取る** (#150 の「作業中の書き込みに相乗りさせる」は
 * 削除・復元・並べ替えにもそのまま当てはまる)。道具を足したときに付け忘れても
 * 何も落ちない — 呼ぶ側が古い板を握ったまま黙って作業するだけなので、ここで機械的に見る */
test("MCPの書き込みツールは全部 sync_token を受け取り boardUpdate を返す", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.resolve(here, "mcp.ts"), "utf-8");
  const writes = ["create_cards", "update_cards", "delete_cards", "restore_cards", "reorder_cards"];
  for (const name of writes) {
    // 登録の開始から、次の registerTool までを1件ぶんとして切り出す
    const from = src.indexOf(`"${name}"`);
    assert.ok(from > 0, `mcp.ts から ${name} の登録を読めない (書き方が変わった可能性がある)`);
    const next = src.indexOf("server.registerTool(", from);
    const block = src.slice(from, next > 0 ? next : undefined);
    assert.match(block, /sync_token: SYNC_TOKEN_ON_WRITE/, `${name} が sync_token を受け取っていない`);
    assert.match(block, /boardUpdate\(sync_token\)/, `${name} が boardUpdate を返していない`);
  }
});
