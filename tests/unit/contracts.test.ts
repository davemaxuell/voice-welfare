import { expect, it } from "vitest";
import { parseAction, parseObservation } from "../../src/core/actions.ts";
import { parseIntent } from "../../src/core/intents.ts";
import { draft, parseTurnResult } from "../../src/core/turn.ts";

const action = { id: "a", type: "read", reason: "선택한 항목 읽기", risk: "low", requiresConfirmation: false };
it("rejects unknown action keys and requires an identity when a ref is present", () => {
  expect(parseAction({ ...action, coordinates: null })).toBeUndefined();
  expect(parseAction({ ...action, target: { ref: "r" } })).toBeUndefined();
  expect(parseAction({ ...action, target: { nth: 2 ** 54 } })?.target?.nth).toBe(2 ** 54);
  expect(parseAction({ ...action, target: { ref: "r", role: "link", name: "복지", nth: 0, label: null } })?.target)
    .toEqual({ ref: "r", role: "link", name: "복지", nth: 0 });
  expect(parseAction({ ...action, target: {}, url: "http://localhost/복지" })?.url).toBe("http://localhost/복지");
  expect(parseAction({ ...action, url: "relative-path" })).toBeUndefined();
  expect(parseAction({ ...action, value: "🎧".repeat(300) })?.value).toHaveLength(600);
  expect(parseAction({ ...action, value: "🎧".repeat(301) })).toBeUndefined();
});

it("keeps intent defaults and validates code point lengths", () => {
  expect(parseIntent({ type: "READ_DOWNLOAD" })).toEqual({ type: "READ_DOWNLOAD", list: false });
  expect(parseIntent({ type: "READ_DOWNLOAD", list: null })).toEqual({ type: "READ_DOWNLOAD" });
  expect(parseIntent({ type: "WHAT_CAN_I_SAY", more: null })).toBeUndefined();
  expect(parseIntent({ type: "READ_MAIN", more: 0 })).toBeUndefined();
  expect(parseIntent({ type: "GOAL", goal: "🎧" })).toBeUndefined();
  expect(parseIntent({ type: "GOAL", goal: "🎧".repeat(200) })?.type).toBe("GOAL");
  expect(parseIntent({ type: "EXPLAIN", fieldMention: null, unused: false })).toEqual({ type: "EXPLAIN" });
  expect(parseIntent({ type: "FILL", fills: [] })).toBeUndefined();
});

it("parses optional observation and turn fields while rejecting invalid required ones", () => {
  const observation = { platform: "pc", url: "", title: "", fields: [], errors: [], dialogs: [], capturedAt: "시각" };
  expect(parseObservation({ ...observation, status: null, extra: "삭제" })).toEqual(observation);
  expect(() => parseObservation({ ...observation, fields: null })).toThrow();
  const raw = {
    ...draft("IDLE", "none", "확인했어요.", { field: undefined }), sessionId: "s", turnId: "t",
    userUtterance: "응", intentType: "PLAN(FILL>NEXT)", trace: [], actions: [], sources: [], missingFields: [],
    pendingActions: 0, realSubmission: false, flags: { secretDetected: false, masked: false }, latencyMs: 0,
  };
  expect(Object.hasOwn(raw, "field")).toBe(false);
  expect(parseTurnResult({ ...raw, accessMode: null, unknown: 1, speechPrefs: { voice: null } }))
    .toEqual({ ...raw, lang: "ko", speechPrefs: { rate: 1.25, length: "normal", progressSpoken: true } });
  expect(() => parseTurnResult({ ...raw, realSubmission: true })).toThrow();
  expect(parseTurnResult({ ...raw, realSubmission: 0 }).realSubmission).toBe(false);
});
