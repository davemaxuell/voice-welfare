import { setTimeout as delay } from "node:timers/promises";
import { createServer as createVite, type Plugin } from "vite";
import type { Page } from "@playwright/test";
import viteConfig from "../../vite.config.ts";
import { makeApp } from "../../src/server/app.ts";
import { createHttpService } from "../../src/server/http.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import type { SttProvider } from "../../src/voice/stt.ts";
import type { TtsProvider } from "../../src/voice/tts.ts";
import { testRuntimeEnv } from "../helpers.ts";

const textStt: SttProvider = {
  name: "test-text", supported: true,
  live: {
    model: "test-text",
    async transcribe(frames) {
      const chunks: Uint8Array[] = [];
      for await (const frame of frames) chunks.push(frame);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text.includes("어디까지")) await delay(6000);
      return text;
    },
  },
  async transcribe(audio) {
    const text = new TextDecoder().decode(audio).trim();
    if (!text.includes("어디까지")) await delay(6000);
    return { text };
  },
};
const textTts: TtsProvider = {
  name: "test-tts", supported: true,
  async synthesize(text) { return { audio: new TextEncoder().encode(text), mimeType: "audio/mpeg" }; },
};

export async function startUi(voice = false, overrides: Record<string, string> = {}, prepared?: AgentRuntime) {
  const supplied = prepared === undefined ? (voice ? process.env.CHEONGEUM_UI_TEST_VOICE_API_URL : process.env.CHEONGEUM_UI_TEST_API_URL) : undefined;
  const service = prepared ?? new AgentRuntime(loadConfig(testRuntimeEnv({ REQUIRE_CONSENT: "true", ...overrides })),
    voice ? textStt : undefined, voice ? textTts : undefined);
  const app = makeApp(service);
  const http = createHttpService(app);
  // UI modules and the native API share a port, as they do in the desktop app.
  const localApi: Plugin = {
    name: "native-ui-test-api",
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/api/") === true) http.server.emit("request", req, res);
        else next();
      });
      vite.httpServer?.on("upgrade", (req, socket, head) => {
        if (req.url?.startsWith("/api/") === true) http.server.emit("upgrade", req, socket, head);
      });
    },
  };
  const vite = await createVite({ ...viteConfig, configFile: false, logLevel: "error",
    plugins: supplied === undefined ? [localApi] : [],
    server: { ...viteConfig.server, host: "127.0.0.1", port: 0, open: false, hmr: false,
      proxy: supplied === undefined ? {} : { "/api": { target: supplied, ws: true } } },
  });
  async function reset() {
    for (const session of app.sessions.values()) {
      app.sessions.remove(session.id);
      await session.close();
    }
  }
  async function close() {
    await http.closeServer();
    await vite.close();
    await app.workflows.close();
    await app.sessions.close();
    await service.close();
  }
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (address == null || typeof address === "string") throw new Error("Vite 서버 주소가 없습니다.");
    return { url: `http://127.0.0.1:${address.port}/`, reset, close };
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
  if (!voice) {
    await page.route("**/api/health", async route => {
      const response = await route.fetch();
      const health: unknown = await response.json();
      if (health === null || typeof health !== "object") throw new Error("Invalid health response");
      await route.fulfill({ json: { ...health, tts: { supported: true, provider: "test-tts" } } });
    });
    await page.route("**/api/audio/speak", route => route.fulfill({ status: 503, json: { message: "시험 음성" } }));
  }
  const speech = voice ? `
    export const serverTts = {
      cancel() {},
      async speak() {
        const start = performance.now();
        await new Promise(resolve => setTimeout(resolve, 2500));
        (window.__talking ??= []).push([start, performance.now()]);
        return "played";
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
    function clip(open, text) {
      const result = open();
      const bytes = new Uint8Array(2048).fill(32);
      bytes.set(new TextEncoder().encode(text));
      result.append(bytes.buffer);
      return result;
    }
    export async function startRecording(open) {
      return { stop: async () => clip(open, '기초연금'), cancel() {} };
    }
    export async function listMicrophones() { return []; }
    export function preferredMicrophone() { return undefined; }
    export class VoiceLoop {
      constructor(open) { this.open = open; }
      async start() {}
      get deviceLabel() { return '시험 마이크'; }
      async isSilent() { return false; }
      async startClapDetector() {}
      listenOnce() {
        const text = clips.shift();
        if (text !== undefined) return Promise.resolve(clip(this.open, text));
        return new Promise(resolve => { this.pending = resolve; });
      }
      cancelListening() { this.pending?.(null); this.pending = undefined; }
      watchBargeIn() { return () => {}; }
      async listenAfterBarge() { return null; }
      stop() { this.cancelListening(); }
    }
  `);
}
