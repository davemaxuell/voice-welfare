import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, it, vi } from "vitest";
import { makeApp } from "../../src/server/app.ts";
import { InMemoryEventLog } from "../../src/core/events.ts";
import { UnsupportedSttProvider } from "../../src/voice/stt.ts";
import { UnsupportedTtsProvider } from "../../src/voice/tts.ts";
import { createTestRuntime, openBrowserTranscript } from "./session-runtime.ts";
import { fixtureIndex, loadTranscript, replayTranscript } from "./transcripts.ts";

const base = new URL("../fixtures/transcripts/", import.meta.url);
const index = fixtureIndex.parse(JSON.parse(readFileSync(new URL("index.json", base), "utf8")));
const runtime = createTestRuntime();
afterAll(runtime.close);
const open = openBrowserTranscript(runtime, async (session) => {
  const app = makeApp({
    async createSession() {
      return session;
    },
    intentProvider: session.deps.intentProvider,
    welfareProvider: session.deps.welfare.provider,
    llmRoles: () => ({}),
    events: new InMemoryEventLog(),
    stt: new UnsupportedSttProvider(),
    tts: new UnsupportedTtsProvider(),
  });
  const created = await app.request("/api/session", { method: "POST" });
  assert.equal(created.status, 200);
  assert.equal(((await created.json()) as { sessionId: string }).sessionId, session.id);
  return async (call) => {
    const sessionPath = "/api/session/" + session.id;
    let path: string;
    let body: object | undefined;
    switch (call.method) {
      case "handle_turn":
        path = "/api/turn";
        body = { sessionId: session.id, text: call.args[0] };
        break;
      case "confirm":
        path = sessionPath + "/confirm";
        body = { approve: call.args[0] };
        break;
      case "cancel":
        path = sessionPath + "/cancel";
        break;
      case "consent_to":
        path = sessionPath + "/consent";
        body = { granted: call.args[0] };
        break;
      case "set_language":
        path = sessionPath + "/language";
        body = { lang: call.args[0] };
        break;
    }
    const response = await app.request(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 200, path);
    return response.json();
  };
});
for (const entry of index.cases) {
  it("HTTP " + entry.slice + " " + entry.case, async () => {
    const tape = loadTranscript(base, entry);
    vi.stubEnv("TZ", "Asia/Seoul");
    vi.setSystemTime(new Date(tape.session.calendarDay + "T03:00:00.000Z"));
    try {
      await replayTranscript(tape, open);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
}
