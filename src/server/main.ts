import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { REPO_ROOT, practiceSite } from "../core/assets.ts";
import { stopPlaywright } from "../agents/web/browser/index.ts";
import { createPracticeSite } from "../practice_site/serve.ts";
import { makeApp } from "./app.ts";
import { AgentRuntime, loadConfig } from "./runtime.ts";

function listen(server: Server, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    function ready() {
      server.off("error", reject);
      resolve();
    }
    server.once("error", reject);
    server.listen(port, host, ready);
  });
}
function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

async function ensurePracticeSite() {
  try {
    const existing = await fetch("http://localhost:5174/", { signal: AbortSignal.timeout(1500) });
    await existing.body?.cancel();
    if (existing.ok) return async () => {};
  } catch {
    /* 모의 사이트가 없으면 같은 포트에 띄운다. */
  }
  const site = await createPracticeSite(practiceSite).startMockSite(5174);
  return site.close;
}

export async function build(desktop = false, env: NodeJS.ProcessEnv = process.env) {
  const settings = { ...env };
  if (desktop) {
    settings.PRACTICE_MODE ??= "false";
    settings.CHEONGEUM_DATA_DIR ??= join(homedir(), ".cheongeum-ts");
  }
  const runtime = await AgentRuntime.create(loadConfig(settings));
  const app = makeApp(runtime, { web: true, csp: desktop });
  void runtime.stt.warm?.().catch(() => {});
  async function close() {
    await app.sessions.close();
    await runtime.close();
    await stopPlaywright();
  }
  return { app, runtime, close };
}

export async function main(args = process.argv.slice(2)) {
  if (existsSync(join(REPO_ROOT, ".env"))) process.loadEnvFile(join(REPO_ROOT, ".env"));
  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string", default: "localhost" },
      port: { type: "string" },
      desktop: { type: "boolean", default: false },
      "no-mock": { type: "boolean", default: false },
    },
  });
  const desktop = values.desktop;
  const port = Number(
    values.port ?? (desktop ? process.env.DESKTOP_PORT : process.env.PORT) ?? (desktop ? 8790 : 8787),
  );
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("올바른 포트가 필요합니다.");
  const stopMock = values["no-mock"] ? async () => {} : await ensurePracticeSite();
  try {
    const { app, runtime, close } = await build(desktop);
    const server = createServer(getRequestListener(app.fetch));
    let closing: Promise<void> | undefined;
    function stop() {
      closing ??= Promise.allSettled([closeServer(server), close(), stopMock()]).then(() => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.stdin.off("end", stop);
        process.stdin.off("error", stop);
        if (desktop && process.env.CHEONGEUM_PARENT_PIPE === "1") process.stdin.pause();
      });
      return closing;
    }
    try {
      await listen(server, values.host, port);
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      const url = "http://localhost:" + boundPort;
      const tag = desktop ? "desktop" : "server";
      process.stdout.write(`[${tag}] ${url}  (LLM: ${runtime.intentProvider.name}, 복지데이터: ${runtime.welfareProvider.mode})\n`);
      const browser = runtime.config.headless ? "headless" : "headed";
      process.stdout.write(`[${tag}] 허용 출처: ${runtime.allowedOrigins.join(", ")}  · 브라우저: ${browser}\n`);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (desktop) {
        process.stdout.write("[desktop] ready " + url + "\n");
        if (process.env.CHEONGEUM_PARENT_PIPE === "1") {
          process.stdin.once("end", stop);
          process.stdin.once("error", stop);
          process.stdin.resume();
        }
      }
    } catch (e) {
      await stop();
      throw e;
    }
    return { server, stop };
  } catch (e) {
    await stopMock();
    throw e;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write("[server] 서버를 시작할 수 없습니다. 포트와 실행 환경을 확인하세요.\n");
    process.exitCode = 1;
  });
}
