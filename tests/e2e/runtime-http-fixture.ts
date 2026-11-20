import { once } from "node:events";
import { WebSocket } from "ws";
import { z } from "zod";
import { makeApp } from "../../src/server/app.ts";
import { createHttpService } from "../../src/server/http.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { testRuntimeEnv } from "../helpers.ts";

export const Credentials = z.object({ sessionId: z.string(), writer: z.string(), token: z.string() });
export const Checkpoint = z.object({ checkpoint: z.object({ state: z.string(), stopGeneration: z.number().optional(), approvalKind: z.string().optional() }) });
export const Approval = z.object({ pendingConfirmation: z.object({ kind: z.string(), actionId: z.string() }) });

export function apiFixture(env: Record<string, string> = {}, options: Parameters<typeof makeApp>[1] = {}) {
  const rt = new AgentRuntime(loadConfig(testRuntimeEnv(env)), undefined, undefined, async () => { throw new Error("unexpected provider call"); });
  const api = makeApp(rt, options);
  async function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
    return api.request(path, { method: "POST", headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function close() { await api.workflows.close(); await api.sessions.close(); await rt.close(); }
  return { rt, api, post, close };
}

export async function serveFixture(api: Parameters<typeof createHttpService>[0]) {
  const service = createHttpService(api);
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const addr = service.server.address();
  if (addr === null || typeof addr === "string") throw new Error("No TCP listener");
  const port = addr.port;
  const origin = "http://127.0.0.1:" + port;
  async function connect(path: string) {
    const ws = new WebSocket("ws://127.0.0.1:" + port + path, { origin });
    await once(ws, "open");
    return ws;
  }
  async function packet(path: string, hello: object, ...frames: (Uint8Array | string)[]) {
    const ws = await connect(path);
    const received = new Promise<unknown>((resolve, reject) => {
      ws.once("error", reject);
      ws.once("message", data => {
        try { resolve(JSON.parse(String(data))); } catch (e) { reject(e); }
      });
      ws.once("close", () => reject(new Error("socket closed before a response")));
    });
    try {
      ws.send(JSON.stringify(hello));
      for (const frame of frames) ws.send(frame);
      return await received;
    } finally { ws.close(); }
  }
  return { ...service, origin, connect, packet };
}
