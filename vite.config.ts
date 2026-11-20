import { resolve } from "node:path";
import { defineConfig } from "vite";
import { REPO_ROOT, webStatic } from "./src/core/assets.ts";

const web = resolve(REPO_ROOT, "web");

export default defineConfig({
  root: web,
  server: { fs: { allow: [REPO_ROOT] }, proxy: { "/api": { target: "http://localhost:8787", ws: true } } },
  build: {
    outDir: webStatic,
    emptyOutDir: true,
    // The desktop avatar window may load only /avatar/ URLs (apps/desktop/main.cjs overlayAsset), and both pages share chunks.
    assetsDir: "avatar/assets",
    // three.js alone is about 570 kB. The avatar window loads it lazily.
    chunkSizeWarningLimit: 700,
    rollupOptions: { input: { main: resolve(web, "index.html"), avatar: resolve(web, "avatar/index.html") } },
  },
});
