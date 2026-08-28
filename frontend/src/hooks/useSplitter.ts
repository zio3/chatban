import { useCallback, useRef } from "react";

/** #246: スプリッタのドラッグ処理。CardDetailPanel (横幅) と Chat (高さ) に
 * 同じ作りの startResize が2つあり、どちらもタッチで効かなかったので1本に寄せた。
 *
 * タッチで効かなかった理由は2つ:
 *   - `touch-action` 未指定 — タッチではブラウザがジェスチャを先にスクロールへ取るので、
 *     pointermove がほぼ届かない (FireTab 実機で「操作できない」と報告された本丸)。
 *     これはCSS側の仕事なので、掴む要素に `touch-action: none` (Tailwindの `touch-none`) を
 *     付けること。ここでは強制できない — 忘れると症状が再発する
 *   - `setPointerCapture` 無し — window で move/up を拾う作りだと、指が要素から
 *     外れたときの取りこぼしがある。capture すれば move/up が必ず掴んだ要素に届くので、
 *     window へのリスナ登録と後始末そのものが要らなくなる
 */
export function useSplitter(opts: {
  /** ドラッグ開始時点の値 (幅や高さ)。移動量はここからの差分で計算する */
  current: number;
  /** ポインタの移動量 (px) を値の増分に変換する。向きの反転はここでやる (例: 左へ動かすと幅が増える → `(dx) => -dx`) */
  delta: (dx: number, dy: number) => number;
  /** 値の下限・上限 (上限は画面サイズ依存なので関数で渡す) */
  clamp: (value: number) => number;
  /** ドラッグ中、値が変わるたびに呼ばれる */
  onChange: (value: number) => void;
  /** 指を離したときに確定値で呼ばれる (localStorage 保存など) */
  onCommit: (value: number) => void;
}) {
  const { current, delta, clamp, onChange, onCommit } = opts;

  // ドラッグ中のポインタID。**1本に限定する** (Codexレビュー P3) —
  // 2本目の指が同じ grip に触れると startResize が二重にリスナを登録し、
  // 両方の closure が両ポインタの move を処理して値が跳ね、片方の up で全部終わる。
  // 旧 window リスナ方式にも同じ競合があった (新規退行ではなく、hook化のついでに塞ぐ)
  const active = useRef<number | null>(null);

  return useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      if (active.current !== null) return; // 既に別の指がドラッグ中
      active.current = e.pointerId;

      const el = e.currentTarget;
      const startX = e.clientX;
      const startY = e.clientY;
      const start = current;
      const value = (ev: PointerEvent) => clamp(start + delta(ev.clientX - startX, ev.clientY - startY));

      // capture中は move/up が必ずこの要素に届く。要素が消えたりcaptureが
      // 失われたりしたときは pointercancel が来るので、そこでも後始末する
      el.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== active.current) return;
        onChange(value(ev));
      };
      const finish = (ev: PointerEvent) => {
        if (ev.pointerId !== active.current) return;
        active.current = null;
        onCommit(value(ev));
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", finish);
        el.removeEventListener("pointercancel", finish);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", finish);
      el.addEventListener("pointercancel", finish);
    },
    [current, delta, clamp, onChange, onCommit]
  );
}
