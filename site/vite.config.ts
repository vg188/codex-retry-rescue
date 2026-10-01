import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 产物挂在 h.yourba.top/codex-retry-rescue/ 这个子路径下，
// base 必须是同名前缀，否则静态资源会 404 到站点根。
export default defineConfig({
  base: "/codex-retry-rescue/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    target: "es2020",
    cssTarget: "chrome108",
    assetsInlineLimit: 0,
  },
});
