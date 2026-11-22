import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createHttpService } from "./http.ts";
import { REPO_ROOT } from "../core/assets.ts";
import { stopPlaywright } from "../agents/web/browser/index.ts";
import { textOr } from "../core/text.ts";
import { bindLocal, serviceEnvironment, startPracticeSite, toPort } from "./launcher.ts";
import { makeApp } from "./app.ts";
import { AgentRuntime, loadConfig } from "./runtime.ts";
import { SettingsStore } from "./settings.ts";
import { ownInstance } from "./instance.ts";

export async function build(desktop = false, env: NodeJS.ProcessEnv = process.env) {
  const settings = { ...env };
  if (desktop) {
    settings.PRACTICE_MODE ??= "false";
    settings.CHEONGEUM_DATA_DIR ??= join(homedir(), ".cheongeum");
    if (settings.CHEONGEUM_DESKTOP_RUNTIME !== undefined && settings.CHEONGEUM_DESKTOP_RUNTIME !== "") {
      settings.PII_MODEL ??= join(settings.CHEONGEUM_DESKTOP_RUNTIME, "models", "koelectra-ko-pii-ner");
    }
  }
  const directory = textOr(settings.CHEONGEUM_SETTINGS_DIR, join(homedir(), ".cheongeum"));
  const store = new SettingsStore(join(directory, "preferences.json"));
  const runtime = await AgentRuntime.create(loadConfig(settings), fetch, store);
  const app = makeApp(runtime, { web: true, csp: desktop, workflowDsn: settings.CHEONGEUM_DATABASE_URL ?? "" });
  await app.workflows.reconfigure();

  async function close() {
    await app.workflows.close();
    await app.sessions.close();
    await runtime.close();
    await stopPlaywright();
  }
  return { app, runtime, close };
}

export function listenPort(cliPort: string | undefined, desktop: boolean, env: NodeJS.ProcessEnv = process.env) {
  const text = cliPort ?? textOr(env[desktop ? "DESKTOP_PORT" : "PORT"], desktop ? "8790" : "8787");
  return toPort(text);
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string", default: "localhost" },
      port: { type: "string" },
      "env-file": { type: "string", default: join(REPO_ROOT, ".env") },
      desktop: { type: "boolean", default: false },
      "no-mock": { type: "boolean", default: false },
    },
  });
  if (!["localhost", "127.0.0.1", "::1"].includes(values.host)) throw new Error("--host는 루프백 주소여야 합니다.");
  const desktop = values.desktop;
  const envFile = values["env-file"];
  const child = desktop && process.env.CHEONGEUM_PARENT_PIPE === "1";
  const bundled = child && Boolean(process.env.CHEONGEUM_DESKTOP_RUNTIME);
  const env = serviceEnvironment(envFile, desktop && Boolean(process.env.CHEONGEUM_DESKTOP_RUNTIME));
  const port = listenPort(values.port, desktop, env);
  const saved = bundled && values.port === undefined && (env.DESKTOP_PORT ?? "") === "" ? join(dirname(envFile), "service-port") : undefined;
  const stopMock = values["no-mock"] ? async () => {} : await startPracticeSite(env, bundled);
  try {
    const { app, runtime, close } = await build(desktop, env);
    const { server, closeServer } = createHttpService(app);
    let closing: Promise<void> | undefined;
    function stop() {
      closing ??= Promise.allSettled([closeServer(), close(), stopMock()]).then(() => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.stdin.off("end", stop);
        process.stdin.off("error", stop);
        if (child) process.stdin.pause();
      });
      return closing;
    }
    let url: string;
    try {
      const boundPort = await bindLocal(server, values.host, port, saved);
      const host = values.host.includes(":") ? `[${values.host}]` : values.host;
      url = `http://${host}:${boundPort}`;
      const tag = desktop ? "desktop" : "server";
      process.stdout.write(`[${tag}] ${url}  (LLM: ${runtime.intentProvider.name}, 복지데이터: ${runtime.welfareProvider.mode})\n`);
      const browser = runtime.config.headless ? "headless" : "headed";
      process.stdout.write(`[${tag}] 허용 출처: ${runtime.allowedOrigins.join(", ")}  · 브라우저: ${browser}\n`);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (desktop) {
        process.stdout.write("[desktop] ready " + url + "\n");
        if (child) {
          process.stdin.once("end", stop);
          process.stdin.once("error", stop);
          process.stdin.resume();
        }
      }
    } catch (e) {
      await stop();
      throw e;
    }
    return { server, stop, showOnLaunch: !desktop && !runtime.config.headless, activate() {
      if (app.presentation.activate()) return;
      void runtime.showController(url).catch(() => {
        const [command, ...args] = process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] :
          process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
        const opener = spawn(command!, args, { detached: true, stdio: "ignore", windowsHide: true });
        opener.on("error", error => console.warn("[server] 대화 창을 앞에 띄울 수 없어요.", error.name));
        opener.unref();
      });
    } };
  } catch (e) {
    await stopMock();
    throw e;
  }
}

async function launch() {
  let activate: (() => void) | undefined;
  let requested = false;
  const owner = await ownInstance(() => { requested = true; activate?.(); });
  if (owner === undefined) return;
  try {
    const service = await main();
    activate = service.activate;
    if (requested || service.showOnLaunch) activate();
    service.server.once("close", () => { void owner.close(); });
  } catch (error) { await owner.close(); throw error; }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  launch().catch(() => {
    process.stderr.write("[server] 서버를 시작할 수 없습니다. 포트와 실행 환경을 확인하세요.\n");
    process.exitCode = 1;
  });
}
