/** 応答待ちの吹き出し中身: ドットアニメ + 現在の状態 + 経過秒 + 停止ボタン (#29/#30/#28) */
export default function ThinkingIndicator({
  label,
  elapsedSec,
  onStop,
}: {
  label: string;
  elapsedSec: number;
  onStop: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-400 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-400 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-400" />
      </span>
      <span className="text-xs text-slate-500">
        {label}
        {elapsedSec >= 3 && <span className="ml-1 tabular-nums text-slate-400">{elapsedSec}s</span>}
      </span>
      <button
        onClick={onStop}
        title="応答の受信をやめる (実行済みの操作はボードに反映されます)"
        className="rounded-md border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-200"
      >
        ■ 停止
      </button>
    </div>
  );
}
