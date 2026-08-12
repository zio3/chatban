import { useEffect, useState } from "react";
import { apiFetch } from "../api";

// #113: ログイン設定。クライアントIDと「通してよいメール」をDBに置く (envではない)。
// 設定タブから再起動なしで変えられるのはモデル設定 (#88) と同じ考え方。
//
// クライアントIDは公開情報 (フロントのHTMLに出る) なのでそのまま表示する。
// クライアントシークレットはこの方式では使わないので、持っていないし入力欄も作らない
// —— 持たないものは漏れない。
export default function AuthSettings() {
  const [clientId, setClientId] = useState("");
  const [allowedEmails, setAllowedEmails] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/settings/auth")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `${r.status}`);
        return r.json();
      })
      .then((d) => {
        setClientId(d.clientId);
        setAllowedEmails(d.allowedEmails);
        setEnabled(d.enabled);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  /** ここは「これから誰を通すか」を決める画面なので、保存できたかどうかを取り違えない。
   * 以前はステータスを見ておらず、403のエラーJSONもそのまま成功として扱って
   * 「保存しました」と出していた (自動レビュー指摘)。DBは変わっていないのに
   * 反映されたと思い込むと、認証を有効にした瞬間に想定と違う許可リストで動く */
  const save = async () => {
    setError(null);
    const res = await apiFetch("/api/settings/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, allowedEmails }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSaved(null);
      setError(body?.error ?? `保存できませんでした (${res.status})`);
      return;
    }
    setClientId(body.clientId);
    setAllowedEmails(body.allowedEmails);
    setSaved(new Date().toLocaleTimeString("ja-JP"));
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-bold text-slate-800">🔑 ログイン (Google)</h2>
      <p className="mt-1 text-xs text-slate-500">
        {enabled
          ? "ログイン必須で動いています (CHATBAN_AUTH=on)"
          : "ログインは任意です。していなくても操作できます (必須にするには CHATBAN_AUTH=on で起動)"}
      </p>

      <label className="mt-3 block text-xs font-medium text-slate-600">
        GoogleクライアントID
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="xxxxx.apps.googleusercontent.com"
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-[11px] outline-none focus:border-indigo-400"
        />
      </label>
      <p className="mt-1 text-[11px] text-slate-400">
        Google Cloud Console → OAuth クライアント ID (ウェブアプリケーション)。承認済みJavaScript生成元に
        このアプリのURLを登録する。クライアントシークレットはこの方式では使わない
      </p>

      <label className="mt-3 block text-xs font-medium text-slate-600">
        通してよいメールアドレス (カンマ区切り)
        <input
          value={allowedEmails}
          onChange={(e) => setAllowedEmails(e.target.value)}
          placeholder="you@example.com"
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-[11px] outline-none focus:border-indigo-400"
        />
      </label>
      <p className="mt-1 text-[11px] text-slate-400">
        ここに無いアカウントはサーバー側で拒否する。<strong>一度も設定していないとき</strong>だけ、最初にログインした人を登録する
        (設定画面に入れず詰むのを防ぐため)。<strong>一度保存したあとで空にすると全員を拒否する</strong> —
        そうすると再設定はサーバーのローカル端末からしかできなくなる
      </p>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={save}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
        >
          保存
        </button>
        {saved && !error && <span className="text-[11px] text-emerald-600">保存しました ({saved})</span>}
        {error && <span className="text-[11px] text-red-600">{error}</span>}
      </div>
    </section>
  );
}
