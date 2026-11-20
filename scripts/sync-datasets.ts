import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../src/core/assets.ts";
import { main } from "../src/agents/welfare/open_data/sync.ts";

const file = join(REPO_ROOT, ".env");
if (existsSync(file)) process.loadEnvFile(file);
const configured = process.env.DATASETS_DIR?.trim();
const defaultDir = configured !== undefined && configured !== ""
  ? resolve(REPO_ROOT, /^~(?:[/\\]|$)/u.test(configured) ? join(homedir(), configured.slice(2)) : configured)
  : undefined;
process.exitCode = await main(process.argv.slice(2), { defaultDir });
