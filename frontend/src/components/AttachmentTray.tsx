import type { Attachment } from "../hooks/useAttachments";

// #68: 送信前の添付プレビュー (画像サムネ / 📄PDF名 + ×で外す)
export default function AttachmentTray({
  attachments,
  error,
  onRemove,
}: {
  attachments: Attachment[];
  error: string | null;
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0 && !error) return null;
  return (
    <div className="px-1 pb-1.5">
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {attachments.map((a, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
              {a.kind === "image" ? (
                <img src={a.dataUrl} alt={a.name} className="h-8 w-8 rounded object-cover" />
              ) : (
                <span>📄</span>
              )}
              <span className="max-w-40 truncate">{a.name}</span>
              <button onClick={() => onRemove(i)} className="text-slate-500 hover:text-slate-600" title="外す">
                ✕
              </button>
            </span>
          ))}
          <span className="text-[10px] text-slate-500">原本は保存されず、AIが読んだ内容だけが記録に残ります</span>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
