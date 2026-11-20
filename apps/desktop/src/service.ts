/**
 * 데스크톱 앱의 로컬 서비스(API + 웹 UI + 모의 사이트). Electron 유틸리티 프로세스로 뜬다.
 * - 루프백 주소에만 묶는다. 설치본은 지난번 포트를 다시 쓰고(마이크 선택이 출처에 묶임), 쓰는 중이면 빈 포트로 옮긴다.
 * - 묶은 주소는 부모 포트로 알린다. 부모가 shutdown을 보내면 세션·브라우저를 정리하고 끝낸다.
 */
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { createHttpService } from "../../../src/server/http.ts";
import { REPO_ROOT } from "../../../src/core/assets.ts";
import { bindLocal, serviceEnvironment, startPracticeSite } from "../../../src/server/launcher.ts";
import { build, listenPort } from "../../../src/server/main.ts";
import { isShutdown, type ReadyMessage } from "./protocol.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: "localhost" },
      port: { type: "string" },
      "env-file": { type: "string", default: join(REPO_ROOT, ".env") },
      "no-mock": { type: "boolean", default: false },
    },
  });
  const envFile = values["env-file"];
  const runtimeDir = process.env.CHEONGEUM_DESKTOP_RUNTIME;
  const parent: Electron.ParentPort | undefined = process.parentPort;
  const bundled = parent !== undefined && runtimeDir !== undefined && runtimeDir !== "";
  const env = serviceEnvironment(envFile, bundled);
  const configured = env.DESKTOP_PORT;
  const configuredSet = configured !== undefined && configured !== "";
  const port = listenPort(values.port, true, env);
  if (!["localhost", "127.0.0.1", "::1"].includes(values.host)) throw new Error("--host는 루프백 주소여야 합니다.");
  const auto = bundled && values.port === undefined && !configuredSet;

  const stopMock = values["no-mock"] ? async () => {} : await startPracticeSite(env, bundled);
  const { app, runtime, close } = await build(true, env);
  const { server, closeServer } = createHttpService(app);
  let closing: Promise<void> | undefined;
  function stop() {
    closing ??= Promise.allSettled([closeServer(), close(), stopMock()]).then(() => process.exit(0));
    return closing;
  }
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  parent?.on("message", (event) => {
    if (isShutdown(event.data)) void stop();
  });

  const bound = await bindLocal(server, values.host, port, auto ? join(dirname(envFile), "service-port") : undefined);
  const host = values.host.includes(":") ? `[${values.host}]` : values.host;
  const url = `http://${host}:${bound}`;
  process.stdout.write(`[desktop] ${url}  (LLM: ${runtime.intentProvider.name}, 복지데이터: ${runtime.welfareProvider.mode})\n`);
  const browser = runtime.config.headless ? "headless" : "headed";
  process.stdout.write(`[desktop] 허용 출처: ${runtime.allowedOrigins.join(", ")}  · 브라우저: ${browser}\n`);
  process.stdout.write(`[desktop] ready ${url}\n`);
  const ready: ReadyMessage = { type: "ready", url };
  parent?.postMessage(ready);
}

main().catch((error: unknown) => {
  process.stderr.write(`[desktop] 서비스를 시작할 수 없습니다: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
