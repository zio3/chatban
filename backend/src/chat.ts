import type OpenAI from "openai";
import { compactArchive } from "./archive.js";
import { getBoardPromptSection } from "./promptState.js";
import {
  assignmentHistory,
  createProposal,
  createTask,
  restoreTask,
  trashTask,
  getTask,
  listPendingProposals,
  listSummaryCards,
  listTasks,
  memberLoads,
  recentActivity,
  reorderTasks,
  resolveProposal,
  setProjectContext,
  updateTask,
  updateTasks,
} from "./db.js";
import { chatCompletion, getModel } from "./llm.js";
import { log } from "./log.js";
import type { TaskStatus, UiAction } from "./types.js";

export interface ToolTrace {
  tool: string;
  input: unknown;
  result: unknown;
}

export interface ChatResult {
  reply: string;
  trace: ToolTrace[];
  uiActions: UiAction[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    rounds: number;
    elapsedMs: number;
    /* LLM往復ごとのルーティング詳細 (#31): 実際に使われたモデル・トークン・キャッシュヒット */
    calls: { model: string; promptTokens: number; completionTokens: number; cachedTokens: number; elapsedMs: number }[];
  };
}

const STATUS_VALUES = ["todo", "inprogress", "review", "done"];

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_tasks",
      description: "タスクをボードに追加する(複数可)",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                assignee: { type: "string", description: "担当者名。未定なら省略" },
                assign_reason: { type: "string", description: "その担当にした理由を一言で (「指名」「API検証の実績」など)。進捗や作業結果は書かない" },
                context: { type: "string", description: "登録に至った経緯・会話で出た論点・決まったこと。相談や議論の流れから登録するときは必ず書く (タイトルだけでは背景が失われる)" },
                due: { type: "string", description: "期限 YYYY-MM-DD。相対表現は今日の日付から解決" },
                blocked_by: { type: "array", items: { type: "integer" }, description: "依存先タスクID(これらが終わるまで着手不可)" },
              },
              required: ["title"],
            },
          },
        },
        required: ["tasks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_tasks",
      description: "既存タスクの状態・担当・タイトル等を更新する(複数可)",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                title: { type: "string" },
                status: { type: "string", enum: STATUS_VALUES },
                assignee: { type: "string" },
                assign_reason: { type: "string", description: "担当変更・却下の判断理由を一言で。期限やlaneだけの変更では渡さない(既存の理由を上書きしてしまう)。進捗や作業結果は書かない — それは summary" },
                summary: { type: "string", description: "現況の一言。カードに表示される(「実装完了 (commit xxx)」「原因調査中」など)。検収の要点はここ、詳細な根拠は経緯メモ(context)へ" },
                lane: {
                  type: ["string", "null"],
                  enum: ["demo", "later", null],
                  description: "台本レーン。demo=デモ台本に必要, later=機能凍結後, null=未分類",
                },
                due: { type: ["string", "null"], description: "期限 YYYY-MM-DD。解除はnull" },
                blocked_by: { type: ["array", "null"], items: { type: "integer" }, description: "依存先タスクID(全置換)。解除はnull" },
                rejected: { type: "boolean", description: "却下(やらない決定)フラグ。却下時はtrue+reasonに根拠。取り消しはfalse" },
              },
              required: ["id"],
            },
          },
        },
        required: ["updates"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_tasks",
      description: "タスクをゴミ箱に入れる(複数可)。実データは残り restore_tasks や画面から復元できる",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "integer" } } },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restore_tasks",
      description: "ゴミ箱に入れたタスクを元に戻す(複数可)",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "integer" } } },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_assignments",
      description: "割り振り案を提案する(人間の承認で確定)。理由には負荷・履歴・期限の根拠を書く",
      parameters: {
        type: "object",
        properties: {
          proposals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                taskId: { type: "integer" },
                assignee: { type: "string" },
                reason: { type: "string", description: "負荷・履歴・スキルに基づく理由" },
              },
              required: ["taskId", "assignee", "reason"],
            },
          },
        },
        required: ["proposals"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_proposals",
      description:
        "承認待ちの割り振り提案を承認/却下する(「全部承認」「#24は却下」等)。taskIdsを省略すると承認待ち全件が対象",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["approve", "reject"] },
          taskIds: { type: "array", items: { type: "integer" }, description: "対象タスクID。省略で全承認待ち" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_task_details",
      description: "タスクの詳細(割り振り理由・経緯メモ・日付)を取得する",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "integer" } } },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task_context",
      description: "タスクの経緯メモを上書き更新する(既存をget_task_detailsで読みマージした全文を渡す)",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
          text: { type: "string", description: "新しいcontext全文" },
        },
        required: ["id", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_activity",
      description: "最近の動き(更新されたタスクと割り振り履歴)を新しい順に取得する。「直近なにをしてた?」等に使う",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "タスクの件数。既定15" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reorder_tasks",
      description:
        "列の並び順を付け替える。並べたい順にタスクIDを渡す(「番号の降順」だけでなく「重要そうな順」など意味のある並びも可)。表示設定ではなく並び順そのものを書き換える操作で、あとから手で並べ直せる。書き忘れたタスクは末尾に残るので消えない",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: STATUS_VALUES, description: "対象の列。省略で全列" },
          ids: { type: "array", items: { type: "integer" }, description: "並べたい順のタスクID" },
        },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compact_archive",
      description: "要約カードを1枚の過去ログに統合する",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_project_context",
      description:
        "プロジェクトの前提情報(全員共有、システムプロンプトに常時含まれる)を上書き更新する。既存内容を踏まえ、ユーザーの要望を反映した新しい全文を渡す",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "新しい前提情報の全文" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_view",
      description: "ボードの表示フィルタを切り替える(「鈴木さんの分だけ見せて」など)。assigneeにnullを渡すと全員表示に戻す",
      parameters: {
        type: "object",
        properties: {
          assignee: { type: ["string", "null"], description: "絞り込む担当者名。全員表示はnull" },
        },
        required: ["assignee"],
      },
    },
  },
];

/** 発言者ラベルが本文として書き写されたときの保険。プロンプトは漏れるがツール契約は漏れない (#87と同じ考え方)。
 * 先頭だけでなく行頭のどこに出ても落とす (経緯メモに段落として混ざる例があった) */
function stripSpeakerLabel<T extends string | undefined | null>(v: T): T {
  if (typeof v !== "string") return v;
  return v.replace(/^\s*\[発言者:[^\]]*\]\s*/gm, "") as T;
}

async function execTool(name: string, args: any, uiActions: UiAction[], events: Set<string>): Promise<unknown> {
  switch (name) {
    case "create_tasks": {
      const created = (args.tasks as any[]).map((t) => {
        const task = createTask(stripSpeakerLabel(t.title), "todo", t.assignee ?? null, stripSpeakerLabel(t.assign_reason) ?? null);
        const extra = {
          ...(t.context ? { context: stripSpeakerLabel(t.context) } : {}),
          ...(t.due ? { due: t.due } : {}),
          ...(t.blocked_by?.length ? { blockedBy: t.blocked_by } : {}),
        };
        return Object.keys(extra).length > 0 ? updateTask(task.id, extra) : task;
      });
      events.add("board");
      return { ok: true, created };
    }
    case "update_tasks": {
      // #69: LLMはdoneに直行できない。「承認」「解決で」等の拡大解釈で検収を飛ばす事故が
      // 実際に起きたため、プロンプトでなくコードで塞ぐ。doneへの唯一の扉は人間の検収UI
      const coerced: number[] = [];
      for (const u of args.updates as any[]) {
        if (u.status === "done") {
          u.status = "review";
          coerced.push(u.id);
        }
      }
      // 一括更新は db 層でまとめて処理 (完了遷移の通知=要約再生成が1回で済む #60)
      const updated = updateTasks(
        (args.updates as any[]).map((u) => {
          // #87: 「差分だけ送る」モデルを前提にしない。全フィールドをエコーバックするモデル
          // (実測: gpt-5.6-terra) だと、変更していない値まで patch に載って既存値を壊す。
          // 現在値と突き合わせ、実際に変わったフィールドだけを通す
          const cur = getTask(u.id);
          const changed = <T>(incoming: T | undefined, current: T) => incoming !== undefined && incoming !== current;
          const assignee = u.assignee === "" ? null : u.assignee; // 空文字は「未割り当て」の意図とみなす
          const lane = u.lane === "" ? null : u.lane;
          const due = u.due === "" ? null : u.due;
          const blockedBy = u.blocked_by === undefined ? undefined : (u.blocked_by ?? null);
          const sameDeps =
            blockedBy !== undefined &&
            JSON.stringify(blockedBy ?? []) === JSON.stringify(cur?.blockedBy ?? []);

          const statusChanged = changed(u.status, cur?.status);
          const assigneeChanged = changed(assignee, cur?.assignee ?? null);
          const rejectedChanged = u.rejected !== undefined && !!u.rejected !== !!cur?.rejected;

          // reason上書きガード: 担当・状態の変更を伴わない更新(lane/due/依存のみ等)で
          // LLMがreasonを添えると既存の割り振り理由が破壊されるため無視する (実事故2件の再発防止)。
          // 空文字のreasonは常に拒否する — 理由を「消す」操作に意味はない
          const keepReason =
            typeof u.assign_reason === "string" &&
            u.assign_reason.trim() !== "" &&
            u.assign_reason !== cur?.assignReason &&
            (assigneeChanged || statusChanged || rejectedChanged);

          return {
            id: u.id,
            patch: {
              ...(changed(stripSpeakerLabel(u.title), cur?.title) ? { title: stripSpeakerLabel(u.title) } : {}),
              ...(statusChanged ? { status: u.status as TaskStatus } : {}),
              ...(assigneeChanged ? { assignee } : {}),
              ...(keepReason ? { assignReason: stripSpeakerLabel(u.assign_reason) } : {}),
              ...(changed(lane, cur?.lane ?? null) ? { lane } : {}),
              ...(changed(due, cur?.due ?? null) ? { due } : {}),
              ...(blockedBy !== undefined && !sameDeps ? { blockedBy } : {}),
              ...(changed(u.summary, cur?.summary ?? null) ? { summary: u.summary } : {}),
              ...(rejectedChanged ? { rejected: !!u.rejected } : {}),
            },
          };
        })
      );
      events.add("board");
      return {
        ok: true,
        updated,
        ...(coerced.length > 0
          ? { note: `#${coerced.join(", #")} は done を指定されましたが review に置きました。done への確定はボードの検収チェック(人間)のみが行えます。その旨をユーザーに伝えてください` }
          : {}),
      };
    }
    case "restore_tasks": {
      const restored = (args.ids as number[]).map((id) => restoreTask(id));
      events.add("board");
      return { ok: true, restored };
    }
    case "delete_tasks": {
      // #102: 実データは消さずゴミ箱へ。誤解釈で消えても取り返しがつくようにする
      const results = (args.ids as number[]).map((id) => ({ id, trashed: trashTask(id) }));
      // 復元できることは毎回文章で説明しない (くどい)。#xx リンクから詳細パネルを開けば「戻す」がある
      events.add("board");
      return { ok: true, results };
    }
    case "propose_assignments": {
      const created = (args.proposals as any[]).map((p) => createProposal(p.taskId, p.assignee, p.reason));
      events.add("proposals");
      return { ok: true, proposals: created };
    }
    case "resolve_proposals": {
      const pending = listPendingProposals();
      const targets = args.taskIds?.length
        ? pending.filter((p) => (args.taskIds as number[]).includes(p.taskId))
        : pending;
      if (targets.length === 0) return { ok: false, error: "対象の承認待ち提案がありません" };
      const resolved = targets.map((p) => resolveProposal(p.id, args.action === "approve" ? "approved" : "rejected"));
      events.add("proposals");
      if (args.action === "approve") events.add("board");
      return { ok: true, action: args.action, resolved: resolved.map((p) => ({ taskId: p?.taskId, assignee: p?.assignee })) };
    }
    case "get_task_details": {
      const details = (args.ids as number[]).map((id) => getTask(id) ?? { id, error: "not found" });
      return { tasks: details };
    }
    case "update_task_context": {
      const updated = updateTask(args.id, { context: stripSpeakerLabel(args.text) ?? "" });
      if (!updated) return { error: `task #${args.id} not found` };
      events.add("board");
      return { ok: true, id: updated.id };
    }
    case "get_activity": {
      return recentActivity(Math.min(Number(args.limit) || 15, 30));
    }
    case "reorder_tasks": {
      const r = reorderTasks(args.ids ?? [], args.status);
      events.add("board");
      // 指定漏れがあったことはLLMに伝える (黙って末尾に置くと「並べたつもり」とズレる)
      return {
        ok: true,
        ...r,
        ...(r.appended > 0 ? { note: `${r.appended}件は順番の指定に含まれていなかったので末尾に置きました` } : {}),
      };
    }
    case "compact_archive": {
      try {
        const result = await compactArchive();
        events.add("board");
        return { ok: true, ...result };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    }
    case "update_project_context": {
      setProjectContext(args.text ?? "");
      return { ok: true };
    }
    case "set_view": {
      uiActions.push({ type: "set_filter", assignee: args.assignee ?? null });
      return { ok: true };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

function buildSystemPrompt(taskFocus?: ReturnType<typeof getTask>, speaker?: string, view?: string): string {
  const loads = memberLoads();
  const history = assignmentHistory();
  const pending = listPendingProposals();
  // キャッシュ友好の並び: 静的な内容(人格/ルール/思想)を先頭に固定し、動的な内容(索引/履歴/カード)を末尾へ。
  // プロンプトキャッシュはプレフィックス一致なので、先頭が安定しているほどヒット部分が伸びる。
  return [
    "あなたはチームのタスク管理ボード「ChatBan」のアシスタント。日本語で簡潔に応答する。",
    "",
    "## 行動ルール",
    "- まず依頼か相談かを判別する。明確なアクション依頼(「〜を追加して」「〜やらないと」「タスク: 〜」「〜に対応したい」)だけを、確認を挟まず即 create_tasks で登録する。テンポ優先はこの依頼に限る。",
    "- 質問・意見募集・感想(「どう思う?」「いいのかな?」「なんで〜?」、画像やPDFを見せての問いかけ等)は相談。タスク化せず、内容に踏み込んで会話で応える。タスクにする価値がありそうなら会話の末尾に「タスクに積みますか?」と一言添えるだけにし、登録は次のユーザー発言を待つ。",
    "- 依頼か相談か迷ったら相談として扱う (誤登録の削除コストより会話で受ける方が安い)。",
    "- create_tasks / update_tasks の報告では、必ず割り当てられたタスクID を「#12として登録しました」の形式で明記する (ユーザーは以後この番号で参照する)。",
    "- 相談・議論の流れからタスクを登録するときは、create_tasks の context に登録に至った経緯を要約して入れる。経緯のない単発の明確な依頼では省略可。",
    "- 「Nは◯◯に」のような指名は update_tasks で即実行してよい (reason は「指名」)。",
    "- 「いい感じに振っといて」のような委任は propose_assignments を使う。勝手に assignee を確定しない。理由には負荷と履歴を必ず引用する。",
    "- 提案への「承認」「全部承認で」「#Nは却下」は resolve_proposals を使う。update_tasks で直接 assignee を書いて代用しない (提案が残留してUIに表示され続ける)。",
    "- 「終わりました」等の完了報告は status=review に置き、「Reviewに置いたので確認OKなら承認を」と一言返す。勝手に done にしない (doneは検収済みの意味で、即アーカイブされる)。発言者名が分かればその人のタスクを優先して曖昧参照を解決する。",
    "- あなたは done に変更できない (ツールが受け付けず review に置き換わる)。完了・却下・承認はすべて status=review に置き、done への確定はボードのReview列の検収チェック(人間の操作)だけが行う。「doneにして」「まとめて承認」と言われたら review に置いた上で「確定はReview列の検収チェックからお願いします」と案内する。",
    "- 「◯◯さんの分だけ見せて」は set_view を使う。",
    "- チーム共通の前提・決まりごと(締切、方針、用語など)を伝えられたら update_project_context で前提情報に反映する。",
    "- 特定タスクの経緯・決定事項・補足(「#22は◯◯方式でいくことにした」等)は update_task_context でそのタスクの経緯メモに記録する。",
    "- assign_reason は「なぜこの担当か」、summary は「いまどうなっているか」。別の情報なので混ぜない。進捗・完了報告は summary に一言で書き、詳細な根拠は経緯メモ(context)に書く。",
    "- 「ログ整頓して」は compact_archive を使う。完了タスクのアーカイブは自動なので手動操作は不要。",
    "- 削除と却下は文脈で使い分ける: 誤登録・重複・ダミー(「消して」「間違えた」)は delete_tasks (ゴミ箱行きで復元可。返答で復元方法を説明する必要はない)。やらない決定(「見送り」「却下」「やらないことにした」)は削除せず update_tasks で status=review + rejected=true にし、reason に却下の根拠を書いて「却下としてReviewに置きました。検収で確定します」と返す (検収後、決定として要約アーカイブに残る)。",
    "- 「消して」がタスクそのものを指すのか、タイトルや文言の一部の修正を指すのか曖昧なときは、操作せず確認する (実例:「#95だけ発言者の話が入っていて不自然なので消せますか?」はタイトルの修正依頼だったが、タスクごと削除してしまった)。",
    "- ボードから退場するもの(完了・却下)は必ずReviewを通り、人間の検収チェックで確定する。チャットからdoneへ直行する経路は存在しない。",
    "- 「後回し」「今はやらない」「凍結後で」は却下ではない: update_tasks で lane を \"later\" にするだけ。status は変えない (done にするとアーカイブに吸い込まれる)。デモに必要なら lane を \"demo\" に。",
    "- 「金曜まで」「明日まで」等の期限表現は今日の日付から YYYY-MM-DD に解決して due に入れる。期限が近い/過ぎたタスクはレポートや割り振り提案で優先的に言及する。",
    "- 画像やPDFが添付されたら内容を読み取って会話・操作に活かす。重要な情報(バグの症状、決定事項、資料の要点)はタスクの context や前提情報に文字で蒸留して記録する。ファイル原本はどこにも保存されないため、後から参照が必要な内容は必ず文字にして残す。",
    "- 「#AはB待ち」「Bが終わってから」等の依存表現は blocked_by に依存先IDを登録する(複数可)。索引の dep がそれ。依存先が未完了のタスクは割り振り提案の対象にせず、レポートでは「#N待ち」と添える。",
    "- 操作後は結果を一言で報告する。長い説明はしない。",
    "",
    "## 設計思想 (構造カスタマイズの要望が来たときの応対)",
    "ChatBanは「会話が構造の代わりをする」ツール。ステータス4列は固定で、カスタム列・優先度フィールド・タグの追加要望には応じない。",
    "代わりに以下へ誘導する (どれが適切かはニーズを聞いて判断):",
    "- 状態を細かく刻みたい (「検証待ち」等) → その情報はタスクのタイトルや理由欄に書く。または「検証」を独立タスクに分割する",
    "- 分類したい → lane (demo/later) か、タイトルの付け方で表現する",
    "- 優先したい → 並び順 (「これ上にして」) で表現する",
    "断るときは設計理由 (語彙が固定だから一言が正確に通じる) を一言添える。",
    "",
    // ---- ここから動的セクション ----
    // #50: ボード状態は「基準スナップショット+変更イベント追記」でプレフィックスを安定させる (promptState.ts)。
    // 温かい間はバイト不変のまま伸びるのでキャッシュが基準部分まで効く。TTL超過時のみ再ベースライン。
    getBoardPromptSection(),
    "",
    "## メンバーと現在の担当タスク数(未完了)",
    JSON.stringify(loads),
    "",
    "## 過去の割り振り履歴 (類似タスクの参考にする)",
    JSON.stringify(history.slice(0, 10).map((h) => ({ t: h.taskTitle.slice(0, 30), a: h.assignee }))),
    "",
    pending.length ? `## 承認待ちの割り振り提案\n${JSON.stringify(pending)}` : "",
    // #93: いま見ている画面。発言者と同じくメタ情報 (本文には混ぜない)。
    // 「これ何?」「これ高くない?」のような指示語をタブの文脈で解決するために渡す
    VIEW_HINTS[view ?? ""] ?? "",
    // 発言者はメタ情報。本文に混ぜるとタスクへ書き写されるので、ここで「書き写すな」と添えて渡す
    speaker
      ? `\n## いまの発言者: ${speaker}\n「終わりました」等の曖昧な言い回しの主語はこの人。これはメタ情報であって発言内容ではないので、タスクのタイトル・経緯メモ・理由には書き写さないこと。`
      : "",
    taskFocus
      ? [
          "",
          `## いま注目しているタスク (このチャットは #${taskFocus.id} 専用)`,
          JSON.stringify(taskFocus),
          `- 「これ」「このタスク」等の指示語は #${taskFocus.id} を指す。`,
          `- この会話で決まったこと・分かったことは update_task_context で #${taskFocus.id} の経緯メモに反映する (既存contextを読んでマージ)。`,
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// #93: 画面ごとの文脈。チャットは常設 (#74) なので、ボード以外を見ているときも
// 「その画面の話」ができないと噛み合わない。操作できないものは断り方まで決めておく。
// 発言者と同じくメタ情報なので、動的セクションの末尾に置く (キャッシュのプレフィックスを崩さない)
const VIEW_HINTS: Record<string, string> = {
  context: [
    "",
    "## いま見ている画面: 📋前提情報",
    "チームの前提情報を見ている。「ここに◯◯を足して」等は update_project_context で反映する。",
  ].join("\n"),
  metrics: [
    "",
    "## いま見ている画面: 📊コスト",
    "AI利用のコストを見ている。「これ高い?」等はこの画面の話。個々の金額はシステムプロンプトに無いので、憶測で数字を言わず画面の値を読むよう促す。",
  ].join("\n"),
  audit: [
    "",
    "## いま見ている画面: 📜監査",
    "会話・LLM呼び出し・割り振り履歴のログを見ている。「直近何やってた?」等は get_activity で実データを見てから答える。",
  ].join("\n"),
  trash: [
    "",
    "## いま見ている画面: 🗑ゴミ箱",
    "削除したタスクを見ている。「#xxを戻して」は restore_tasks で復元する。",
  ].join("\n"),
  settings: [
    "",
    "## いま見ている画面: ⚙設定",
    "モデル設定を見ている。設定を変えるツールは持っていないので、頼まれても実行せず、意味を説明したうえで「この画面から変更してください」と案内する (例: 対話モデルは応答速度とプロンプトキャッシュが効くので日付つきIDで固定するのが安全)。",
  ].join("\n"),
};

const TOOL_LABELS: Record<string, string> = {
  create_tasks: "タスクを追加",
  update_tasks: "タスクを更新",
  delete_tasks: "ゴミ箱へ移動",
  restore_tasks: "ゴミ箱から復元",
  propose_assignments: "割り振りを検討",
  set_view: "ビューを切替",
  update_project_context: "前提情報を更新",
  compact_archive: "過去ログを整頓",
  get_activity: "最近の動きを確認",
  reorder_tasks: "並び順を変更",
  get_task_details: "タスク詳細を取得",
  update_task_context: "経緯メモを更新",
  resolve_proposals: "提案を承認/却下",
};

// #68: 添付は「保存しない蒸留型」— 画像もPDFもそのままLLMに渡し(前処理なし、原本はどこにも残さない)、
// 重要な情報はAIが context / 前提情報に文字で蒸留する (Doneアーカイブ・チャット揮発化と同じ思想)。
// PDFはOpenAIのfileコンテンツパート直投げがOrcaRouter経由で通ることを実測済み (gpt-5.4-miniはfile入力対応)
export interface ChatAttachment {
  kind: "image" | "pdf";
  name: string;
  dataUrl: string;
}

function buildAttachmentParts(attachments: ChatAttachment[]): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  return attachments.map((a) =>
    a.kind === "image"
      ? { type: "image_url", image_url: { url: a.dataUrl } }
      : ({ type: "file", file: { filename: a.name, file_data: a.dataUrl } } as any)
  );
}

/** AI提案チップ (#75): ボードの文脈から「いま価値のある操作」を提案する。
 * チャットと同一のシステムプロンプト+ツール定義で呼ぶことで、キャッシュ済みプレフィックスに相乗りする */
// 提案はボード状態だけの関数なので、同じ状態なら作り直さない。
// StrictModeの二重実行・複数タブ・F5連打・🆕新しい会話のいずれでもLLMを再度叩かずに済む
// (クライアント側を直しても他の経路が残るため、費用の歯止めはサーバー側に置く)
let suggestCache: { key: string; value: { label: string; message: string }[]; at: number } | null = null;
const SUGGEST_TTL_MS = 5 * 60 * 1000;
let suggestInflight: Promise<{ label: string; message: string }[]> | null = null;

export async function generateSuggestions(): Promise<{ label: string; message: string }[]> {
  // 新規プロジェクト(ボードが空)では読むべき文脈が無い。LLMを呼ばずに空で返す
  // — UI側は「方針を伝える」導線だけを出す (#86)
  if (listTasks().length === 0 && listSummaryCards().length === 0) return [];
  const systemPrompt = buildSystemPrompt();
  if (suggestCache && suggestCache.key === systemPrompt && Date.now() - suggestCache.at < SUGGEST_TTL_MS) {
    return suggestCache.value;
  }
  // 同時到着 (StrictModeの二重実行はほぼ同時に来る) は1本にまとめる
  if (suggestInflight) return suggestInflight;
  suggestInflight = generateSuggestionsUncached(systemPrompt)
    .then((value) => {
      suggestCache = { key: systemPrompt, value, at: Date.now() };
      return value;
    })
    .finally(() => {
      suggestInflight = null;
    });
  return suggestInflight;
}

async function generateSuggestionsUncached(systemPrompt: string): Promise<{ label: string; message: string }[]> {
  const res = await chatCompletion("suggest", getModel("main"), {
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          'ボードの現状を読んで、いまユーザーにとって価値のある操作を最大3つ提案して。ツールは呼ばない。出力はJSON配列のみ: [{"label":"絵文字+15字以内の短文","message":"チャットにそのまま投げる依頼文"}]。期限接近・依存解除・検収たまり・未割り当てなど文脈が根拠のものを優先。',
      },
    ],
    tools,
  });
  const text = res.choices[0].message.content ?? "";
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s: any) => typeof s?.label === "string" && typeof s?.message === "string")
      .slice(0, 3);
  } catch {
    return [];
  }
}

export async function runChatTurn(
  userMessage: string,
  history: { role: "user" | "assistant"; content: string }[],
  onEvent: (kind: "board" | "proposals") => void,
  onProgress?: (label: string) => void,
  taskFocusId?: number,
  speaker?: string,
  attachments?: ChatAttachment[],
  view?: string
): Promise<ChatResult> {
  const t0 = Date.now();
  const taskFocus = taskFocusId != null ? getTask(taskFocusId) : undefined;
  // #68: 添付はそのままコンテンツパートでLLMへ (画像=vision / PDF=file直投げ)。原本は保存しない
  const fileParts = attachments && attachments.length > 0 ? buildAttachmentParts(attachments) : [];
  // #14: 発言者の記名。「終わりました」等の曖昧参照を解決するためのメタ情報であって発言内容ではない。
  // 以前は本文の先頭に [発言者: xxx] を足していたが、LLMがそれをタスクのタイトルや経緯メモへ
  // そのまま書き写す事故が起きた (#95のタイトルに混入)。メタ情報は本文に混ぜず、
  // システムプロンプト側に「書き写すな」と添えて置く
  const baseText =
    userMessage +
    (fileParts.length > 0
      ? `\n[添付${fileParts.length}件 (${attachments!.map((a) => a.name).join(", ")}) — 内容を読み取って活用すること]`
      : "");
  const userContent: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"] =
    fileParts.length > 0 ? [{ type: "text", text: baseText }, ...fileParts] : baseText;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(taskFocus, speaker, view) },
    ...history.slice(-20),
    { role: "user", content: userContent },
  ];
  const trace: ToolTrace[] = [];
  const uiActions: UiAction[] = [];
  const usage: ChatResult["usage"] = { promptTokens: 0, completionTokens: 0, rounds: 0, elapsedMs: 0, calls: [] };
  let reply = "";

  for (let round = 0; round < 8; round++) {
    const c0 = Date.now();
    const res = await chatCompletion("chat", getModel("main"), { messages, tools });
    usage.rounds++;
    usage.promptTokens += res.usage?.prompt_tokens ?? 0;
    usage.completionTokens += res.usage?.completion_tokens ?? 0;
    usage.calls.push({
      model: res.model ?? getModel("main"),
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      cachedTokens: (res.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0,
      elapsedMs: Date.now() - c0,
    });
    const msg = res.choices[0].message;
    messages.push(msg);
    if (msg.tool_calls?.length) {
      const events = new Set<string>();
      for (const tc of msg.tool_calls) {
        if (tc.type !== "function") continue;
        let args: any = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* 引数パース失敗時は空で実行し、エラーはツール結果に出る */
        }
        log("tool", `${tc.function.name} ${tc.function.arguments?.slice(0, 200)}`);
        onProgress?.(TOOL_LABELS[tc.function.name] ?? tc.function.name);
        const result = await execTool(tc.function.name, args, uiActions, events as Set<string>);
        trace.push({ tool: tc.function.name, input: args, result });
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      for (const e of events) onEvent(e as "board" | "proposals");
      continue;
    }
    reply = typeof msg.content === "string" ? msg.content : "";
    break;
  }
  usage.elapsedMs = Date.now() - t0;
  return { reply, trace, uiActions, usage };
}
