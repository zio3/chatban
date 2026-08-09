import { useCallback, useState } from "react";

// #68: チャット添付 (画像/PDF)。原本はサーバーに保存されず、LLMが意味を読んで蒸留する
export interface Attachment {
  kind: "image" | "pdf";
  name: string;
  dataUrl: string;
}

const MAX_FILE_MB = 15;

function fileKind(f: File): Attachment["kind"] | null {
  if (f.type.startsWith("image/")) return "image";
  if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) return "pdf";
  return null;
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const addFiles = useCallback((files: Iterable<File>) => {
    for (const f of files) {
      const kind = fileKind(f);
      if (!kind) {
        setError(`「${f.name}」は非対応です (画像かPDFのみ)`);
        continue;
      }
      if (f.size > MAX_FILE_MB * 1024 * 1024) {
        setError(`「${f.name}」が大きすぎます (${MAX_FILE_MB}MBまで)`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setError(null);
        setAttachments((prev) => [...prev, { kind, name: f.name || `clipboard.${kind === "image" ? "png" : "pdf"}`, dataUrl: String(reader.result) }]);
      };
      reader.readAsDataURL(f);
    }
  }, []);

  /** クリップボード貼り付け (画像対応)。ファイルを拾ったらtrue (テキスト貼り付けは素通し) */
  const addFromPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.items)
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length === 0) return false;
      e.preventDefault();
      addFiles(files);
      return true;
    },
    [addFiles]
  );

  const remove = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => {
    setAttachments([]);
    setError(null);
  }, []);

  return { attachments, error, addFiles, addFromPaste, remove, clear };
}
