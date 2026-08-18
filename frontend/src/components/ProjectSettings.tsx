import { useCallback, useEffect, useState } from "react";
import { api, type Project, type Settings } from "../api";
import { socket } from "../socket";
import { gotoProject, projectIdFromUrl } from "../project";

// #86: プロジェクト管理。プロジェクト = SQLiteファイル1つ。
// 切り替えるとボード・チャット・前提情報がまとめて入れ替わる。
// タスクの#IDはプロジェクトごとに1から始まる (#IDは会話の語彙なので短いほうがいい)。
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

  // #199: アプリ全体の設定。プロジェクト一覧とは別に読む (プロジェクトの属性ではなくなったため)。
  // 別タブで切り替えたときも合わせる (タブごとに別プロジェクトを開ける #97 ので、複数開いている前提)。
  //
  // **配信は合図として受け、値は必ず取り直す** — projects と同じ形。
  // イベントに値を載せて直接 state に入れると、HTTP応答と配信のどちらが先に着くか分からず、
  // 古い値が新しい値を上書きしうる。それを解こうとして版と起動世代を持つところまで行ったが、
  // 「サーバーが権威、クライアントは常に取り直す」なら順序の問題自体が起きない
  const [settings, setSettings] = useState<Settings | null>(null);
  const loadSettings = useCallback(() => {
    api
      .settings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    loadSettings();
    // 切れている間の変更は合図が来ない。再接続したら取り直す
    // (board / project は App.tsx が同じことをしている。ここだけ取りこぼすと永久にズレたまま)
    socket.on("connect", loadSettings);
    socket.on("settings:changed", loadSettings);
    return () => {
      socket.off("connect", loadSettings);
      socket.off("settings:changed", loadSettings);
    };
  }, [loadSettings]);

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
      {/* #167 → #199: AI提案チップ(#75)のON/OFF。元はプロジェクトごとの設定だったが、
          「使うかどうか」は持ち主の好みでプロジェクトの性質ではないので、全体で1つにした。
          プロジェクト単位だと、新しく作るたびに既定ONで始まって1件ずつ切り直すことになっていた。
          OFFの間はLLMを呼ばない — 開発中は保存のたびにサーバーが再起動してキャッシュが飛ぶので、
          切っていないと提案チップだけで1日1,000万トークン規模で流れる (#189の実測) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-base font-bold">全体の設定</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            data-testid="suggest-toggle"
            disabled={busy || !settings}
            onClick={() =>
              settings &&
              run(async () => {
                await api.updateSettings({ suggestEnabled: !settings.suggestEnabled });
                loadSettings();
              })
            }
            className={`rounded-lg border px-3 py-1.5 text-xs disabled:opacity-30 ${
              settings?.suggestEnabled
                ? "border-slate-300 bg-slate-50 text-slate-600 hover:border-slate-400"
                : "border-amber-300 bg-amber-50 font-bold text-amber-700"
            }`}
          >
            {settings?.suggestEnabled ? "💡 AI提案チップ ON" : "💡 AI提案チップ OFF"}
          </button>
          <p className="text-[11px] text-slate-500">
            チャット入力欄の上に出る ✨ 付きの提案。ボードを読んでLLMが毎回作るので、
            <strong>OFFの間は呼び出しも課金も止まります</strong>。動画を撮るときは切っておくと、
            撮り直しのたびに違うチップが出て画面が変わるのを防げます。
          </p>
        </div>
      </div>

      <div>
        <h2 className="text-base font-bold">プロジェクト</h2>
        <p className="mt-1 text-xs text-slate-500">
          プロジェクトごとにSQLiteファイルが分かれています。切り替えると<strong>ボード・チャット・前提情報</strong>
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
                <div className="flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api.updateProject(p.id, { name: draftName });
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
                <span className={`text-sm font-bold ${p.archived ? "text-slate-400" : ""}`}>{p.name}</span>
                {p.archived && (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] text-slate-500">無効</span>
                )}
                {p.id === projectIdFromUrl() && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">表示中</span>
                )}
                <span className="text-xs text-slate-400">
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
                      ドロップダウンから消えるだけで実体もタスクも残る */}
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
                      className="self-center text-[11px] text-slate-400"
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
        <p className="mt-2 text-[11px] text-slate-400">
          作成しただけでは切り替わりません。「開く」を押すか、ヘッダーのプロジェクト選択から移動してください
          (URL <span className="font-mono">/p/&lt;id&gt;</span> が表示中のプロジェクトを持つので、タブごとに別プロジェクトを開けます)。
        </p>
      </div>
    </div>
  );
}
