import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiFetch, type Project } from "./api";
import { ensureProjectInUrl, gotoProject, projectIdFromUrl } from "./project";
import Board, { type MovePayload } from "./components/Board";
import Chat, { type Suggestion } from "./components/Chat";
import ContextView from "./components/ContextView";
import SettingsView from "./components/SettingsView";
import TrashView from "./components/TrashView";
import TaskDetailPanel from "./components/TaskDetailPanel";
import { useChatTurn } from "./hooks/useChatTurn";
import type { Attachment } from "./hooks/useAttachments";
import { socket } from "./socket";
import { parseTaskJump } from "./taskJump";
import type { ChatEntry, CustomLane, FoldedTask, Task } from "./types";

interface Toast {
  tone?: "error" | "info";
  action?: { label: string; run: () => void };
  message: string;
  retry?: () => void;
}


export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [folded, setFolded] = useState<FoldedTask[]>([]);
  // #19: 有効な任意レーン。**ボードと一緒に届く** — 別のAPIで取りに行くと、
  // レーン名を変えた直後だけ列とカードの表示がズレる (同じ配信物に載せておけば起きない)
  const [lanes, setLanes] = useState<CustomLane[]>([]);
  // #212: 上流に断られたまま (残高切れ・キー失効・混雑)。原因は断定しない — 見分けて見せる必要が無い
  const [llmRefused, setLlmRefused] = useState(false);
  // #213: 添付の入口。公開デモでは閉じる (既定は開いている)
  const [canAttach, setCanAttach] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  // #21/#33: ボード以外の閲覧ビューへの遷移 (簡易タブ)
  const [view, setView] = useState<"board" | "context" | "settings" | "trash">("board");

  // #93: チャットは常設なので、いま見ている画面をメタ情報としてLLMへ渡す (発言者と同じ扱い)
  const viewRef = useRef(view);
  viewRef.current = view;
  // #14 → #90 → #180: なりきりの切替UIを撤去したあとも発言者(speaker)の配線だけ残していたが、
  // 個人利用に特化したので概念ごと外した (話しかけてくるのは常に持ち主ひとり)

  // メインチャット: ライフサイクル(送信/考え中/停止/タイムアウト/再送)は共有フックに集約 (#23/#28/#29/#30)
  const mainChat = useChatTurn({
    request: (m, h, signal, attachments) => api.chat(m, h, signal, attachments, viewRef.current),
    onResponse: (res) => {
      for (const a of res.uiActions) {
        if (a.type === "ask") setAskOptions(a.options);
      }
    },
  });
  // AIが添えた簡易返信ボタン。DBにもログにも残さず、次の発言で消える。
  // 「押されるまで待っている状態」を作らないための割り切り — ボタンは入力の近道であって、
  // 承認の経路ではない (経路にすると #127 で外した提案カードに逆戻りする)
  const [askOptions, setAskOptions] = useState<string[]>([]);
  // #86: プロジェクト一覧。切り替えるとボード・チャット・前提情報が総取っ替えになる
  const [projects, setProjects] = useState<Project[]>([]);
  const loadProjects = useCallback(() => {
    api
      .projects()
      .then((d) => {
        setProjects(d.projects);
        // 素の / で来たら既定プロジェクトのURLへ置き換える (以降はURLが表示中を持つ)
        ensureProjectInUrl(d.projects.find((p) => p.active)?.id ?? d.projects[0]?.id ?? 1);
      })
      .catch(() => {});
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const b = await api.board();
      setTasks(b.cards);
      setFolded(b.folded ?? []);
      setLanes(b.lanes ?? []);
      setLlmRefused(!!b.llmRefused);
      setCanAttach(b.attachments !== false);
    } catch (e: any) {
      setLoadError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // #173 → #180: ログイン/ログアウト時のソケット繋ぎ直しはここにあったが、認証ごと廃止した。
  // 「繋ぎ直した直後に読み直して追いつく」処理 (下の onConnect) は**残す** —
  // あれはログイン起因ではなく、通信断からの復帰でも同じ取りこぼしが起きるため

  useEffect(() => {
    reload();
    // 繋ぎ直した直後は、切れていた間の board:changed を取りこぼしている。読み直して追いつく
    let everConnected = socket.connected;
    const onConnect = () => {
      if (everConnected) {
        reload();
        loadProjects();
      }
      everConnected = true;
    };
    // #72: メインチャットはリロードで新規 (会話は作業記憶。重要事項はプロジェクト前提/カード経緯メモに
    // 蒸留されて残り、生ログはDBに保存済みで query_log から引ける)。カードチャットは経緯ログなので復元維持
    const onBoard = (p: { cards: Task[]; folded?: FoldedTask[]; lanes?: CustomLane[]; llmRefused?: boolean; attachments?: boolean }) => {
      setTasks(p.cards);
      if (p.folded) setFolded(p.folded);
      // **空配列も反映する。**`if (p.lanes)` にすると最後の1本を畳んだときだけ列が残る
      if (p.lanes) setLanes(p.lanes);
      // 断られた/直った の変化があったときにサーバーが流してくれるので、直れば消える
      setLlmRefused(!!p.llmRefused);
      setCanAttach(p.attachments !== false);
    };
    // Done要約カードの非同期再生成中インジケータ (#56)
    // プロジェクトが切り替わったら全部読み直す (他のタブ/端末での切り替えにも追従する)
    const onProject = (p: { projects: Project[] }) => {
      setProjects(p.projects);
      // いま開いているプロジェクトが消えていたら、そのURLに留まらない。
      // 残っていても操作はすべて 400 (project not found) になり、
      // 「古いボードが表示されているのに何も動かない」状態になる (自動レビュー指摘)
      const here = projectIdFromUrl();
      if (here !== null && !p.projects.some((x) => x.id === here)) {
        const fallback = p.projects.find((x) => x.active) ?? p.projects.find((x) => !x.archived) ?? p.projects[0];
        if (fallback) gotoProject(fallback.id);
      }
    };
    socket.on("connect", onConnect);
    socket.on("board:changed", onBoard);
    socket.on("project:changed", onProject);
    loadProjects();
    return () => {
      socket.off("connect", onConnect);
      socket.off("board:changed", onBoard);
      socket.off("project:changed", onProject);
    };
  }, [reload, loadProjects]);

  // 列内挿入位置から新しいsort値を計算 (前後の中間値。端は±1)
  const moveTask = useCallback((move: MovePayload) => {
    setTasks((prev) => {
      const snapshot = prev;
      const task = prev.find((t) => t.id === move.id);
      if (!task) return prev;
      const colWithout = prev
        .filter((t) => t.status === move.status && t.id !== move.id)
        .sort((a, b) => a.sort - b.sort || a.id - b.id);
      const idx = Math.min(move.index, colWithout.length);
      const before = colWithout[idx - 1];
      const after = colWithout[idx];
      let sort: number;
      if (!before && !after) sort = task.sort;
      else if (!before) sort = after!.sort - 1;
      else if (!after) sort = before.sort + 1;
      else sort = (before.sort + after.sort) / 2;

      const doPatch = () =>
        api.updateTask(move.id, { status: move.status, sort }).catch((e) => {
          setTasks(snapshot); // ロールバック
          setToast({ message: `移動に失敗しました: ${e?.message ?? e}`, retry: doPatch });
        });
      doPatch();
      return prev.map((t) => (t.id === move.id ? { ...t, status: move.status, sort } : t));
    });
  }, []);

  // アーカイブ済みカードの詳細表示用 (#59: 要約カードの#xxリンクから開く)
  const [archivedTask, setArchivedTask] = useState<Task | null>(null);
  // #226: 経緯メモの本文だけを取りに行く先 (板の配信には載っていない)
  const [detailFull, setDetailFull] = useState<Task | null>(null);
  const openTask = useCallback(
    (id: number) => {
      if (tasks.some((t) => t.id === id)) {
        setDetailTaskId(id);
        return;
      }
      api
        .getTask(id)
        .then((t) => {
          setArchivedTask(t);
          setDetailTaskId(id);
        })
        .catch(() => setToast({ message: `#${id} は存在しません` }));
    },
    [tasks]
  );

  // #226: 開いているカードの経緯メモを取りに行く。**版が変わったら取り直す** —
  // 依存に contextVersion を入れてあるので、チャット/MCP/他のタブが書き換えても追随する。
  // 板の配信には版だけが載っているので、本文を配らずに鮮度が保てる
  const detailContextVersion =
    detailTaskId !== null ? tasks.find((t) => t.id === detailTaskId)?.contextVersion : undefined;
  useEffect(() => {
    if (detailTaskId === null) {
      setDetailFull(null);
      return;
    }
    let alive = true;
    api
      .getTask(detailTaskId)
      .then((t) => {
        if (alive) setDetailFull(t);
      })
      // 取れなくても本文が出ないだけ。パネル自体は板の配信で開いている
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [detailTaskId, detailContextVersion]);

  // 詳細パネルの「ボードで表示」: パネルは開いたまま、スクロール→フラッシュ (Slackスレッド風の常駐)
  const jumpToBoard = useCallback((id: number) => {
    setTimeout(() => {
      const el = document.querySelector(`[data-testid="task-card-${id}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("task-flash");
      setTimeout(() => el.classList.remove("task-flash"), 1700);
    }, 60);
  }, []);

  // #197: 番号だけの発言 (`193` / `#193`) は、LLMを呼ばずにそのカードを開く。
  // 「検索窓が欲しい、とくに番号でアクセスしたいケースが増えてきた」への答えだが、
  // **専用の検索窓は作らない** — チャットは常設 (#74) でどこからでも打てるし、
  // 開く仕掛け (openTask / jumpToBoard) は要約カードのリンク (#59) と依存チップ (#111) で
  // 既に在る。足りないのは番号を打ち込む入口だけだった。
  //
  // 番号が存在しないときは**普通の発言としてLLMへ渡す** (zio判断)。
  // 「2026」のような数字だけの発言を横取りしない
  const taskExists = useCallback(
    async (id: number) => {
      if (tasks.some((t) => t.id === id)) return true; // ボード上なら往復しない
      // アーカイブ済みかもしれない。要約カードの #xx リンクと同じ経路で確かめる
      return api
        .getTask(id)
        .then(() => true)
        .catch(() => false);
    },
    [tasks]
  );

  const sendFromChat = useCallback(
    async (message: string, attachments?: Attachment[]) => {
      setAskOptions([]);
      // 添付があるときは番号ジャンプにしない (画像を貼って「193」は、その画像についての発言)
      const id = attachments?.length ? null : parseTaskJump(message);
      if (id !== null && (await taskExists(id))) {
        // DBには残さない (リロードで消えてよい)。LLMを通っていないので保存の経路が無い。
        //
        // ただし**次のターンではLLMの履歴に入る**。useChatTurn が履歴から外すのは
        // pending と error だけで、ここで積む2行はどちらでもない (types.ts の
        // 「履歴としてLLMには送らない」は error 行の話)。
        // それでよい — 画面に出ているものが見えていないと、「さっき#193を開いたよね」が
        // 噛み合わなくなる。会話ではないから消す、より、見えているものは見せる、を採る
        mainChat.setLog((prev) => [
          ...prev,
          { role: "user", content: message },
          { role: "assistant", content: `#${id} をひらきます。` },
        ]);
        openTask(id); // 存在は確認済み。ボードに無ければ内部でもう一度引くが、番号を打つ頻度なら安い
        jumpToBoard(id); // ボード上にあればスクロールして光らせる (無ければ何もしない)
        return;
      }
      mainChat.send(message, attachments);
    },
    [mainChat.send, mainChat.setLog, taskExists, openTask, jumpToBoard]
  );

  // Review→Doneの検収 (#57)。カードの検収OKチェックはマーキングのみで、
  // 「検収済みN件をDoneへ」ボタンで初めて確定する (Doneへの唯一のUI経路。D&Dは禁止)
  //
  // #108: 印はDBに持つ (checked_at)。以前は画面のローカル状態で、リロードで消えていた。
  // 一塊の完了を管理するフラグなので、確かめた記録として残す。
  // 書けるのはこの経路(REST)だけ — エージェントはSQL窓口で読めるが付けられない
  const approvedIds = useMemo(
    () => new Set(tasks.filter((t) => t.checkedAt).map((t) => t.id)),
    [tasks]
  );
  // 他の更新と同じく楽観更新 (moveTaskと同じ形): 先に画面へ反映し、失敗したら戻す
  const toggleApproved = useCallback((id: number) => {
    setTasks((prev) => {
      const snapshot = prev;
      const on = !prev.find((t) => t.id === id)?.checkedAt;
      api.setChecked(id, on).catch((e) => {
        setTasks(snapshot);
        setToast({ message: `検収の記録に失敗しました: ${e?.message ?? e}` });
      });
      return prev.map((t) => (t.id === id ? { ...t, checkedAt: on ? new Date().toISOString() : null } : t));
    });
  }, []);
  const commitApproved = useCallback(() => {
    const ids = tasks.filter((t) => t.status === "review" && t.checkedAt).map((t) => t.id);
    if (ids.length === 0) return;
    // 複数前提の一括確定API (#60): N件でも要約再生成は1回
    api
      .approveTasks(ids)
      // #1: 条件を満たさないものはサーバーが弾いて note で理由を返す。
      // HTTPは200なので、ここで見ないと「押したのに動かない」だけが残る
      .then((r) => {
        if (!r.ok && r.note) setToast({ message: r.note });
      })
      .catch((e) => {
        setToast({ message: `検収に失敗しました: ${e?.message ?? e}` });
      });
  }, [tasks]);


  // ✨AI提案チップ (#75): ボードの文脈を読んだ提案を非同期で追加 (固定チップは即時表示の保険)
  const [aiSuggestions, setAiSuggestions] = useState<Suggestion[]>([]);
  const fetchAiSuggestions = useCallback(() => {
    // POST なのは副作用があるから (有料のLLM呼び出しが走る。#180)
    apiFetch("/api/suggestions", { method: "POST" })
      .then((r) => r.json())
      .then((d) =>
        setAiSuggestions(
          ((d.suggestions ?? []) as { label: string; message: string }[]).map((s) => ({
            label: `✨ ${s.label}`,
            message: s.message,
          }))
        )
      )
      .catch(() => {});
  }, []);
  useEffect(() => {
    fetchAiSuggestions();
  }, [fetchAiSuggestions]);

  // 🆕 新しい会話: F5せずにチャットを初期状態(チップ+AI提案)へ戻す (#72追補)
  const resetChat = useCallback(() => {
    mainChat.stop();
    mainChat.setLog([]);
    setAiSuggestions([]);
    fetchAiSuggestions();
  }, [mainChat.stop, mainChat.setLog, fetchAiSuggestions]);

  // 「何を話しかければいいか分からない人」向けのユースケース導線。ボード状態で出し分ける。
  // #93: チャットは常設(#74)なので、ボード以外を見ているときはその画面の話ができるチップを出す
  const suggestions: Suggestion[] = [];
  const VIEW_SUGGESTIONS: Partial<Record<typeof view, Suggestion[]>> = {
    context: [{ label: "📋 前提情報に追記したい", message: "前提情報に追記したいことがある。いまの内容を踏まえて相談したい" }],
    // #181: 📊コスト と 📜監査 のチップはタブごと撤去。「直近なにをしてた?」はボード側にある
    trash: [{ label: "↩ 消したものを戻したい", message: "ゴミ箱に入れたカードを戻したい" }],
    settings: [{ label: "📁 プロジェクトを整理したい", message: "プロジェクトの整理について相談したい (無効化・リネーム・削除)" }],
  };
  // 新規プロジェクト(まだ何も無い)では、レポートも割り振りも中身が無い。
  // 最初にやるべきは方針を伝えること — 前提情報はAIの振る舞いを決める介入チャネル (#81) なので、
  // ここを埋めるところから始まるのが自然。チップは1つに絞る
  const isEmptyBoard = tasks.length === 0 && folded.length === 0;
  if (view !== "board") {
    suggestions.push(...(VIEW_SUGGESTIONS[view] ?? []));
  } else if (isEmptyBoard) {
    suggestions.push({
      label: "🧭 このプロジェクトの方針を伝える",
      message: "このプロジェクトの前提や方針を登録したい。何を教えればいい?",
    });
  } else {
    suggestions.push({ label: "📋 現状をレポートして", message: "ボードの現状を簡潔にレポートして" });
    if (tasks.filter((t) => t.status === "review").length > 0) {
      suggestions.push({ label: "👀 レビュー待ちをまとめて", message: "レビュー中のカードの状況をまとめて" });
    }
    if (tasks.filter((t) => t.status === "todo").length === 0) {
      suggestions.push({ label: "💡 次のタスク候補を挙げて", message: "次にやるべきタスクの候補を挙げて" });
    }
    suggestions.push(...aiSuggestions);
  }

  // #179: 担当フィルタは撤去した。いま絞り込みは無く、ボードは常に全件を出す。
  // 作り直すなら「LLMにIDの集合を返させて、押した瞬間に確定する」形になる (CLAUDE.md の将来案) —
  // 述語で絞る方式に戻さないのは、フィルタを掛けたまま放置したときに
  // 後から増えたカードが埋もれるため (#41/#90 で気にしていた「隠れたものが無いことになる」)
  const visibleTasks = [...tasks].sort((a, b) => a.sort - b.sort || a.id - b.id);

  // パネルで開いているカードが完了→アーカイブでtasksから消えても、パネルは最後のスナップショットで
  // 開き続ける (#53: AIの「完了にしました」返答が見えないまま消えるのを防ぐ)。閉じるのは✕のみ
  const foundDetailTask = detailTaskId !== null ? tasks.find((t) => t.id === detailTaskId) : undefined;
  const lastDetailTaskRef = useRef<Task | undefined>(undefined);
  if (foundDetailTask) lastDetailTaskRef.current = foundDetailTask;
  const detailBase =
    detailTaskId !== null
      ? foundDetailTask ?? (archivedTask?.id === detailTaskId ? archivedTask : undefined) ?? lastDetailTaskRef.current
      : undefined;
  // #226: 経緯メモの本文は板の配信に載っていない (ペイロードの96%を占めていたので外した)。
  // 開いたときに取りに行き、**版 (contextVersion) が変わったら取り直す** —
  // チャットやMCPが書き換えても、板の配信に載る版だけで気づける。
  // 新しい仕組みは作らない: 取得先はアーカイブ済みカードと同じ GET /api/cards/:id
  const detailTask =
    detailBase && detailFull?.id === detailBase.id ? { ...detailBase, context: detailFull.context } : detailBase;
  const detailArchived = detailTaskId !== null && !foundDetailTask && !!detailTask;

  // #97: プロジェクト切替はページ遷移 (/p/<id>) にしたので、画面の持ち越しを個別に消す処理は不要になった。
  // 「切り替えたら詳細パネルもフィルタも検収チェックも落とす」を手で書いていたが、
  // URLに状態を持たせたら読み込み直しで自然に消える — 状態の置き場所を変えると後始末が消える例

  return (
    <div className="flex h-full bg-slate-100 text-slate-900">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-y-1.5 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-bold tracking-tight">ChatBan</h1>
          {/* #86: プロジェクト切替。SQLiteファイルごと分かれているので、選び直すと
              ボード・チャット・前提情報がまとめて入れ替わる */}
          <select
            data-testid="project-select"
            value={projectIdFromUrl() ?? projects.find((p) => p.active)?.id ?? ""}
            onChange={(e) => gotoProject(Number(e.target.value))}
            className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-slate-900 outline-none"
          >
            {/* #107: 無効なプロジェクトは出さない。ただし今開いているものは残す
                (除外すると選択値が消えて別プロジェクトを指してしまう) */}
            {projects
              .filter((p) => !p.archived || p.id === projectIdFromUrl())
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.archived ? `${p.name} (無効)` : p.name}
                </option>
              ))}
          </select>
          <span className="flex gap-1 text-xs">
            {(
              [
                { key: "board", label: "ボード" },
                { key: "context", label: "📋 前提" },
                // #181: 📊コスト と 📜監査 のタブはここにあった (計測系と監査ログごと撤去)
                { key: "trash", label: "🗑 ゴミ箱" },
                { key: "settings", label: "⚙ 設定" },
              ] as const
            ).map((v) => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`rounded-full px-2.5 py-1 ${view === v.key ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"}`}
              >
                {v.label}
              </button>
            ))}
          </span>
        </div>
        {/* #179: ここに担当フィルタのチップが並んでいた (担当という軸ごと撤去)。
            #180: 右端にあったアカウント表示とログイン/ログアウトも、認証の廃止で消えた */}
      </header>
      {/* #212: 上流に断られたまま。**原因を断定しない** — 残高切れ・キー失効・混雑を
          見分けて見せる必要は、触っている人には無い (判別は人間が backend/logs/ の本文でやる)。
          公開デモは「残高が尽きたら終わり」を期限そのものにしているので、これが終了の合図にもなる */}
      {llmRefused && (
        <div
          data-testid="llm-refused"
          className="border-b border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          チャットの接続がいま使えません。板の操作 (カードの追加・移動・検収) はそのまま使えます。
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-auto p-3">
        {view === "context" && <ContextView />}
        {view === "settings" && <SettingsView />}
        {view === "trash" && <TrashView />}
        {view === "board" && loading && (
          <div data-testid="board-loading" className="flex h-40 items-center justify-center text-sm text-slate-500">
            読み込み中…
          </div>
        )}
        {view === "board" && !loading && loadError && (
          <div data-testid="board-error" className="flex h-40 flex-col items-center justify-center gap-3">
            <p className="text-sm text-red-600">読み込みに失敗しました: {loadError}</p>
            <button
              onClick={reload}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              再読込
            </button>
          </div>
        )}
        {view === "board" && !loading && !loadError && (
          <Board
            tasks={visibleTasks}
            allTasks={visibleTasks}
            folded={folded}
            lanes={lanes}
            onMove={moveTask}
            onOpenTask={openTask}
            approvedIds={approvedIds}
            onToggleApproved={toggleApproved}
            onCommitApproved={commitApproved}
          />
        )}
      </main>
      <Chat
        log={mainChat.log}
        sending={mainChat.sending}
        elapsedSec={mainChat.elapsedSec}
        suggestions={suggestions}
        askOptions={askOptions}
        onOpenTask={openTask}
        onSend={sendFromChat}
        onStop={mainChat.stop}
        onReset={resetChat}
        canAttach={canAttach}
      />
      </div>
      {detailTask && (
        // **カードごとに別物として扱う。**key が無いとパネルは作り直されず、
        // チャットのログ・送信中のリクエスト・入力中の下書きが前のカードのまま引き継がれる。
        // 送信中に別のカードへ切り替えると、応答が新しいカードのログに落ち、
        // そのまま次の発言の履歴としてLLMへ渡って**別のカードの経緯メモが書かれる**
        // (レビュー指摘 2026-08-21)。世代管理を自前で足すより、Reactに状態を捨てさせるほうが
        // 漏れが無い — #97 の「状態の置き場所を変えると後始末が消える」と同じ形
        <TaskDetailPanel
          key={detailTask.id}
          task={detailTask}
          archived={detailArchived}
          canAttach={canAttach}
          onClose={() => {
            setDetailTaskId(null);
            lastDetailTaskRef.current = undefined;
          }}
          onJumpToBoard={jumpToBoard}
          lanes={lanes}
          taskById={new Map(tasks.map((t) => [t.id, t]))}
          onOpenTask={openTask}
          onRestored={() => {
            setArchivedTask(null);
            reload();
          }}
        />
      )}
      {toast && (
        <div
          data-testid="toast"
          className={`fixed bottom-20 right-4 z-50 flex items-center gap-3 rounded-xl border bg-white px-4 py-3 text-sm shadow-lg ${
            toast.tone === "info" ? "border-slate-300" : "border-red-200"
          }`}
        >
          <span className={toast.tone === "info" ? "text-slate-700" : "text-red-600"}>{toast.message}</span>
          {toast.retry && (
            <button
              onClick={() => {
                const r = toast.retry!;
                setToast(null);
                r();
              }}
              className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700"
            >
              リトライ
            </button>
          )}
          {toast.action && (
            <button
              onClick={() => {
                const a = toast.action!;
                setToast(null);
                a.run();
              }}
              className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700"
            >
              {toast.action.label}
            </button>
          )}
          <button onClick={() => setToast(null)} className="text-xs text-slate-500 hover:text-slate-600">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
