import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA talks to the reviewer API over HTTP. In dev, Vite proxies /api to the
// seeded in-memory API (npm run dev:api, port 5174) so there is no CORS and no
// cloud dependency. In prod the same /api path is served by the real API behind
// the same origin (ingress rewrite), so the client code is environment-agnostic.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5174",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
