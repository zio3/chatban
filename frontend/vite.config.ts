import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// E2E等でbackendを別ポートに向けたい場合は BACKEND_URL で上書き
const backend = process.env.BACKEND_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // #158: 1本509KBで chunk size 警告が出ていた。動作に影響は無いが、警告が常時出ていると
  // 「いつも出ているもの」になって、本当に効く警告を見落とす。
  //
  // **dynamic import での遅延読み込みは採らない。**ローカルで開いて常駐させる使い方なので
  // 初回ロードは実質問題にならず、代わりに「ボードを開いたら少し待つ」が増える。
  // ここでやりたいのは体積を減らすことではなく、**変わらないものと変わるものを分ける**こと —
  // ベンダーを別ファイルにすれば、自分のコードを直したときに再取得されるのはそちらだけになる
  build: {
    rollupOptions: {
      output: {
        // パッケージ名の一覧ではなくモジュールIDで振り分ける。名前の一覧で書くと、
        // 実際にグラフに入っている入口 (React19は react-dom/client と react/jsx-runtime) と
        // 一致せず、**中身の無いチャンクだけが生成された** (react 0.00 kB)。
        // 推移的な依存 (scheduler, @dnd-kit/utilities, remarkの周辺) もまとめて寄せたいので、
        // node_modules のパスで判定するほうが実物に合う
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          const path = id.replace(/\\/g, "/"); // Windowsでは区切りが \ で来る
          if (/node_modules\/(react|react-dom|scheduler)\//.test(path)) return "react";
          if (path.includes("node_modules/@dnd-kit/")) return "dnd";
          if (path.includes("node_modules/socket.io") || path.includes("node_modules/engine.io"))
            return "socket";
          // Markdownは react-markdown 単体ではなく remark/rehype/micromark/unified 一式で重い
          if (/node_modules\/(react-markdown|remark|rehype|micromark|unified|mdast|hast|vfile|unist|property-information|space-separated-tokens|comma-separated-tokens|character-entities|decode-named-character-reference|zwitch|longest-streak|html-url-attributes|trim-lines|bail|is-plain-obj|trough|extend|devlop|estree|style-to-js|style-to-object|inline-style-parser|ccount|markdown-table|escape-string-regexp)/.test(path))
            return "markdown";
        },
      },
    },
  },
  server: {
    host: true, // #64: スマホ実機からLAN経由でアクセスできるように (http://<PCのIP>:5173)
    allowedHosts: [".ts.net"], // Tailscale serve (https://main.<tailnet>.ts.net:5173) 経由のアクセスを許可
    proxy: {
      "/api": backend,
      "/socket.io": { target: backend, ws: true },
    },
  },
});
