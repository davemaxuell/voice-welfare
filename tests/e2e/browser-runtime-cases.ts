import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { z } from "zod";
import { PlaywrightExecutionAdapter } from "../../src/agents/web/browser/index.ts";
import type { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { Seal } from "../../src/personal/seal.ts";
import { makeApp } from "../../src/server/app.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { SettingsStore } from "../../src/server/settings.ts";
import type { SttProvider } from "../../src/voice/stt.ts";
import { testRuntimeEnv } from "../helpers.ts";

export function adapterFor(session: SessionOrchestrator) {
  if (!(session.web.adapter instanceof PlaywrightExecutionAdapter)) throw new Error("Expected a browser session");
  return session.web.adapter;
}

export function pageFor(session: SessionOrchestrator) {
  const page = adapterFor(session).page;
  if (!page) throw new Error("Session has no open page");
  return page;
}

export function runtimeCases() {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  return async function create(env: Record<string, string> = {}, options: {settings?: boolean; stt?: SttProvider; fetch?: typeof fetch} = {}) {
    const folder = await mkdtemp(join(tmpdir(), "cheongeum-browser-api-"));
    cleanups.push(() => rm(folder, {recursive: true, force: true}));
    const path = join(folder, "preferences.json"), seal = new Seal({key: Buffer.alloc(32, 42)});
    const settings = () => new SettingsStore(path, () => seal);
    const config = loadConfig(testRuntimeEnv({CHEONGEUM_DATA_DIR: join(folder, "data"), CHROME_PROFILE_DIR: join(folder, "profile"), ...env}));
    const fetcher = options.fetch ?? (async () => { throw new Error("Unexpected provider traffic"); });
    const runtime = new AgentRuntime(config, options.stt, undefined, fetcher, options.settings === true ? settings() : undefined);
    runtime.sealFactory = () => seal;
    const app = makeApp(runtime, {stt: options.stt});
    cleanups.push(async () => { await app.workflows.close(); await app.sessions.close(); await runtime.close(); });
    async function post(url: string, body?: unknown) {
      return app.request(url, {method: "POST", ...(body === undefined ? {} : {headers: {"content-type": "application/json"}, body: JSON.stringify(body)})});
    }
    async function session() {
      const response = await post("/api/session"); expect(response.status).toBe(200);
      const {sessionId} = z.object({sessionId: z.string()}).parse(await response.json());
      const session = app.sessions.get(sessionId);
      if (!session) throw new Error("Session was not registered");
      return {session, id: sessionId};
    }
    return { app, post, session, runtime, config, folder, path, settings, seal };
  };
}
