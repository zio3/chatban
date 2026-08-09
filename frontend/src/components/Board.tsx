import { DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import type { Task, TaskStatus } from "../types";

const COLUMNS: { key: TaskStatus; label: string; accent: string }[] = [
  { key: "todo", label: "Todo", accent: "border-slate-400" },
  { key: "inprogress", label: "In Progress", accent: "border-blue-500" },
  { key: "review", label: "Review", accent: "border-amber-500" },
  { key: "done", label: "Done", accent: "border-emerald-500" },
];

export interface MovePayload {
  id: number;
  status: TaskStatus;
  /** 列内の挿入先index (末尾ならその列の件数) */
  index: number;
}

function TaskCard({ task, overlay = false }: { task: Task; overlay?: boolean }) {
  return (
    <div
      data-testid={`task-card-${task.id}`}
      className={`rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm ${overlay ? "rotate-2 shadow-lg" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-snug">
          <span className="mr-1 text-xs text-slate-400">#{task.id}</span>
          {task.title}
        </span>
        {task.assignee && (
          <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
            {task.assignee}
          </span>
        )}
      </div>
      {task.reason && <p className="mt-1.5 text-xs text-slate-500">💡 {task.reason}</p>}
    </div>
  );
}

function SortableCard({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`cursor-grab touch-none ${isDragging ? "opacity-30" : ""}`}
    >
      <TaskCard task={task} />
    </div>
  );
}

function Column({ col, tasks }: { col: (typeof COLUMNS)[number]; tasks: Task[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.key });
  return (
    <div
      ref={setNodeRef}
      data-testid={`column-${col.key}`}
      className={`flex min-h-40 flex-col gap-2 rounded-xl border-t-4 ${col.accent} bg-slate-50 p-2 ${isOver ? "ring-2 ring-indigo-400" : ""}`}
    >
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">{col.label}</h2>
        <span data-testid={`count-${col.key}`} className="rounded-full bg-slate-200 px-1.5 text-xs text-slate-500">
          {tasks.length}
        </span>
      </div>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((t) => (
          <SortableCard key={t.id} task={t} />
        ))}
        {tasks.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-200 py-4 text-center text-xs text-slate-400">
            タスクなし
          </p>
        )}
      </SortableContext>
    </div>
  );
}

export default function Board({ tasks, onMove }: { tasks: Task[]; onMove: (move: MovePayload) => void }) {
  const [active, setActive] = useState<Task | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const byStatus = (s: TaskStatus) => tasks.filter((t) => t.status === s);

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
    const col = byStatus(target.status);
    const curIndex = col.findIndex((t) => t.id === task.id);
    if (task.status === target.status && (curIndex === target.index || curIndex === -1)) return;
    onMove({ id: task.id, status: target.status, index: target.index });
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="grid grid-cols-4 gap-3">
        {COLUMNS.map((col) => (
          <Column key={col.key} col={col} tasks={byStatus(col.key)} />
        ))}
      </div>
      <DragOverlay>{active && <TaskCard task={active} overlay />}</DragOverlay>
    </DndContext>
  );
}
