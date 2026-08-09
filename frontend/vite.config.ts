import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// E2E等でbackendを別ポートに向けたい場合は BACKEND_URL で上書き
const backend = process.env.BACKEND_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // #64: スマホ実機からLAN経由でアクセスできるように (http://<PCのIP>:5173)
    allowedHosts: [".ts.net"], // Tailscale serve (https://main.<tailnet>.ts.net:5173) 経由のアクセスを許可
    proxy: {
      "/api": backend,
      "/socket.io": { target: backend, ws: true },
    },
  },
});
