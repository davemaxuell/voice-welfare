import { expect, it } from "vitest";
import { AVATAR_CSP, CSP, makeApp } from "../../src/server/app.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { UnsupportedSttProvider } from "../../src/voice/stt.ts";
import { UnsupportedTtsProvider } from "../../src/voice/tts.ts";

function app() {
  const runtime = new AgentRuntime(loadConfig({}), new UnsupportedSttProvider(), new UnsupportedTtsProvider());
  return makeApp(runtime, { port: 8790, csp: true });
}

it("test_refused_requests_never_reach_runtime", async () => {
  const api = app();
  const cases: [string, string, Record<string, string>, string | undefined, number, string][] = [
    ["GET", "health", { host: "example.invalid:8790" }, undefined, 400, "INVALID_HOST"],
    ["GET", "health", { host: "[invalid]:8790" }, undefined, 400, "INVALID_HOST"],
    ["POST", "session", { host: "localhost:8787" }, undefined, 400, "INVALID_HOST"],
    ["POST", "session", { origin: "null" }, undefined, 403, "INVALID_ORIGIN"],
    ["POST", "session", { origin: "http://localhost:8787" }, undefined, 403, "INVALID_ORIGIN"],
    ["POST", "session", { "sec-fetch-site": "cross-site" }, undefined, 403, "INVALID_ORIGIN"],
    ["POST", "turn", { "content-type": "text/plain" }, "{}", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["POST", "audio/transcribe", { "content-type": "application/json" }, "{}", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["POST", "audio/speak", { "content-type": "audio/webm" }, "a", 415, "UNSUPPORTED_MEDIA_TYPE"],
  ];
  for (const [method, path, headers, body, status, code] of cases) {
    const result = await api.request("http://localhost:8790/api/" + path, { method, headers, body });
    expect(result.status).toBe(status);
    expect(await result.json()).toMatchObject({ error: code });
  }
  expect(api.sessions.size).toBe(0);
});

it("test_local_api_accepts_same_origin_and_non_browser_clients", async () => {
  const api = app();
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const url = "http://" + host + ":8790";
    for (const browser of [true, false]) {
      const headers = new Headers({ "content-type": "application/json" });
      if (browser) {
        headers.set("origin", url);
        headers.set("sec-fetch-site", "same-origin");
      }
      const response = await api.request(url + "/api/turn", { method: "POST", headers, body: "{}" });
      expect(await response.json()).toMatchObject({ error: "BAD_REQUEST" });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(await (await api.request(url + "/api/session/synthetic", { method: "DELETE" })).json())
      .toMatchObject({ error: "SESSION_NOT_FOUND" });
  }
});

it("allows avatar texture blobs only within the avatar document", async () => {
  const api = app();
  expect((await api.request("/avatar/index.html")).headers.get("Content-Security-Policy")).toBe(AVATAR_CSP);
  expect((await api.request("/")).headers.get("Content-Security-Policy")).toBe(CSP);
  expect(AVATAR_CSP).toContain("connect-src 'self' blob:");
});
