import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type Acquire = "acquired" | "busy";

export const defaultLockPath = join(tmpdir(), "cheongeum-port-5174.lock");

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function holderOf(lockPath: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "pid" in parsed && typeof parsed.pid === "number") return parsed.pid;
  } catch {
    // an unreadable lock file has no live holder
  }
  return undefined;
}

/** One exclusive lock file per machine. A lock whose holder process is gone is removed and taken over. */
export function tryAcquire(lockPath: string, info: { pid: number; command: string }, alive: (pid: number) => boolean = isProcessAlive): Acquire {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ ...info, since: new Date().toISOString() }));
      closeSync(fd);
      return "acquired";
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const holder = holderOf(lockPath);
      if (holder !== undefined && alive(holder)) return "busy";
      rmSync(lockPath, { force: true });
    }
  }
  return "busy";
}

export function release(lockPath: string, pid: number): void {
  if (holderOf(lockPath) === pid) rmSync(lockPath, { force: true });
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { lock: { type: "string" }, "wait-minutes": { type: "string" } } });
  const [file, ...args] = positionals;
  const command = positionals.join(" ");
  if (file === undefined) {
    console.error("usage: node scripts/with-port-lock.ts [--wait-minutes 45] -- <command>");
    return 2;
  }
  const lockPath = values.lock ?? defaultLockPath;
  const deadline = Date.now() + Number(values["wait-minutes"] ?? "45") * 60_000;
  let waited = 0;
  while (tryAcquire(lockPath, { pid: process.pid, command }) === "busy") {
    if (Date.now() > deadline) {
      console.error(`gave up waiting for ${lockPath}`);
      return 3;
    }
    if (waited % 15 === 0) console.error(`waiting for another run to release ${lockPath}`);
    waited += 1;
    await sleep(2000);
  }
  const done = () => release(lockPath, process.pid);
  process.once("SIGINT", () => { done(); process.exit(130); });
  process.once("SIGTERM", () => { done(); process.exit(143); });
  try {
    return await new Promise<number>(resolve => {
      const viaShell = process.platform === "win32" && /^(?:npm|npx)$/u.test(file);
      const child = viaShell ? spawn(command, { shell: true, stdio: "inherit" }) : spawn(file, args, { stdio: "inherit" });
      child.on("exit", code => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
  } finally {
    done();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
