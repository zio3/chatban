import { useCallback, useEffect, useState } from "react";
import { api, type Project } from "../api";
import { socket } from "../socket";
import { gotoProject, projectIdFromUrl } from "../project";

// #86: プロジェクト管理。プロジェクト = SQLiteファイル1つ。
// 切り替えるとボード・チャット・前提情報がまとめて入れ替わる。
// カードの#IDはプロジェクトごとに1から始まる (#IDは会話の語彙なので短いほうがいい)。
export default function ProjectSettings() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  // #117: コピーできたことを一瞬見せる。押したのに何も起きないと分からない
  const [copied, setCopied] = useState<number | null>(null);
  const copyMcp = async (id: number, url: string) => {
    // navigator.clipboard は権限や非セキュアコンテキストで落ちることがあるので、
    // 落ちたら選択+execCommandへ倒す。「押したのに何も起きない」を作らない
    const ok = await navigator.clipboard
      ?.writeText(url)
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      const el = document.createElement("textarea");
      el.value = url;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(el);
      }
    }
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  };

  const [editing, setEditing] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  // #19: 任意レーンの表示名。**空にすると畳む** (サーバーが中身を todo へ戻してから畳む)。
  // 「有効にする」チェックボックスは置かない — 名前がその箱の意味なので、名前の有無だけで決める
  const [draftLanes, setDraftLanes] = useState<[string, string]>(["", ""]);

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


  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-bold">プロジェクト</h2>
        <p className="mt-1 text-xs text-slate-500">
          プロジェクトごとにSQLiteファイルが分かれています。切り替えると<strong>ボード・チャット・前提情報</strong>
          がまとめて入れ替わり、カードの番号は各プロジェクトで <span className="font-mono">#1</span> から始まります。
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
                {/* #19: 任意レーン。既定は0本で、ふつうは空のまま = 4列のボード。
                    「版があるもの」(制作物の素材など) のように、Doneへ流さず常時見えていてほしい
                    ものを置く列が要るときだけ名前を付ける */}
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                  <div className="mb-1.5 text-xs font-bold text-slate-600">任意レーン (省略可)</div>
                  <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
                    Review と Done の間に最大2本まで足せます。<b>名前を付けた列だけが現れます。</b>
                    Todo・In Progress と同じ扱いで、ここからDoneへは直接行けません。
                    <br />
                    名前を消すと列は畳まれ、<b>そこにあったカードは Todo へ戻ります</b> (消えません)。
                  </p>
                  {[0, 1].map((i) => (
                    <input
                      key={i}
                      data-testid={`lane-label-${i + 1}`}
                      value={draftLanes[i]}
                      onChange={(e) =>
                        setDraftLanes((d) => (i === 0 ? [e.target.value, d[1]] : [d[0], e.target.value]))
                      }
                      className="mb-1.5 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                      placeholder={i === 0 ? "1本目の列名 (例: 素材)" : "2本目の列名 (空欄なら足しません)"}
                    />
                  ))}
                </div>
                <div className="flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api.updateProject(p.id, {
                          name: draftName,
                          custom1Label: draftLanes[0],
                          custom2Label: draftLanes[1],
                        });
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
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-sm font-bold ${p.archived ? "text-slate-500" : ""}`}>{p.name}</span>
                {p.archived && (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] text-slate-500">無効</span>
                )}
                {p.id === projectIdFromUrl() && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">表示中</span>
                )}
                <span className="text-xs text-slate-500">
                  未完了{p.openTasks}件
                </span>
                {/* #117: MCPの接続先はプロジェクトごとに違う (URLで固定する設計 #96)。
                    .mcp.json に貼る値をここから直接コピーできるようにする */}
                <button
                  data-testid={`copy-mcp-${p.id}`}
                  onClick={() => copyMcp(p.id, p.mcpUrl)}
                  title={`MCP接続先をコピー: ${p.mcpUrl}`}
                  className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[10px] text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
                >
                  {copied === p.id ? "✓ コピーしました" : `🔌 ${p.mcpUrl}`}
                </button>
                <span className="ml-auto flex gap-1.5">
                  {p.id !== projectIdFromUrl() && (
                    <button
                      onClick={() => gotoProject(p.id)}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs text-white"
                    >
                      開く
                    </button>
                  )}
                  {/* #107: 削除するほどではないが普段は見せたくないプロジェクト用。
                      ドロップダウンから消えるだけで実体もカードも残る */}
                  {p.id !== projectIdFromUrl() && (
                    <button
                      disabled={busy}
                      onClick={() => run(() => api.updateProject(p.id, { archived: !p.archived }))}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-30"
                      title={p.archived ? "ドロップダウンに表示する" : "ドロップダウンから隠す (実体は残る)"}
                    >
                      {p.archived ? "有効にする" : "無効にする"}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setEditing(p.id);
                      setDraftName(p.name);
                      setDraftLanes([
                        p.lanes.find((l) => l.key === "custom1")?.label ?? "",
                        p.lanes.find((l) => l.key === "custom2")?.label ?? "",
                      ]);
                    }}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
                  >
                    編集
                  </button>
                  {/* サーバー側の既定プロジェクト (active) は消せない。URLで別のものを開いていても
                      サーバーの active は変わらないので、「表示中でなければ削除できる」だけを条件に
                      していると、押しても必ず400になるボタンが出る (自動レビュー指摘)。
                      押せるのに必ず失敗するボタンは、無いより悪い */}
                  {p.id !== projectIdFromUrl() && !p.active && projects.length > 1 && (
                    <button
                      disabled={busy}
                      onClick={() => run(() => api.deleteProject(p.id))}
                      className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-30"
                      title="DBファイルは data/trash/ へ退避されます (完全には消えません)"
                    >
                      削除
                    </button>
                  )}
                  {p.active && p.id !== projectIdFromUrl() && (
                    <span
                      className="self-center text-[11px] text-slate-500"
                      /* 「別のプロジェクトを既定にすれば消せる」とは書かない。既定を切り替える口 (activateProject) は
                         APIにはあるがUIから呼べる場所が無く、案内どおりに操作しようとすると行き止まりになる
                         (自動コードレビュー指摘)。存在しない手段を案内するのは、何も書かないより悪い */
                      title="サーバーの既定プロジェクト。ヘッダーの選択やURLで別を開いても、既定はこのまま。ここが起点なので消せない"
                    >
                      既定
                    </span>
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
          <button
            disabled={busy || !newName.trim()}
            onClick={() =>
              run(async () => {
                await api.createProject(newName.trim());
                setNewName("");
              })
            }
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-30"
          >
            作成
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          作成しただけでは切り替わりません。「開く」を押すか、ヘッダーのプロジェクト選択から移動してください
          (URL <span className="font-mono">/p/&lt;id&gt;</span> が表示中のプロジェクトを持つので、タブごとに別プロジェクトを開けます)。
        </p>
      </div>
    </div>
  );
}
