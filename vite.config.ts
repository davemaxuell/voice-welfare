import { resolve } from "node:path";
import { defineConfig } from "vite";
import { REPO_ROOT, webStatic } from "./src/core/assets.ts";

export default defineConfig({
  root: resolve(REPO_ROOT, "web"),
  server: { fs: { allow: [REPO_ROOT] }, proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: webStatic, emptyOutDir: true },
});
