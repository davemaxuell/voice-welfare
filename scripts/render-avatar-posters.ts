import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createServer } from "vite";
import { z } from "zod";
import { REPO_ROOT } from "../src/core/assets.ts";

async function main() {
  const { values } = parseArgs({ options: {
    "output-dir": { type: "string", default: join(REPO_ROOT, "web/public/avatar") }, help: { type: "boolean", short: "h" },
  } });
  if (values.help === true) { console.log("node scripts/render-avatar-posters.ts [--output-dir DIR]"); return; }
  const server = await createServer({ configFile: false, root: REPO_ROOT, publicDir: join(REPO_ROOT, "web/public"),
    logLevel: "error", server: { host: "127.0.0.1", port: 0, hmr: false }, optimizeDeps: { include: ["three", "three/addons/loaders/GLTFLoader.js"] } });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (typeof address !== "object" || address === null) throw Error("Missing render server port");
    const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    try {
      const page = await browser.newPage();
      await page.goto("http://127.0.0.1:" + address.port + "/avatar/still.png");
      const posters = z.record(z.string(), z.string()).parse(await page.evaluate(
        "import('/scripts/avatar-poster-frame.ts').then(module => module.renderPosters())"
      ));
      await mkdir(join(values["output-dir"], "poses"), { recursive: true });
      for (const [name, encoded] of Object.entries(posters)) {
        const file = name === "sleeping" ? "sleeping.png" : "poses/" + name + ".webp";
        await writeFile(join(values["output-dir"], file), Buffer.from(encoded, "base64"));
        console.log(file);
      }
    } finally { await browser.close(); }
  } finally { await server.close(); }
}
if (import.meta.main) await main();
