import { DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import { dueBadge, statusLabel } from "../types";
import type { CustomLane, FoldedTask, Task, TaskStatus } from "../types";

type Column = { key: TaskStatus; label: string; accent: string };

/** 列数ごとの grid 指定。**クラス名を `grid-cols-${n}` で組み立てない** —
 * Tailwind はソースを文字列として走査するので、実行時に作った名前はCSSが生成されず無効になる */
const GRID_BY_COLUMNS: Record<number, string> = {
  4: "min-w-[880px] grid-cols-4",
  5: "min-w-[1100px] grid-cols-5",
  6: "min-w-[1320px] grid-cols-6",
};

/** 固定4列。**任意レーンが0本ならこれがそのまま列になる** (既定はこちら) */
// #228: **表示名は statusLabel から引く。**ここが持つのは accent (枠線の色) だけ。
// 以前は label も書いてあり、文字列が一致していたので見えていなかったが、
// 片方を変えると列見出しとバッジで別の名前が出る形だった
const BASE_COLUMNS: Column[] = [
  { key: "todo", label: statusLabel("todo").label, accent: "border-slate-400" },
  { key: "inprogress", label: statusLabel("inprogress").label, accent: "border-blue-500" },
  { key: "review", label: statusLabel("review").label, accent: "border-amber-500" },
  { key: "done", label: statusLabel("done").label, accent: "border-emerald-500" },
];

/** #19: 任意レーンを Review と Done の**間**に差し込む。
 * Done を末尾に固定するのは、退場ゲート (review → 検収 → done) の順序が読み取れる並びだから */
function columnsFor(lanes: CustomLane[]): Column[] {
  const head = BASE_COLUMNS.slice(0, 3);
  const done = BASE_COLUMNS[3];
  return [...head, ...lanes.map((l) => ({ key: l.key, label: l.label, accent: "border-violet-500" })), done];
}

export interface MovePayload {
  id: number;
  status: TaskStatus;
  /** 列内の挿入先index (末尾ならその列の件数) */
  index: number;
}

/** #111: 依存先をその場で確かめられるようにする。IDだけでは何を待っているのか分からず、
 * いちいち探しに行くことになっていた。
 *
 * ポップオーバーで概要を出す案もあったが採らない。カードのクリック=詳細パネル という規則が
 * 既にあるので、依存チップも同じ意味にしておけば覚えることが増えない (#107でlaneを消したのと同じ、
 * 語彙を増やさない判断)。ホバーは標準のツールチップでタイトルだけ — レイアウトを覆わず、
 * 俯瞰したまま「何待ちか」が読める。モバイルはクリックだけで完結する */
/** 期限バッジ。**カードと詳細パネルで同じものを出す** (#228) —
 * 以前はそれぞれが自前で整形しており、超過の判定がカードにしか無かった。
 * DepChip と同じく、板の外 (パネル) からも使う小さな部品 */
export function DueBadge({ due, long }: { due: string; long?: boolean }) {
  const b = dueBadge(due, { long });
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${b.cls}`}>{b.text}</span>;
}

export function DepChip({
  id,
  dep,
  unresolved,
  onOpen,
  tone = "blocking",
  lanes = [],
}: {
  id: number;
  dep?: Task;
  unresolved: boolean;
  onOpen?: (id: number) => void;
  /** #19: 依存先が任意レーンに居るとき、吹き出しに表示名を出すため。
   * 省略すると `custom1` という生の値が出る (落ちはしないが人に見せる値ではない) */
  lanes?: CustomLane[];
  /** blocking=このカードが待っている先 / waiting=このカードを待っている側 (#111) */
  tone?: "blocking" | "waiting";
}) {
  const label = dep
    ? `#${id} ${dep.title}
${statusLabel(dep.status, lanes).label}${dep.summary ? `
${dep.summary}` : ""}
(クリックで詳細)`
    : `#${id} 完了してアーカイブ済み (クリックで詳細)`;
  return (
    <span
      data-testid={`dep-chip-${id}`}
      title={label}
      onClick={(e) => {
        e.stopPropagation(); // カード自体のクリック(自分を開く)と取り合わない
        onOpen?.(id);
      }}
      className={`mr-1 inline-block cursor-pointer rounded px-1 py-0.5 text-[10px] hover:ring-1 hover:ring-violet-300 ${
        tone === "waiting"
          ? "bg-sky-100 text-sky-700"
          : unresolved
            ? "bg-violet-100 font-bold text-violet-700"
            : "bg-slate-100 text-slate-500 line-through"
      }`}
    >
      #{id}
    </span>
  );
}

function TaskCard({
  task,
  overlay = false,
  onOpen,
  approved,
  onToggleApproved,
  openIds,
  taskById,
  lanes = [],
}: {
  task: Task;
  overlay?: boolean;
  onOpen?: (id: number) => void;
  /** Review列のみ: 検収OKマーク状態 (#57)。Doneへの確定は列ヘッダーの一括ボタンで行う */
  approved?: boolean;
  onToggleApproved?: (id: number) => void;
  /** 未完了カードIDの集合 (#41: 依存バッジの未解決判定用) */
  openIds?: Set<number>;
  /** 依存先の中身を引くための索引 (#111)。アーカイブ済みは載らない */
  taskById?: Map<number, Task>;
  /** #19: 依存バッジの吹き出しに任意レーンの表示名を出すため */
  lanes?: CustomLane[];
}) {
  const depsUnresolved = task.blockedBy?.some((id) => openIds?.has(id)) ?? false;
  return (
    <div
      data-testid={`task-card-${task.id}`}
      onClick={() => onOpen?.(task.id)}
      className={`rounded-lg border bg-white p-2.5 shadow-sm ${approved ? "border-emerald-400 ring-1 ring-emerald-300" : "border-slate-200"} ${overlay ? "rotate-2 shadow-lg" : ""} ${onOpen ? "cursor-pointer hover:border-indigo-300" : ""}`}
    >
      {/* 1行目: ID + タイトル。以前はここに却下/期限/依存のバッジも混ざっていて、
          付いているカードほどタイトルが右下へ押し出され、列を縦に流し読みできなかった。
          (3人のデザイナーが独立に同じ箇所を問題視した)。
          IDを固定幅にしてタイトルの左端を全カードで揃える案も試したが、1桁と3桁で
          IDの周りの空きが変わるのが気になる、として不採用 (zio判断) */}
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-sm font-medium leading-snug">
          <span className="mr-1 text-xs text-slate-500">#{task.id}</span>
          {task.title}
        </span>
      </div>
      {/* 2行目: 状態のチップ。検収OKもここに畳む (以前はカード幅いっぱいの独立行で、
          Review列のカードだけ背が高かった)。何も無ければ行ごと出ない */}
      {(task.rejected || task.due || (task.blockedBy?.length ?? 0) > 0 || onToggleApproved) && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {task.rejected && (
            <span className="rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold text-white">🚫 却下</span>
          )}
          {task.due && <DueBadge due={task.due} />}
          {task.blockedBy && task.blockedBy.length > 0 && (
            <span
              className="text-[10px] text-slate-500"
              // #152: 「着手できません」と書いていたが、**コードは何も止めていない**
              // (mayEnterDone は依存を見ない)。AI向けの契約を「緩い参照」に直したので、
              // 人間が読む側も揃える — 入口ごとに意味が違うと、どちらを信じてよいか分からなくなる
              title={depsUnresolved ? "終わっていない依存先があります (着手は止めません)" : "依存先はすべて完了済み"}
            >
              ⛓{" "}
              {task.blockedBy.map((id) => (
                <DepChip key={id} id={id} dep={taskById?.get(id)} unresolved={!!openIds?.has(id)} onOpen={onOpen} lanes={lanes} />
              ))}
            </span>
          )}
          {onToggleApproved && (
            <label
              onClick={(e) => e.stopPropagation()}
              className={`ml-auto flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${
                approved
                  ? "border-emerald-400 bg-emerald-100 text-emerald-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
              }`}
            >
              <input
                type="checkbox"
                data-testid={`approve-${task.id}`}
                checked={!!approved}
                onChange={() => onToggleApproved(task.id)}
                className="h-3.5 w-3.5 accent-emerald-600"
              />
              検収OK
            </label>
          )}
        </div>
      )}
      {/* #92: カードに出すのは「いまどうなっているか」(summary)。
          「なぜこの人か」(reason)は普段は要らないので詳細パネルで読む。
          以前はreasonに進捗が書き込まれていたが、原因はMCP側のツール契約にreasonの説明が
          無く、エージェントから見て用途不明の文字列欄になっていたこと */}
      {/* 3行目: いまどうなっているか */}
      {task.summary && <p className="mt-1 text-xs text-slate-600">📝 {task.summary}</p>}
    </div>
  );
}

function SortableCard({
  task,
  onOpen,
  approved,
  onToggleApproved,
  openIds,
  taskById,
  lanes,
}: {
  task: Task;
  onOpen: (id: number) => void;
  approved?: boolean;
  onToggleApproved?: (id: number) => void;
  openIds?: Set<number>;
  taskById?: Map<number, Task>;
  lanes?: CustomLane[];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`cursor-grab touch-none ${isDragging ? "opacity-30" : ""}`}
    >
      <TaskCard
        task={task}
        onOpen={onOpen}
        approved={approved}
        onToggleApproved={onToggleApproved}
        openIds={openIds}
        taskById={taskById}
        lanes={lanes}
      />
    </div>
  );
}

/** 要約要素内の #NN をクリック可能にする (#59: アーカイブ済みカードの詳細も開ける) */
function renderRefs(text: string, onOpen: (id: number) => void) {
  return text.split(/(#\d+)/g).map((p, i) => {
    const m = p.match(/^#(\d+)$/);
    if (!m) return <span key={i}>{p}</span>;
    return (
      <button
        key={i}
        onClick={() => onOpen(Number(m[1]))}
        className="font-bold text-emerald-700 underline decoration-dotted underline-offset-2 hover:text-emerald-900"
      >
        {p}
      </button>
    );
  });
}

// #200: Done列の2段目。直近24時間に畳んだカードをまとめた**1個だけ**の箱。
// サーバーのメモリ上にしか無いので、再起動すると消える (中身は archived=1 でDBに残り、検索で引ける)
function FoldedBox({ folded, onOpenTask }: { folded: FoldedTask[]; onOpenTask: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="folded-box" className="rounded-lg border border-emerald-300 bg-emerald-50 p-2.5 shadow-sm">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="text-sm font-bold text-slate-700">
          📦 畳んだ完了
          <span className="ml-1.5 text-xs font-normal text-slate-500">({folded.length}件)</span>
        </span>
        <span className="text-xs text-slate-500">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {folded.map((t) => (
            <li key={t.id} className="text-xs leading-snug">
              <button
                onClick={() => onOpenTask(t.id)}
                className="text-left text-slate-700 hover:text-emerald-700 hover:underline"
              >
                <span className="text-slate-500">#{t.id}</span> {t.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Column({
  col,
  tasks,
  folded,
  onOpenTask,
  approvedIds,
  onToggleApproved,
  onCommitApproved,
  openIds,
  taskById,
  lanes,
}: {
  col: Column;
  tasks: Task[];
  folded?: FoldedTask[];
  onOpenTask: (id: number) => void;
  /** Review列のみ: 検収OKマークの集合と一括確定 (#57) */
  approvedIds?: Set<number>;
  onToggleApproved?: (id: number) => void;
  onCommitApproved?: () => void;
  /** 未完了カードIDの集合 (#41: 依存バッジの未解決判定用) */
  openIds?: Set<number>;
  /** 依存先の中身を引くための索引 (#111)。アーカイブ済みは載らない */
  taskById?: Map<number, Task>;
  /** #19: 依存バッジの吹き出し用にカードへ流す */
  lanes?: CustomLane[];
}) {
  // Doneは「置き場」でなく「検収の結果」: D&Dでは到達できない (#57)
  const { setNodeRef, isOver } = useDroppable({ id: col.key, disabled: col.key === "done" });
  return (
    <div
      ref={setNodeRef}
      data-testid={`column-${col.key}`}
      title={col.key === "done" ? "Doneへは検収ボタンかチャットの承認からのみ移動できます" : undefined}
      className={`flex min-h-40 flex-col gap-2 rounded-xl border-t-4 ${col.accent} bg-slate-50 p-2 ${isOver ? "ring-2 ring-indigo-400" : ""}`}
    >
      {/* #71: Done列は生カードが常駐しない(検収→即アーカイブ)ので、バッジは蒸留済み総数を出す */}
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">{col.label}</h2>
        <span className="flex items-center gap-1.5">
          {onCommitApproved && tasks.length > 0 && (
            <button
              data-testid="approve-commit"
              onClick={onCommitApproved}
              disabled={!approvedIds || approvedIds.size === 0}
              className="rounded-md bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              ✓ 検収済み{approvedIds?.size ?? 0}件をDoneへ
            </button>
          )}
          <span data-testid={`count-${col.key}`} className="rounded-full bg-slate-200 px-1.5 text-xs text-slate-500">
            {col.key === "done" && folded
              ? `📦 ${folded.length + tasks.length}`
              : tasks.length}
          </span>
        </span>
      </div>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((t) =>
          // Done列の生カードはドラッグさせない。Doneへは入れられない(#57)ので、出られないほうが一貫する。
          // 戻したいときはチャットで「#xxを戻して」
          col.key === "done" ? (
            <TaskCard key={t.id} task={t} onOpen={onOpenTask} openIds={openIds} taskById={taskById} lanes={lanes} />
          ) : (
            <SortableCard
              key={t.id}
              task={t}
              onOpen={onOpenTask}
              approved={approvedIds?.has(t.id)}
              onToggleApproved={onToggleApproved}
              openIds={openIds}
              taskById={taskById}
              lanes={lanes}
            />
          )
        )}
        {tasks.length === 0 && !(folded && folded.length > 0) && (
          <p className="rounded-lg border border-dashed border-slate-200 py-4 text-center text-xs text-slate-500">
            カードなし
          </p>
        )}
      </SortableContext>
      {/* #200: バラバラのDone(1段目)が上、畳んだ箱(2段目)がその下 */}
      {folded && folded.length > 0 && <FoldedBox folded={folded} onOpenTask={onOpenTask} />}
    </div>
  );
}

export default function Board({
  tasks,
  allTasks,
  folded,
  lanes,
  onMove,
  onOpenTask,
  approvedIds,
  onToggleApproved,
  onCommitApproved,
}: {
  tasks: Task[];
  /** 依存の判定に使う母集団。フィルタで隠れているものも含む全件 (#41/#90) */
  allTasks: Task[];
  folded: FoldedTask[];
  /** #19: 有効な任意レーン (0〜2本)。空ならこれまでどおりの4列 */
  lanes: CustomLane[];
  onMove: (move: MovePayload) => void;
  onOpenTask: (id: number) => void;
  approvedIds: Set<number>;
  onToggleApproved: (id: number) => void;
  onCommitApproved: () => void;
}) {
  const [active, setActive] = useState<Task | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const byStatus = (s: TaskStatus) => tasks.filter((t) => t.status === s);
  // #41: 依存バッジの未解決判定 (依存先がボード上に未完了で残っていれば「待ち」)。
  // #111: 依存先の中身をチップから引くための索引 (アーカイブ済みは載らない。クリックで取りに行く)。
  //
  // **描画はフィルタ後、依存の判定は全件**。同じ配列から両方作っていたので、
  // 別担当の未完了カードに依存しているとき、担当フィルタでそれが隠れた瞬間に
  // 「待ち」表示まで消え、依存関係が実態と逆に見えた (自動レビュー指摘)。
  // フィルタは見せ方の話であって、待ちかどうかの事実は変わらない
  const openIds = new Set(allTasks.filter((t) => t.status !== "done").map((t) => t.id));
  const taskById = new Map(allTasks.map((t) => [t.id, t]));

  const columns = columnsFor(lanes);

  function locate(overId: number | TaskStatus): { status: TaskStatus; index: number } | null {
    if (columns.some((c) => c.key === overId)) {
      return { status: overId as TaskStatus, index: byStatus(overId as TaskStatus).length };
    }
    const overTask = tasks.find((t) => t.id === overId);
    if (!overTask) return null;
    const col = byStatus(overTask.status);
    return { status: overTask.status, index: col.findIndex((t) => t.id === overTask.id) };
  }

  function handleDragStart(e: DragStartEvent) {
    setActive(tasks.find((t) => t.id === e.active.id) ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActive(null);
    if (!e.over) return;
    const task = tasks.find((t) => t.id === e.active.id);
    const target = locate(e.over.id as number | TaskStatus);
    if (!task || !target) return;
    // Done列へのD&D流入は禁止 (検収ボタン/チャット承認のみ)。done内の並び替えは許可 (#57)
    if (target.status === "done" && task.status !== "done") return;
    const col = byStatus(target.status);
    const curIndex = col.findIndex((t) => t.id === task.id);
    if (task.status === target.status && (curIndex === target.index || curIndex === -1)) return;
    onMove({ id: task.id, status: target.status, index: target.index });
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      {/* #64: 狭い画面では横スクロールで列数を維持する (かんばんの比喩を崩さない)。
          #19: 任意レーンを足すと必要幅が上がる (4列=880px / 5列=1100px / 6列=1320px)。
          **有効化していないボードは 880px のまま** — 既定0本なので影響を受けない。
          Tailwind は文字列を静的に走査するので、クラス名は組み立てず全パターンを書く */}
      <div className={`grid gap-3 ${GRID_BY_COLUMNS[columns.length] ?? GRID_BY_COLUMNS[4]}`}>
        {columns.map((col) => (
          <Column
            key={col.key}
            col={col}
            tasks={byStatus(col.key)}
            folded={col.key === "done" ? folded : undefined}
            onOpenTask={onOpenTask}
            approvedIds={col.key === "review" ? approvedIds : undefined}
            onToggleApproved={col.key === "review" ? onToggleApproved : undefined}
            onCommitApproved={col.key === "review" ? onCommitApproved : undefined}
            openIds={openIds}
            taskById={taskById}
            lanes={lanes}
          />
        ))}
      </div>
      <DragOverlay>{active && <TaskCard task={active} overlay lanes={lanes} />}</DragOverlay>
    </DndContext>
  );
}
