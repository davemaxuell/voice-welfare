import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "../src/core/assets.ts";
import { modules } from "./port-manifest.ts";

const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
let main = "origin/main";
try { git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"); }
catch { main = "main"; }

for (const [module, { python, sha }] of Object.entries(modules)) {
  git("show", `${sha}^{commit}`, "--no-patch", "--format=%H");
  for (const path of python) git("cat-file", "-e", `${sha}:${path}`);
  const changes = git("log", "--oneline", `${sha}..${main}`, "--", ...python);
  if (changes !== "") {
    console.log(module, "\n" + changes);
    process.exitCode = 1;
  }
}
