import { useEffect, useRef, useState } from "react";
import { api } from "../api";

// #113: Googleログイン。Google Identity Services のボタンをそのまま置く。
// 受け取るのはIDトークンだけで、正しさの判定はサーバー側 (公開鍵で検証し、許可メールと照合)。
// フロントは「誰がログインしたか」を自分で決めない — 画面の値を信じないのは
// ボードの他の操作と同じ考え方
declare global {
  interface Window {
    google?: any;
  }
}

export default function LoginView({
  clientId,
  onLoggedIn,
  onClose,
}: {
  clientId: string;
  onLoggedIn: () => void;
  /** 渡すと「閉じられる」= ログインは任意。渡さなければログインするまで先へ進めない */
  onClose?: () => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    const render = () => {
      if (!window.google || !slot.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (res: { credential: string }) => {
          try {
            await api.authGoogle(res.credential);
            onLoggedIn();
          } catch (e: any) {
            setError(e?.message ?? String(e));
          }
        },
      });
      window.google.accounts.id.renderButton(slot.current, { theme: "outline", size: "large", locale: "ja" });
    };
    if (window.google) return render();
    const el = document.createElement("script");
    el.src = "https://accounts.google.com/gsi/client";
    el.async = true;
    el.onload = render;
    el.onerror = () => setError("Googleのログイン機能を読み込めませんでした (ネットワークを確認してください)");
    document.head.appendChild(el);
  }, [clientId, onLoggedIn]);

  return (
    <div
      className={`flex items-center justify-center ${onClose ? "fixed inset-0 z-50 bg-slate-900/40" : "h-screen bg-slate-50"}`}
      onClick={onClose}
    >
      <div
        className="w-80 rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h1 className="text-lg font-bold text-slate-800">ChatBan</h1>
        <p className="mt-1 text-xs text-slate-500">会話がそのままタスク管理になる</p>
        {onClose && <p className="mt-2 text-[11px] text-slate-400">ログインしなくても使えます</p>}
        <div ref={slot} className="mt-6 flex justify-center" data-testid="google-login" />
        {!clientId && (
          <p className="mt-4 text-xs text-amber-700">
            GoogleクライアントIDが未設定です。設定タブ、または環境変数 GOOGLE_CLIENT_ID で指定してください
          </p>
        )}
        {error && <p className="mt-4 text-xs text-rose-600">{error}</p>}
        {onClose && (
          <button onClick={onClose} className="mt-4 text-xs text-slate-500 underline hover:text-slate-700">
            閉じる
          </button>
        )}
      </div>
    </div>
  );
}
