import { z } from "zod";
import type { CustomLane } from "./types.js";

/** #245: **エージェントのツール引数を、実行時に1箇所で検査する。**
 *
 * ## なぜ要るか
 *
 * チャットのツール定義 (`buildTools`) は **LLMへの説明**であって検査ではない。
 * `JSON.parse` した値をそのまま書き込み関数へ渡していたので、
 * モデルの出力が揺れるだけで**実データが消えた**。1日で見つかった壊れ方:
 *
 *   - `context: null` → 経緯メモが丸ごと消える (`undefined` は「触らない」だが `null` は「置換」)
 *   - `summary: null` → 要約が消える / `rejected: "false"` → **true に反転**
 *   - `ids: "12"` → `"1"` と `"2"` に割れ、**指していないカードを実際に復元・削除する**
 *   - `updates: [null]` / `terms: "語"` → 未処理の例外で**チャットのターンごと落ちる**
 *
 * **MCPはこれを踏んでいない。**MCP SDK が Zod で検査してからハンドラを呼ぶため。
 * つまり穴は「チャット入口に検査が無い」という**1点**で、
 * 項目ごと・ツールごとに塞いで回るのは面を1マスずつ埋める作業だった。
 *
 * ## 何をどこで見るか (二重にしない)
 *
 * | 層 | 見るもの | 失敗の返し方 |
 * |---|---|---|
 * | ここ (入口) | **型** — 契約どおりの形か | 1件も適用せず、**どこが違うかをパスで**返す |
 * | `agentWrite.ts` (共有入口) | **意味** — 版の一致 / 使える列か / 作成で使えるキーか | **行ごと**に未適用 + 理由 |
 *
 * 型が違う呼び出しは全体を断る。**MCPと同じ挙動**にしてある (あちらもZodが先に落とす) —
 * 入口ごとに「型違いのときどうなるか」が違うと、また入口の差が生まれる。
 *
 * 意味の判定を行ごとにするのは、**版の競合が正常な運用で起きる**ため
 * (他人が先に書いた)。型違いは正常な運用では起きないので、揃えて断ってよい。
 *
 * ## 個別のガードは消していない
 *
 * `agentWrite.ts` の型検査は**最後の砦として残す**。入口はまた増える
 * (#114 でMCPが増えたときに素通りした前科がある)。ここは「入口を1つ塞ぐ」ものであって、
 * 「奥を薄くしてよい」という話ではない。 */

/** エージェントが選べる列。**done は入れない。**
 * 以前は enum に done があり、受けた側 (coerceStatus) で review へ倒していたが、
 * それは「押せるボタンを押した後で断る」形だった。選べないものは選ばれない。
 *
 * #245 で chat.ts から移した。**契約の一覧は契約の側に置く** —
 * 同じ一覧を2か所に書くと必ず片方だけ直る (#92 #108 #114) */
export const AGENT_STATUS_VALUES = ["todo", "inprogress", "review"] as const;

/** #19: この接続のプロジェクトで選べる列。任意レーンを**有効なものだけ**足す */
export function agentStatusValues(lanes: CustomLane[]): string[] {
  return [...AGENT_STATUS_VALUES, ...lanes.map((l) => l.key)];
}

/** 並べ替えられる列。done は人が並べる列ではない (検収の結果が並ぶだけ) ので対象にしない (#105) */
export const REORDERABLE_STATUSES = ["todo", "inprogress", "review"] as const;

export function reorderableStatuses(lanes: CustomLane[]): string[] {
  return [...REORDERABLE_STATUSES, ...lanes.map((l) => l.key)];
}

const ids = z.array(z.number().int());

/** 作成・更新のカード1件。**未知のキーはここで断る** (`.strictObject`)。
 *
 * Zodの既定は *strip* で、`context_append` のような「型は正しいが作成では使えないキー」を
 * **黙って削って通してしまう** — 指定したのに保存されず、それでも成功に見える。
 * strict にすると「そのキーは使えません」が**スキーマの側から**言えるので、
 * 許可キーの手書き一覧をコードに持たなくてよい。
 *
 * 列 (`status`) も enum で縛る。**選べないものは選ばれない** —
 * 未知の列が奥まで届くと「無視されたのに成功」になる。
 * `done` は enum に入れない (契約に無い選択肢は押せない) が、
 * 万一届いたときの矯正は `coerceStatus` に残してある */
function cardSchemas(lanes: CustomLane[]) {
  const status = z.enum(agentStatusValues(lanes) as [string, ...string[]]);

  const create = z.strictObject({
    // **空のタイトルは断る。**型ではなく**作成の意味**の制約だが、契約の側に置く —
    // タイトルはカードを識別する唯一の常時表示項目で、空だと板に「無題の何か」が残る。
    // #245 の途中で型検査ごと剥がしてしまい、空白だけのカードが作れる状態にした (Codexレビュー指摘)
    title: z.string().refine((v) => v.trim() !== "", { message: "空でない文字列で渡してください" }),
    status: status.optional(),
    context: z.string().optional(),
    summary: z.string().optional(),
    // 作成では null を許さない。**解除する対象がまだ無い** (更新側だけが null で外せる)
    due: z.string().optional(),
    blocked_by: ids.optional(),
  });

  const update = z.strictObject({
    id: z.number().int(),
    title: z.string().optional(),
    status: status.optional(),
    summary: z.string().optional(),
    context: z.string().optional(),
    context_version: z.number().int().optional(),
    context_append: z.string().optional(),
    due: z.string().nullable().optional(),
    blocked_by: ids.nullable().optional(),
    rejected: z.boolean().optional(),
  });

  return { create, update };
}

/** ツール名 → 引数の形。**チャットとMCPが同じものを指す。**
 * `sync_token` はMCP専用なので入れない (あちらのスキーマが持っている) */
export function toolArgSchemas(lanes: CustomLane[]) {
  const { create, update } = cardSchemas(lanes);
  return {
    create_cards: z.strictObject({ cards: z.array(create) }),
    update_cards: z.strictObject({ updates: z.array(update) }),
    delete_cards: z.strictObject({ ids }),
    restore_cards: z.strictObject({ ids }),
    reorder_cards: z.strictObject({
      status: z.enum(reorderableStatuses(lanes) as [string, ...string[]]),
      ids,
    }),
    search_cards: z.strictObject({ terms: z.array(z.string()) }),
    query_log: z.strictObject({ sql: z.string() }),
    update_project_context: z.strictObject({ text: z.string(), version: z.number().int() }),
  };
}

export type ToolName = keyof ReturnType<typeof toolArgSchemas>;

/** Zodのエラーを、**モデルが読んで直せる1行**にする。
 * `updates[1].summary: 文字列で渡してください` のように**どこが違うか**を示す —
 * 「引数が不正です」だけだと、モデルは同じものを言い換えて再送する */
function readable(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => {
      const at = i.path.length > 0 ? i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("") : "引数";
      const want = "expected" in i ? `${String(i.expected)} で渡してください` : i.message;
      return `${at.replace(/^\./, "")}: ${want}`;
    })
    .join(" / ");
}

/** 実行前の関門。**通らなければ1件も触らない。**
 * 例外にしないのは、`execTool` に受けが無く、投げると**チャットのターンごと失敗する**ため
 * (ツール結果としてモデルに返れば、モデルは読んで直せる) */
export function parseToolArgs(
  name: string,
  args: unknown,
  lanes: CustomLane[]
): { ok: true; args: any } | { ok: false; note: string } {
  const schema = (toolArgSchemas(lanes) as Record<string, z.ZodTypeAny>)[name];
  if (!schema) return { ok: true, args }; // 検査対象でないツールは素通し (増やすときはここに足す)
  const r = schema.safeParse(args ?? {});
  return r.success
    ? { ok: true, args: r.data }
    : {
        ok: false,
        note: `${name} の引数が契約と違うので、1件も実行していません — ${readable(r.error)}。直して呼び直してください`,
      };
}
