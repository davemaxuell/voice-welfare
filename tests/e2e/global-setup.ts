import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { practiceSite, REPO_ROOT } from "../../src/core/assets.ts";

async function portState(port: number, checkout: string) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual", signal: AbortSignal.timeout(1500),
    });
    await response.body?.cancel();
    return response.headers.get("X-Ieum-Checkout") === checkout ? "ours" : "other";
  } catch (error) {
    if (error instanceof TypeError && error.cause instanceof Error &&
        "code" in error.cause && error.cause.code === "ECONNREFUSED") return "free";
    return "other";
  }
}

export async function ensureMockSite(port: number, waitSeconds: number) {
  const checkout = createHash("sha1").update(await realpath(practiceSite)).digest("hex").slice(0, 12);
  const waitUntil = Date.now() + waitSeconds * 1000;
  let startupDeadline: number | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let spawnError: Error | undefined;
  const stop = () => {
    if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  };
  try {
    while (true) {
      const state = await portState(port, checkout);
      if (state === "ours") return stop;
      if (spawnError !== undefined) throw spawnError;
      if (child !== undefined && child.exitCode !== null && state === "free") {
        throw new Error(`모의 사이트 시작 실패 (종료 코드 ${child.exitCode}).`);
      }
      if (state === "free" && child === undefined) {
        startupDeadline = Date.now() + 90_000;
        child = spawn("uv", ["run", "cheongeum-mock", "--port", String(port)], {
          cwd: REPO_ROOT, detached: process.platform !== "win32", windowsHide: true, stdio: "inherit",
        });
        child.on("error", (error) => { spawnError = error; });
      }
      const deadline = state === "other" ? waitUntil : startupDeadline ?? waitUntil;
      if (Date.now() >= deadline) throw new Error(`포트 ${port}에서 이 체크아웃의 모의 사이트를 시작하지 못했습니다.`);
      await delay(child === undefined ? 2000 : 100);
    }
  } catch (error) {
    stop();
    throw error;
  }
}

export default function setup() {
  const wait = Number(process.env.MOCK_SITE_WAIT_S ?? 120);
  if (!Number.isFinite(wait) || wait < 0) throw new Error("MOCK_SITE_WAIT_S에는 0 이상의 초를 입력하세요.");
  return ensureMockSite(5174, wait);
}
