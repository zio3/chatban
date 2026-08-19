import ProjectSettings from "./ProjectSettings";

// 設定画面。#181 以降ここにあるのはプロジェクトの管理だけ。
//
// かつては #88 の「用途別モデルを実行時に切り替える (再起動不要)」があった。
// 「モデルID1行で差し替えられる」というルーターの利点をUIとして触れる形にしたものだったが、
// **選択肢の供給元が単価つきカタログ (182件) だった**ので、計測系の撤去で空になる。
// #182 以降、宛先・キー・モデルは backend/config.json が供給元 —
// 個人利用なら Claude Code から直接書けるので、UIを持つ理由が無い。
//
// ログイン設定 (GoogleクライアントID・許可リスト) も #180 で認証ごと廃止した。
export default function SettingsView() {
  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <ProjectSettings />
      <p className="text-[11px] text-slate-500">
        接続先とモデルは <span className="font-mono">backend/config.json</span> で決めます
        (見本は <span className="font-mono">backend/examples/</span>)。変更したら再起動してください。
      </p>
    </div>
  );
}
