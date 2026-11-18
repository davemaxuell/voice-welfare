import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "../src/core/assets.ts";
import { modules, reference } from "./port-manifest.ts";

const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
// 원본이 남아 있는 마지막 커밋을 기준으로 모든 이식 기록을 검증한다.
git("cat-file", "-e", reference.commit + "^{commit}");

for (const [module, { python, sha }] of Object.entries(modules)) {
  git("show", `${sha}^{commit}`, "--no-patch", "--format=%H");
  for (const path of python) git("cat-file", "-e", `${sha}:${path}`);
  const changes = git("log", "--oneline", `${sha}..${reference.commit}`, "--", ...python);
  if (changes !== "") {
    console.log(module, "\n" + changes);
    process.exitCode = 1;
  }
}
