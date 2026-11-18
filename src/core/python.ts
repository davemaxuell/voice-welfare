import { statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./assets.ts";

export const pythonProject = join(REPO_ROOT, "python");

export function pythonCommand(...args: string[]): [string, ...string[]] {
  const configured = process.env.CHEONGEUM_PYTHON;
  if (configured !== undefined && configured.length > 0) return [configured, ...args];
  const local = join(pythonProject, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (statSync(local, { throwIfNoEntry: false })?.isFile() === true) return [local, ...args];
  return ["uv", "run", "--project", pythonProject, "--locked", "python", ...args];
}
