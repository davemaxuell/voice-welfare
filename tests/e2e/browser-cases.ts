import { afterAll, afterEach } from "vitest";
import { INTENT_JSON_SCHEMA } from "../../src/understanding/llm_planner.ts";
import { createTestRuntime } from "./session-runtime.ts";

export function browserCases() {
  const runtime = createTestRuntime();
  afterEach(runtime.closeSessions);
  afterAll(runtime.close, 60_000);
  return runtime.createBrowserSession;
}

export function flat(type: string, fields: Record<string, unknown> = {}) {
  const empty = Object.fromEntries(INTENT_JSON_SCHEMA.schema.required.map(key => [key, null]));
  return { ...empty, type, ...fields };
}

export function latch() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
