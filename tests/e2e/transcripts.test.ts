import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
import { closeTranscriptRuntime, fixtureIndex, loadTranscript, openSlice, replayTranscript } from "./transcripts.ts";
import type { OpenTranscript } from "./transcripts.ts";

const directory = new URL("../fixtures/transcripts/", import.meta.url);
const catalog = fixtureIndex.parse(JSON.parse(readFileSync(new URL("index.json", directory), "utf8")));
afterAll(closeTranscriptRuntime);
for (const entry of catalog.cases) {
  const tape = loadTranscript(directory, entry);
  const open = openSlice.get(entry.slice);
  if (entry.excluded !== undefined || open === undefined) {
    it.skip(`${entry.slice} ${entry.case} (${entry.excluded ?? "session pending"})`);
  } else {
    it(`${entry.slice} ${entry.case}`, async () => {
      // Only the Node wall clock is fixed. Chromium, actionability and performance timers run normally.
      vi.stubEnv("TZ", "Asia/Seoul");
      vi.setSystemTime(new Date(tape.session.calendarDay + "T03:00:00.000Z"));
      try { await replayTranscript(tape, open); }
      finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
    });
  }
}

it("checks model inputs, turn output and session effects during replay", async () => {
  const session = { kind: "session", case: "control", calendarDay: "2026-11-18", initialPersonal: {},
    actionLogEnabled: false, config: { mockSiteUrl: "http://localhost:5174", searchUrlTemplate: "{q}",
      requireConsent: false, practiceMode: true, readOnlyClicks: "safe", readOnlyWeb: true } } as const;
  const system = "안내", user = "질문";
  const llm = [{ schemaName: "reply", user, systemHash: createHash("sha256").update(system).digest("hex"), reply: { value: "응답" } }];
  const open: OpenTranscript = async () => {
    let generate: Parameters<Awaited<ReturnType<OpenTranscript>>["bindModels"]>[1] = () => undefined;
    return {
      bindModels(_roles, model) { generate = model; },
      async dispatch() { return { speech: generate({ system, user, schemaName: "reply" }) }; },
      inspect() { return { slots: {}, personal: {}, actionLog: [] }; },
      async close() {},
    };
  };
  const row: Parameters<typeof replayTranscript>[0]["turns"][number] = {
    kind: "turn", call: { method: "handle_turn", args: [user] }, roles: ["default"],
    llm, result: { speech: "응답" }, slots: {}, personal: {}, actionLog: [],
  };
  await replayTranscript({ session, turns: [row] }, open);
  for (const change of [{ result: { speech: "다른 답" } }, { personal: { name: "김하늘" } },
    { llm: llm.map(call => ({ ...call, user: "다른 질문" })) }, { llm: llm.map(call => ({ ...call, schemaName: "unknown" })) }]) {
    await expect(replayTranscript({ session, turns: [{ ...row, ...change }] }, open)).rejects.toThrow();
  }
});
