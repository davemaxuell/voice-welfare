import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as createVite } from "vite";
import type { Page } from "@playwright/test";
import { REPO_ROOT } from "../../src/core/assets.ts";

const host = "127.0.0.1";
type Cleanup = () => void | Promise<unknown>;

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("시험 서버 주소가 없습니다.");
  return address.port;
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
}

// 브라우저의 합성 녹음만 받아쓴다. 실제 서버가 오디오 요청의 동의, 턴, 진행 물음을 처리한다.
async function textStt(cleanup: Cleanup[]) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/audio/transcriptions") {
        response.writeHead(404).end();
        return;
      }
      const body = new Response(await buffer(request), { headers: { "content-type": request.headers["content-type"] ?? "" } });
      const file = (await body.formData()).get("file");
      if (!(file instanceof Blob)) throw new Error("받아쓸 녹음이 없습니다.");
      const text = (await file.text()).trim();
      if (!text.includes("어디까지")) await delay(6000);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text }));
    } catch (error) {
      response.writeHead(400).end(String(error));
    }
  });
  const port = await listen(server);
  cleanup.push(() => closeServer(server));
  return `http://${host}:${port}`;
}

async function startApi(voice: boolean, cleanup: Cleanup[]) {
  const supplied = voice ? process.env.CHEONGEUM_UI_TEST_VOICE_API_URL : process.env.CHEONGEUM_UI_TEST_API_URL;
  if (supplied !== undefined) return supplied;
  const sttUrl = voice ? await textStt(cleanup) : undefined;
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  const tsMain = join(REPO_ROOT, "src/server/main.ts");
  const flags = ["--host", host, "--port", String(port), "--no-mock"];
  const child = spawn(process.execPath, [tsMain, ...flags], {
    cwd: REPO_ROOT, stdio: "inherit", windowsHide: true, detached: process.platform !== "win32",
    env: {
      ...process.env, HEADLESS: "true", REQUIRE_CONSENT: "true", PRACTICE_MODE: "true", BROWSER_MODE: "chromium",
      MOCK_SITE_URL: "http://localhost:5174", BROWSER_SLOWMO_MS: "0", VISUAL_CURSOR: "false",
      READ_ONLY_CLICKS: "safe", READ_ONLY_WEB: "true", WEB_SEARCH_URL: "http://127.0.0.1:5174/external.html?q={q}",
      LLM_PROVIDER: "mock", LLM_UNDERSTAND_PROVIDER: "mock", LLM_GOAL_PROVIDER: "mock", LLM_WEB_PROVIDER: "mock",
      STT_PROVIDER: voice ? "local" : "mock", STT_BASE_URL: sttUrl ?? "", STT_MODEL: "test-text",
      TTS_PROVIDER: "mock", PII_MODEL: "", CHEONGEUM_DATA_DIR: "", WELFARE_DATA_MODE: "mock",
    },
  });
  let failure: Error | undefined;
  child.on("error", error => { failure = error; });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  cleanup.push(async () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
    await exited;
  });
  const url = `http://${host}:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (failure !== undefined) throw failure;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`UI 시험 API 종료: ${child.exitCode ?? child.signalCode}`);
    try {
      const health = await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) });
      await health.body?.cancel();
      if (health.ok) return url;
    } catch { /* 서버가 아직 listen하기 전 */ }
    await delay(100);
  }
  throw new Error(`UI 시험 API 시작 시간 초과: ${url}`);
}

export async function startUi(voice = false) {
  const cleanup: Cleanup[] = [];
  const close = async () => {
    for (const stop of cleanup.reverse()) await stop();
  };
  try {
    const api = await startApi(voice, cleanup);
    const vite = await createVite({
      configFile: join(REPO_ROOT, "vite.config.ts"), logLevel: "error",
      server: { host, port: 0, open: false, hmr: false, proxy: { "/api": api } },
    });
    cleanup.push(() => vite.close());
    await vite.listen();
    const address = vite.httpServer?.address();
    if (address == null || typeof address === "string") throw new Error("Vite 서버 주소가 없습니다.");
    return { url: `http://${host}:${address.port}/`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

declare global {
  interface Window {
    __cues?: Array<[string, number]>;
    __talking?: Array<[number, number]>;
  }
}

async function replaceModule(page: Page, name: "mic" | "speaker", body: string) {
  const path = `/src/${name}.ts`;
  await page.route(url => url.pathname === path && !url.searchParams.has("original"), route =>
    route.fulfill({ contentType: "text/javascript", body: `export * from '${path}?original';\n` + body }),
  );
}

export async function recordCues(page: Page, voice = false) {
  const speech = voice ? `
    export const browserTts = {
      supported: true, speak() {}, cancel() {},
      async speakAndWait() {
        const start = performance.now();
        await new Promise(resolve => setTimeout(resolve, 2500));
        (window.__talking ??= []).push([start, performance.now()]);
      },
    };` : "";
  await replaceModule(page, "speaker", `
    import { earcon as play } from '/src/speaker.ts?original';
    export function earcon(kind) {
      (window.__cues ??= []).push([kind, performance.now()]);
      return play(kind);
    }
    ${speech}
  `);
  if (!voice) return;
  await replaceModule(page, "mic", `
    const clips = ['장애인연금이 뭐야', '지금 어디까지 했어?'];
    export const browserStt = { supported: false };
    export async function listMicrophones() { return []; }
    export class VoiceLoop {
      async start() {}
      get deviceLabel() { return '시험 마이크'; }
      async isSilent() { return false; }
      async startClapDetector() {}
      listenOnce() {
        const text = clips.shift();
        if (text !== undefined) return Promise.resolve(new Blob([text.padEnd(300, ' ')], { type: 'audio/webm' }));
        return new Promise(resolve => { this.pending = resolve; });
      }
      cancelListening() { this.pending?.(null); this.pending = undefined; }
      watchBargeIn() { return () => {}; }
      async listenAfterBarge() { return null; }
      stop() { this.cancelListening(); }
    }
  `);
}
