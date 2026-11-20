import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import type { LlmRequest } from "../../src/core/llm.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { AGENCY_CATALOG, DECISION_SCHEMA, PublicTask, RESEARCH_SCHEMA, decide, parseDecision, reviewCompletion } from "../../src/orchestrator/public_task.ts";

const oracle = z.object({
  schema: z.unknown(), research: z.unknown(), catalog: z.unknown(),
  cases: z.record(z.string(), z.unknown()), parsed: z.record(z.string(), z.record(z.string(), z.unknown()).nullable()),
  advance: z.record(z.string(), z.object({ context: z.unknown(), revision: z.number() })),
  selected: z.record(z.string(), z.string().nullable()),
  payload: z.object({ user: z.record(z.string(), z.unknown()), schemaName: z.string(), systemTail: z.string(), schemaKind: z.unknown() }),
  rewritten: z.array(z.string()), reviews: z.record(z.string(), z.string()),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/server/public-task.json", import.meta.url), "utf8")));

function fake(reply: unknown) {
  const calls: LlmRequest[] = [];
  return { calls, llm: { name: "fake", generate: async (request: LlmRequest) => { calls.push(request); return reply; } } };
}
const signal = new AbortController().signal;

it("the decision schemas and agency catalog are the ones Python sends", () => {
  expect(JSON.parse(JSON.stringify(DECISION_SCHEMA))).toEqual(oracle.schema);
  expect(JSON.stringify(DECISION_SCHEMA)).toBe(JSON.stringify(oracle.schema));
  expect(JSON.stringify(RESEARCH_SCHEMA)).toBe(JSON.stringify(oracle.research));
  expect(JSON.stringify(AGENCY_CATALOG)).toBe(JSON.stringify(oracle.catalog));
});
it("parse_decision accepts and rejects what Python does", () => {
  for (const [name, raw] of Object.entries(oracle.cases)) {
    const expected = oracle.parsed[name];
    const actual = parseDecision(raw);
    if (expected === null || expected === undefined || actual === undefined) {
      expect(actual === undefined, name).toBe(expected === null);
      continue;
    }
    const record: Record<string, unknown> = { ...actual };
    expect(Object.fromEntries(Object.keys(expected).map(key => [key, record[key] ?? null])), name).toEqual(expected);
  }
  const stripped = { ...z.record(z.string(), z.unknown()).parse(oracle.cases.find) };
  delete stripped.question;
  delete stripped.agency;
  expect(parseDecision(stripped)?.agency).toBeUndefined();
});
it("a task carries only what a continuation keeps", () => {
  const task = new PublicTask({ agency: "정부24", subject: "주민등록등본", goal: "등본 서류", facts: ["documents"], exclusions: ["login"], searchMode: "quiet" });
  const raw = (fields: Record<string, unknown>) => z.record(z.string(), z.unknown()).parse({ ...z.record(z.string(), z.unknown()).parse(oracle.cases.find), ...fields });
  const cases: Record<string, Record<string, unknown>> = {
    continue_same: raw({ kind: "existing", continuation: true, agency: null, subject: null, goal: null, requestedFacts: [], exclusions: ["submission"], source: null }),
    continue_other: raw({ continuation: true, agency: "한국장학재단", requestedFacts: ["dates", "dates"] }),
    fresh: raw({ continuation: false, agency: null, subject: null, goal: null, requestedFacts: [], kind: "existing", source: null }),
    clarify: raw({ kind: "clarify", question: "어느 서류요?", choices: ["등본", "초본"], continuation: true }),
  };
  for (const [name, input] of Object.entries(cases)) {
    const parsed = parseDecision(input);
    expect(parsed, name).toBeDefined();
    if (parsed === undefined) continue;
    const next = task.advance(parsed);
    expect({ context: next.context(), revision: next.revision }, name).toEqual(oracle.advance[name]);
  }
});
it("decide selects a pending choice and sends the same request", async () => {
  const pending = new PublicTask({ question: "어느 서류요?", choices: ["주민등록등본", "주민등록초본"], goal: "서류" });
  for (const [said, expected] of Object.entries(oracle.selected)) {
    const { llm, calls } = fake(oracle.cases.find);
    await decide(llm, redactText(said), "ko", pending, { voice: true, recent: [], signal });
    expect(JSON.parse(calls[0]?.user ?? "{}").selectedChoice, said).toBe(expected);
  }
  const { llm, calls } = fake(oracle.cases.find);
  await decide(llm, redactText("네"), "ko", new PublicTask({ question: "이거요?", choices: ["주민등록등본"] }), {
    voice: false, signal,
    recent: [{ agency: "정부24", request: "등본 서류 알려줘", reply: "신분증이 필요해요." }, { agency: null, request: "다른 질문", reply: "네." }], speechCandidates: ["정부24"], corroborated: true, savedNotes: ["큰 글씨"], research: true,
  });
  const user = z.record(z.string(), z.unknown()).parse(JSON.parse(calls[0]?.user ?? "{}"));
  expect(user.koreaDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  delete user.koreaDate;
  expect(JSON.stringify(user)).toBe(JSON.stringify(oracle.payload.user));
  expect([calls[0]?.schemaName, calls[0]?.system.slice(-300)]).toEqual([oracle.payload.schemaName, oracle.payload.systemTail]);
  const reviewRaw = z.record(z.string(), z.unknown()).parse(oracle.cases.review);
  const rewritten = await decide(fake({ ...reviewRaw, requirements: ["바꿔 말한 요구"] }).llm, redactText("등본 서류를 찾아 정리해줘"), "ko", new PublicTask(), { voice: true, recent: [], signal });
  expect(rewritten?.requirements).toEqual(oracle.rewritten);
});
it("review_completion grades evidence as Python does", async () => {
  for (const [name, expected] of Object.entries(oracle.reviews)) {
    const replies: Record<string, unknown> = {
      all: { coverage: "all", checks: [{ request: "등본 서류", quote: "신분증" }] },
      all_bad_quote: { coverage: "all", checks: [{ request: "등본 서류", quote: "없는 말" }] },
      all_bad_request: { coverage: "all", checks: [{ request: "다른 요청", quote: "신분증" }] },
      some: { coverage: "some", checks: [] }, unrelated: { coverage: "unrelated", checks: [] },
      null_quote: { coverage: "all", checks: [{ request: "등본 서류" }] }, not_dict: "x", no_checks: { coverage: "all", checks: [] },
    };
    let actual: string;
    if (name === "empty_evidence") actual = await reviewCompletion(fake({}).llm, "q", "", signal);
    else if (name === "no_model") actual = await reviewCompletion(undefined, "q", "e", signal);
    else actual = await reviewCompletion(fake(replies[name]).llm, "등본 서류 알려줘", "준비물: 신분증", signal);
    expect(actual, name).toBe(expected);
  }
  const failing = { name: "down", generate: async () => { throw new Error("down"); } };
  expect(await reviewCompletion(failing, "q", "e", signal)).toBe("partial");
});
