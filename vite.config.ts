import { resolve } from "node:path";
import { defineConfig } from "vite";
import { REPO_ROOT, webStatic } from "./src/core/assets.ts";

export default defineConfig({
  root: webStatic,
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  build: { outDir: resolve(REPO_ROOT, "dist/web"), emptyOutDir: true },
});
