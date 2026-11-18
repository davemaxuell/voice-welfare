import { resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { defineConfig } from "vite";
import { REPO_ROOT, soundCues } from "./src/core/assets.ts";

export default defineConfig({
  root: resolve(REPO_ROOT, "web"),
  server: { fs: { allow: [REPO_ROOT] }, proxy: { "/api": "http://127.0.0.1:8787" } },
  plugins: [{
    name: "cheongeum-cues",
    configureServer(server) {
      const files = new Set(readdirSync(soundCues));
      server.middlewares.use("/cues", (req, res, next) => {
        const file = req.url?.slice(1);
        if (file === undefined || !file.endsWith(".ogg") || !files.has(file)) return next();
        res.setHeader("Content-Type", "audio/ogg");
        res.end(readFileSync(resolve(soundCues, file)));
      });
    },
    generateBundle() {
      for (const file of readdirSync(soundCues).filter(name => name.endsWith(".ogg"))) {
        this.emitFile({ type: "asset", fileName: "cues/" + file, source: readFileSync(resolve(soundCues, file)) });
      }
    },
  }],
  build: { outDir: resolve(REPO_ROOT, "dist/web"), emptyOutDir: true },
});
