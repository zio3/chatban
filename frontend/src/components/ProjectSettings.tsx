import { useCallback, useEffect, useState } from "react";
import { api, type Project } from "../api";
import { socket } from "../socket";

// #86: プロジェクト管理。プロジェクト = SQLiteファイル1つ。
// 切り替えるとボード・チャット・前提情報・メンバーがまとめて入れ替わる。
// タスクの#IDはプロジェクトごとに1から始まる (#IDは会話の語彙なので短いほうがいい)。
export default function ProjectSettings() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMembers, setNewMembers] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftMembers, setDraftMembers] = useState("");

  const load = useCallback(() => {
    api
      .projects()
      .then((d) => setProjects(d.projects))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const onChanged = () => load();
    socket.on("project:changed", onChanged);
    return () => {
      socket.off("project:changed", onChanged);
    };
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const parseMembers = (s: string) => s.split(/[,、\s]+/).map((x) => x.trim()).filter(Boolean);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-bold">プロジェクト</h2>
        <p className="mt-1 text-xs text-slate-500">
          プロジェクトごとにSQLiteファイルが分かれています。切り替えると<strong>ボード・チャット・前提情報・メンバー</strong>
          がまとめて入れ替わり、タスクの番号は各プロジェクトで <span className="font-mono">#1</span> から始まります。
          コストの記録は全プロジェクト共通です。
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {projects.map((p) => (
          <div key={p.id} className="p-4">
            {editing === p.id ? (
              <div className="space-y-2">
                <input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  placeholder="プロジェクト名"
                />
                <input
                  value={draftMembers}
                  onChange={(e) => setDraftMembers(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  placeholder="メンバー (カンマ区切り)"
                />
                <div className="flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api.updateProject(p.id, { name: draftName, members: parseMembers(draftMembers) });
                        setEditing(null);
                      })
                    }
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs text-white disabled:opacity-30"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setEditing(null)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
                  >
                    キャンセル
                  </button>
                </div>
                {/* 担当者として使われている名前は外せない (タスクのassigneeが孤児になるため) */}
                <p className="text-[11px] text-slate-400">タスクの担当者として使われている名前は、外そうとしても残ります</p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold">{p.name}</span>
                {p.active && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">表示中</span>
                )}
                <span className="text-xs text-slate-400">
                  未完了{p.openTasks}件 / {p.members.length > 0 ? p.members.join("・") : "メンバーなし"}
                </span>
                <span className="ml-auto flex gap-1.5">
                  {!p.active && (
                    <button
                      disabled={busy}
                      onClick={() => run(() => api.activateProject(p.id))}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs text-white disabled:opacity-30"
                    >
                      開く
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setEditing(p.id);
                      setDraftName(p.name);
                      setDraftMembers(p.members.join(", "));
                    }}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
                  >
                    編集
                  </button>
                  {!p.active && projects.length > 1 && (
                    <button
                      disabled={busy}
                      onClick={() => run(() => api.deleteProject(p.id))}
                      className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-30"
                      title="DBファイルは data/trash/ へ退避されます (完全には消えません)"
                    >
                      削除
                    </button>
                  )}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-dashed border-slate-300 p-4">
        <h3 className="text-sm font-bold">新しいプロジェクト</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="プロジェクト名"
            className="min-w-[200px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
          <input
            value={newMembers}
            onChange={(e) => setNewMembers(e.target.value)}
            placeholder="メンバー (カンマ区切り、後から追加可)"
            className="min-w-[240px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
          <button
            disabled={busy || !newName.trim()}
            onClick={() =>
              run(async () => {
                await api.createProject(newName.trim(), parseMembers(newMembers));
                setNewName("");
                setNewMembers("");
              })
            }
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-30"
          >
            作成
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          作成しただけでは切り替わりません。「開く」を押すか、ヘッダーのプロジェクト選択から移動してください。
        </p>
      </div>
    </div>
  );
}
