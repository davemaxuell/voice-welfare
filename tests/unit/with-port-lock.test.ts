import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/core/assets.ts";
import { isProcessAlive, release, tryAcquire } from "../../scripts/with-port-lock.ts";

let directory: string;
let lockPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cheongeum-lock-"));
  lockPath = join(directory, "port.lock");
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe("tryAcquire", () => {
  it("takes a lock nobody holds and records its holder", () => {
    expect(tryAcquire(lockPath, { pid: process.pid, command: "a" })).toBe("acquired");
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid, command: "a" });
  });

  it("reports busy while the holder is alive", () => {
    tryAcquire(lockPath, { pid: process.pid, command: "a" });
    expect(tryAcquire(lockPath, { pid: 999_999, command: "b" }, () => true)).toBe("busy");
    expect(JSON.parse(readFileSync(lockPath, "utf8")).command).toBe("a");
  });

  it("takes over a lock whose holder is gone", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, command: "dead" }));
    expect(tryAcquire(lockPath, { pid: process.pid, command: "b" }, () => false)).toBe("acquired");
    expect(JSON.parse(readFileSync(lockPath, "utf8")).command).toBe("b");
  });

  it("takes over a lock file it cannot read", () => {
    writeFileSync(lockPath, "not json");
    expect(tryAcquire(lockPath, { pid: process.pid, command: "b" })).toBe("acquired");
  });
});

describe("release", () => {
  it("removes only its own lock", () => {
    tryAcquire(lockPath, { pid: 111, command: "a" }, () => true);
    release(lockPath, 222);
    expect(existsSync(lockPath)).toBe(true);
    release(lockPath, 111);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("isProcessAlive", () => {
  it("sees this process and not an unused pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_000_000)).toBe(false);
  });
});

describe("command line", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/with-port-lock.ts", ...args], { cwd: REPO_ROOT, encoding: "utf8" });

  it("runs the command, returns its exit code and leaves no lock behind", () => {
    const result = run("--lock", lockPath, "--", process.execPath, "-e", "process.exit(7)");
    expect(result.status).toBe(7);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("gives up with its own exit code when the lock stays busy", () => {
    tryAcquire(lockPath, { pid: process.pid, command: "holder" });
    const result = run("--lock", lockPath, "--wait-minutes", "0", "--", process.execPath, "-e", "0");
    expect(result.status).toBe(3);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("refuses an empty command", () => {
    expect(run("--lock", lockPath).status).toBe(2);
  });
});
