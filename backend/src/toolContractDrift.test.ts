import assert from "node:assert/strict";
import test from "node:test";

/** #245: **手書きの契約が3つあるので、食い違ったら落とす。**
 *
 * 同じツールの契約が3か所にある:
 *
 *   - `chat.ts` の `buildTools()` — **LLMに見せる JSON Schema** (説明文つき)
 *   - `toolArgs.ts` の Zod — **実行時の検査**
 *   - `mcp.ts` の Zod — **MCP SDK に渡す定義** (説明文つき。SDKがこれで検査する)
 *
 * ## なぜ生成しないか
 *
 * JSON Schema を Zod から生成すれば1つにできるが、**プロンプトのバイト列が変わると
 * キャッシュが外れる** (CLAUDE.md「プレフィックスを安定させる」)。
 * 説明文はモデルへのUIラベルでもあり (#92)、機械生成に寄せると質が落ちる。
 *
 * **だから生成の代わりに突き合わせる。**
 *
 * ## 実際にズレていた
 *
 * この番人を書いた時点で **`create_cards` の `status` と `summary` がチャット側に無かった**
 * (MCPと検査用にはあった)。内蔵チャットは**作成時に置けると知らず**、
 * 作ってから `update_cards` で直す往復をしていた (Codexレビュー指摘)。
 * ツール名だけを見る番人では通っていた。 */

const { buildTools } = await import("./chat.js");
const { toolArgSchemas } = await import("./toolArgs.js");

const LANES: never[] = [];

/** Zod のオブジェクトから「キー名 → 必須か」を取り出す */
function zodKeys(schema: any): Map<string, boolean> {
  const shape = schema.shape ?? schema._def?.shape?.();
  const out = new Map<string, boolean>();
  for (const [k, v] of Object.entries<any>(shape)) {
    out.set(k, !v.isOptional());
  }
  return out;
}

/** 配列の要素スキーマ (`z.array(...)` の中身) */
function itemSchema(schema: any): any {
  return schema._def?.type ?? schema.element;
}

/** JSON Schema のオブジェクトから同じものを取り出す */
function jsonKeys(node: any): Map<string, boolean> {
  const required: string[] = node.required ?? [];
  return new Map(Object.keys(node.properties ?? {}).map((k) => [k, required.includes(k)]));
}

const tools = new Map(buildTools(LANES).map((t: any) => [t.function.name, t.function.parameters]));
const schemas = toolArgSchemas(LANES) as Record<string, any>;

for (const [name, schema] of Object.entries(schemas)) {
  test(`${name}: LLMに見せている契約と、検査している契約が一致する`, () => {
    const params = tools.get(name);
    assert.ok(params, `${name} がチャットのツール定義に無い`);

    assert.deepEqual(
      [...jsonKeys(params).entries()].sort(),
      [...zodKeys(schema).entries()].sort(),
      "引数の顔ぶれか必須の指定がズレている"
    );
  });
}

// カード1件ぶんの中身も見る。**ここがズレていたのが実例** (status / summary)
for (const [name, path] of [
  ["create_cards", "cards"],
  ["update_cards", "updates"],
] as const) {
  test(`${name}: カード1件の項目も一致する`, () => {
    const params: any = tools.get(name);
    const json = jsonKeys(params.properties[path].items);
    const zod = zodKeys(itemSchema(schemas[name].shape[path]));

    assert.deepEqual(
      [...json.entries()].sort(),
      [...zod.entries()].sort(),
      "カードに置ける項目がズレている (LLMは知らないのに検査は通す、またはその逆)"
    );
  });
}

// **番人が本物を見ていること。**対象が空だと全部素通りする (#180 の教訓)
test("番人が実際に契約を読めている", () => {
  assert.ok(tools.size >= 8, `チャットのツールが読めていない (${tools.size}件)`);
  assert.ok(Object.keys(schemas).length >= 8, "検査用の契約が読めていない");

  const create = zodKeys(itemSchema(schemas.create_cards.shape.cards));
  assert.ok(create.has("title"), "Zodのキーを取り出せていない");
  assert.equal(create.get("title"), true, "必須かどうかを取り出せていない");
});
