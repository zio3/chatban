import { DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import { STATUS_LABELS } from "../types";
import type { SummaryCard, Task, TaskStatus } from "../types";

const COLUMNS: { key: TaskStatus; label: string; accent: string }[] = [
  { key: "todo", label: "Todo", accent: "border-slate-400" },
  { key: "inprogress", label: "In Progress", accent: "border-blue-500" },
  { key: "review", label: "Review", accent: "border-amber-500" },
  { key: "done", label: "Done", accent: "border-emerald-500" },
];

/** 期限バッジ: 超過=赤 / 今日・明日=琥珀 / それ以降=グレー (#44) */
function dueBadge(due: string): { text: string; cls: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${due}T00:00:00`);
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
  const label = `${d.getMonth() + 1}/${d.getDate()}`;
  if (diffDays < 0) return { text: `⏰ ${label} 超過`, cls: "bg-red-100 font-bold text-red-700" };
  if (diffDays <= 1) return { text: `⏰ ${label}`, cls: "bg-amber-100 font-bold text-amber-700" };
  return { text: `⏰ ${label}`, cls: "bg-slate-100 text-slate-500" };
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
export function DepChip({
  id,
  dep,
  unresolved,
  onOpen,
  tone = "blocking",
}: {
  id: number;
  dep?: Task;
  unresolved: boolean;
  onOpen?: (id: number) => void;
  /** blocking=このタスクが待っている先 / waiting=このタスクを待っている側 (#111) */
  tone?: "blocking" | "waiting";
}) {
  const label = dep
    ? `#${id} ${dep.title}
${STATUS_LABELS[dep.status]?.label ?? dep.status}${dep.assignee ? ` / ${dep.assignee}` : ""}${dep.summary ? `
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
            : "bg-slate-100 text-slate-400 line-through"
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
}: {
  task: Task;
  overlay?: boolean;
  onOpen?: (id: number) => void;
  /** Review列のみ: 検収OKマーク状態 (#57)。Doneへの確定は列ヘッダーの一括ボタンで行う */
  approved?: boolean;
  onToggleApproved?: (id: number) => void;
  /** 未完了タスクIDの集合 (#41: 依存バッジの未解決判定用) */
  openIds?: Set<number>;
  /** 依存先の中身を引くための索引 (#111)。アーカイブ済みは載らない */
  taskById?: Map<number, Task>;
}) {
  const depsUnresolved = task.blockedBy?.some((id) => openIds?.has(id)) ?? false;
  return (
    <div
      data-testid={`task-card-${task.id}`}
      onClick={() => onOpen?.(task.id)}
      className={`rounded-lg border bg-white p-2.5 shadow-sm ${approved ? "border-emerald-400 ring-1 ring-emerald-300" : "border-slate-200"} ${overlay ? "rotate-2 shadow-lg" : ""} ${onOpen ? "cursor-pointer hover:border-indigo-300" : ""}`}
    >
      {/* 1行目: ID + タイトル + 担当。以前はここに却下/期限/依存のバッジも混ざっていて、
          付いているカードほどタイトルが右下へ押し出され、列を縦に流し読みできなかった。
          (3人のデザイナーが独立に同じ箇所を問題視した)。
          IDを固定幅にしてタイトルの左端を全カードで揃える案も試したが、1桁と3桁で
          IDの周りの空きが変わるのが気になる、として不採用 (zio判断) */}
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-sm font-medium leading-snug">
          <span className="mr-1 text-xs text-slate-400">#{task.id}</span>
          {task.title}
        </span>
        {task.assignee && (
          // 全カードに必ず出る情報なので、毎枚主張させない (C案の判断)。
          // 担当で絞りたいときはヘッダーの人フィルタが本来の導線
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            {task.assignee}
          </span>
        )}
      </div>
      {/* 2行目: 状態のチップ。検収OKもここに畳む (以前はカード幅いっぱいの独立行で、
          Review列のカードだけ背が高かった)。何も無ければ行ごと出ない */}
      {(task.rejected || task.due || (task.blockedBy?.length ?? 0) > 0 || onToggleApproved) && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {task.rejected && (
            <span className="rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold text-white">🚫 却下</span>
          )}
          {task.due && (
            <span className={`rounded px-1 py-0.5 text-[10px] ${dueBadge(task.due).cls}`}>{dueBadge(task.due).text}</span>
          )}
          {task.blockedBy && task.blockedBy.length > 0 && (
            <span
              className="text-[10px] text-slate-400"
              title={depsUnresolved ? "依存先が未完了のため着手できません" : "依存先はすべて完了済み"}
            >
              ⛓{" "}
              {task.blockedBy.map((id) => (
                <DepChip key={id} id={id} dep={taskById?.get(id)} unresolved={!!openIds?.has(id)} onOpen={onOpen} />
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
}: {
  task: Task;
  onOpen: (id: number) => void;
  approved?: boolean;
  onToggleApproved?: (id: number) => void;
  openIds?: Set<number>;
  taskById?: Map<number, Task>;
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
      />
    </div>
  );
}

/** 要約要素内の #NN をクリック可能にする (#59: アーカイブ済みタスクの詳細も開ける) */
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

// #58: チェックボックスは廃止 (done=検収済みなので把握確認が二重になる)。
// アクティブカード=緑で開いた状態、整頓で過去ログ化(frozen)されたカード=グレーで畳んだ状態
function SummaryCardView({
  card,
  onOpenTask,
  defaultOpen,
}: {
  card: SummaryCard;
  onOpenTask: (id: number) => void;
  /** #105: 検収バッチごとにカードが増えるので、開くのは最新の1枚だけ */
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      data-testid={`summary-card-${card.id}`}
      className={`rounded-lg border p-2.5 shadow-sm ${card.frozen ? "border-slate-200 bg-slate-50" : "border-emerald-300 bg-emerald-50"}`}
    >
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="text-sm font-bold text-slate-700">
          📦 {card.title}
          <span className="ml-1.5 text-xs font-normal text-slate-400">({card.taskIds.length}件)</span>
        </span>
        <span className="text-xs text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {card.elements.map((e, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs leading-snug text-slate-700">
              <span className="text-slate-400">•</span>
              <span>{renderRefs(e.text, onOpenTask)}</span>
            </li>
          ))}
          {card.elements.length === 0 && <li className="text-xs text-slate-400">要約を生成中…</li>}
        </ul>
      )}
    </div>
  );
}

function Column({
  col,
  tasks,
  summaryCards,
  archiveWorking,
  onOpenTask,
  approvedIds,
  onToggleApproved,
  onCommitApproved,
  openIds,
  taskById,
}: {
  col: (typeof COLUMNS)[number];
  tasks: Task[];
  summaryCards?: SummaryCard[];
  archiveWorking?: boolean;
  onOpenTask: (id: number) => void;
  /** Review列のみ: 検収OKマークの集合と一括確定 (#57) */
  approvedIds?: Set<number>;
  onToggleApproved?: (id: number) => void;
  onCommitApproved?: () => void;
  /** 未完了タスクIDの集合 (#41: 依存バッジの未解決判定用) */
  openIds?: Set<number>;
  /** 依存先の中身を引くための索引 (#111)。アーカイブ済みは載らない */
  taskById?: Map<number, Task>;
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
      {/* #71: Done列は生タスクが常駐しない(検収→即アーカイブ)ので、バッジは蒸留済み総数を出す */}
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
            {col.key === "done" && summaryCards
              ? `📦 ${summaryCards.reduce((n, c) => n + c.taskIds.length, 0) + tasks.length}`
              : tasks.length}
          </span>
        </span>
      </div>
      {/* 完了→要約合流は非同期(15〜30秒)なので、再生成中はスピナーで明示 (#56) */}
      {archiveWorking && (
        <div
          data-testid="archive-working"
          className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-700"
        >
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          要約カードを再生成中…
        </div>
      )}
      {/* Done列: 要約カード常駐 (アクティブ→過去ログの順) */}
      {summaryCards &&
        [...summaryCards]
          .sort((a, b) => Number(a.frozen) - Number(b.frozen) || b.id - a.id)
          .map((c, i) => (
            <SummaryCardView key={c.id} card={c} onOpenTask={onOpenTask} defaultOpen={i === 0 && !c.frozen} />
          ))}
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((t) =>
          // #105: Done列の生カードはドラッグさせない。検収後アーカイブ完了までの15〜30秒に
          // 他の列へ動かせてしまい、あとから走るアーカイブ処理が archived=1 にするため、
          // 「todoなのにボードから消える」幽霊タスクができる。
          // Doneへは入れられない(#57)ので、出られないほうが一貫する。戻したいときはチャットで「#xxを戻して」
          col.key === "done" ? (
            <TaskCard key={t.id} task={t} onOpen={onOpenTask} openIds={openIds} taskById={taskById} />
          ) : (
            <SortableCard
              key={t.id}
              task={t}
              onOpen={onOpenTask}
              approved={approvedIds?.has(t.id)}
              onToggleApproved={onToggleApproved}
              openIds={openIds}
              taskById={taskById}
            />
          )
        )}
        {tasks.length === 0 && !(summaryCards && summaryCards.length > 0) && (
          <p className="rounded-lg border border-dashed border-slate-200 py-4 text-center text-xs text-slate-400">
            タスクなし
          </p>
        )}
      </SortableContext>
    </div>
  );
}

export default function Board({
  tasks,
  allTasks,
  summaryCards,
  archiveWorking,
  onMove,
  onOpenTask,
  approvedIds,
  onToggleApproved,
  onCommitApproved,
}: {
  tasks: Task[];
  /** 依存の判定に使う母集団。フィルタで隠れているものも含む全件 (#41/#90) */
  allTasks: Task[];
  summaryCards: SummaryCard[];
  archiveWorking?: boolean;
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
  // 別担当の未完了タスクに依存しているとき、担当フィルタでそれが隠れた瞬間に
  // 「待ち」表示まで消え、依存関係が実態と逆に見えた (自動レビュー指摘)。
  // フィルタは見せ方の話であって、待ちかどうかの事実は変わらない
  const openIds = new Set(allTasks.filter((t) => t.status !== "done").map((t) => t.id));
  const taskById = new Map(allTasks.map((t) => [t.id, t]));

  function locate(overId: number | TaskStatus): { status: TaskStatus; index: number } | null {
    if (COLUMNS.some((c) => c.key === overId)) {
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
      {/* #64: スマホは横スクロールで4列を維持 (かんばんの比喩を崩さない) */}
      <div className="grid min-w-[880px] grid-cols-4 gap-3">
        {COLUMNS.map((col) => (
          <Column
            key={col.key}
            col={col}
            tasks={byStatus(col.key)}
            summaryCards={col.key === "done" ? summaryCards : undefined}
            archiveWorking={col.key === "done" ? archiveWorking : undefined}
            onOpenTask={onOpenTask}
            approvedIds={col.key === "review" ? approvedIds : undefined}
            onToggleApproved={col.key === "review" ? onToggleApproved : undefined}
            onCommitApproved={col.key === "review" ? onCommitApproved : undefined}
            openIds={openIds}
            taskById={taskById}
          />
        ))}
      </div>
      <DragOverlay>{active && <TaskCard task={active} overlay />}</DragOverlay>
    </DndContext>
  );
}
