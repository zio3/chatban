import { useCallback, useEffect, useRef, useState } from "react";

// #20: 音声入力 (Web Speech API)。cruise-prep の voice.js から移植。
// 開始時点の入力文を保持し、確定+暫定テキストを連結して onText に流す (話しながら入力欄が育つ)

export function useVoiceInput(onText: (text: string) => void, onError?: (message: string) => void) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const supported =
    typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  const stop = useCallback(() => {
    try {
      recRef.current?.stop?.();
    } catch {
      /* 停止済みなら無視 */
    }
  }, []);

  const start = useCallback(
    (baseText: string) => {
      if (!supported) {
        onErrorRef.current?.("このブラウザは音声入力に対応していません");
        return;
      }
      if (recRef.current) return;
      const Recog = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const rec = new Recog();
      rec.lang = "ja-JP";
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let confirmed = "";
      const prefix = baseText && !baseText.endsWith(" ") ? `${baseText} ` : baseText;

      rec.onresult = (event: any) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) confirmed += res[0].transcript;
          else interim += res[0].transcript;
        }
        onTextRef.current(prefix + confirmed + interim);
      };
      rec.onerror = (e: any) => {
        if (e.error !== "aborted" && e.error !== "no-speech") onErrorRef.current?.(e.error || "unknown");
      };
      rec.onend = () => {
        recRef.current = null;
        setListening(false);
      };
      try {
        rec.start();
        recRef.current = rec;
        setListening(true);
      } catch (ex: any) {
        onErrorRef.current?.(String(ex?.message ?? ex));
      }
    },
    [supported]
  );

  const toggle = useCallback(
    (baseText: string) => {
      if (listening) stop();
      else start(baseText);
    },
    [listening, start, stop]
  );

  // アンマウント時に止める
  useEffect(() => stop, [stop]);

  return { supported, listening, start, stop, toggle };
}
