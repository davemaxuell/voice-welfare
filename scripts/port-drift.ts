import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../src/core/assets.ts";

const repoPath = z.string().regex(/^src\/(?!.*\.\.)(?!.*[\\:*?\[]).+$/);
const manifest = z.object({
  modules: z.record(repoPath, z.object({ python: z.array(repoPath).min(1), sha: z.string().regex(/^[0-9a-f]{7,40}$/) })),
}).parse(JSON.parse(readFileSync(join(REPO_ROOT, "port-manifest.json"), "utf8")));
const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
let main = "origin/main";
try { git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"); }
catch { main = "main"; }

for (const [module, { python, sha }] of Object.entries(manifest.modules)) {
  git("show", `${sha}^{commit}`, "--no-patch", "--format=%H");
  for (const path of python) git("cat-file", "-e", `${sha}:${path}`);
  const changes = git("log", "--oneline", `${sha}..${main}`, "--", ...python);
  if (changes !== "") {
    console.log(module, "\n" + changes);
    process.exitCode = 1;
  }
}
