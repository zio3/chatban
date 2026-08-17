import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { socket } from "../socket";
import type { Task } from "../types";

// #102: ゴミ箱。チャット/MCPからの「削除」はここへ入るだけで実体は消えない。
// 自然言語UIでは解釈ミスが必ず起きる (「消せます?」がタスク削除と解釈された事故) ので、
// 「間違えないようにする」のではなく「間違えても取り返しがつく」形にした。
// 実体を消せるのはこの画面からだけ = 人間だけが通れる扉 (doneの検収と同じ考え方)。
export default function TrashView() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const load = useCallback(() => {
    api
      .trash()
      .then((d) => setTasks(d.tasks))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const onBoard = () => load();
    socket.on("board:changed", onBoard);
    return () => {
      socket.off("board:changed", onBoard);
    };
  }, [load]);

  if (error) return <p className="p-6 text-sm text-red-600">読み込み失敗: {error}</p>;
  if (!tasks) return <p className="p-6 text-sm text-slate-400">読み込み中…</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h2 className="text-base font-bold">🗑 ゴミ箱</h2>
        <p className="mt-1 text-xs text-slate-500">
          チャットやMCPからの削除はここに入ります(実体は残っています)。チャットで「#xxを戻して」と言っても復元できます。
          <strong className="text-slate-600">完全に消せるのはこの画面からだけ</strong>です。
        </p>
      </div>

      {tasks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
          ゴミ箱は空です
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 p-3">
              <span className="font-mono text-xs text-slate-400">#{t.id}</span>
              <span className="text-sm">{t.title}</span>
              <span className="ml-auto flex gap-1.5">
                <button
                  onClick={() => api.restoreTask(t.id).then(load)}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs text-white"
                >
                  戻す
                </button>
                {confirmId === t.id ? (
                  <>
                    <button
                      onClick={() => api.purgeTask(t.id).then(() => { setConfirmId(null); load(); })}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white"
                    >
                      本当に消す
                    </button>
                    <button
                      onClick={() => setConfirmId(null)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600"
                    >
                      やめる
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmId(t.id)}
                    className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                  >
                    完全に削除
                  </button>
                )}
              </span>
              {t.context && <p className="w-full text-[11px] text-slate-400">{t.context.slice(0, 120)}…</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
