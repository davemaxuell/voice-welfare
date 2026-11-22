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
const expectedCatalog = {...z.record(z.string(), z.array(z.string())).parse(oracle.catalog), 하이코리아: []};
function withCurrentAgencies(snapshot: unknown) {
  const schema = z.looseObject({properties: z.record(z.string(), z.unknown())}).parse(snapshot);
  return {...schema, properties: {...schema.properties, agency: {type: ["string", "null"], enum: [...Object.keys(expectedCatalog), null]}}};
}

function fake(reply: unknown) {
  const calls: LlmRequest[] = [];
  return { calls, llm: { name: "fake", generate: async (request: LlmRequest) => { calls.push(request); return reply; } } };
}
const signal = new AbortController().signal;

it("개인 탐색과 한 단계 명령은 앞에서 실행하는 계획에만 추가한다", () => {
  const {command, outcome, ...properties} = DECISION_SCHEMA.properties;
  expect(command.properties.type.enum).toContain("PREV");
  expect(outcome.anyOf[0]).toMatchObject({enum: ["answer", "arrival"]});
  const additions = new Set(["inspect_personal", "browser_command"]);
  expect(properties.kind.enum.filter(k => additions.has(k))).toEqual(["inspect_personal", "browser_command"]);
  expect(properties.agency.anyOf[0]).toMatchObject({type: "string"});
  expect({...DECISION_SCHEMA, properties: {...properties, agency: RESEARCH_SCHEMA.properties.agency, kind: {...properties.kind, enum: properties.kind.enum.filter(k => !additions.has(k))}},
    required: DECISION_SCHEMA.required.filter(k => k !== "command" && k !== "outcome")}).toEqual(withCurrentAgencies(oracle.schema));
  expect(RESEARCH_SCHEMA).toEqual(withCurrentAgencies(oracle.research));
  expect(AGENCY_CATALOG).toEqual(expectedCatalog);
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
it("keeps a pasted private URL local and grounds uncatalogued institution names in the request", async () => {
  const text = "Open https://portal.example/a/private-row?key=content#member";
  const open = fake({kind: "browser_command", command: {type: "OPEN_SITE", target: "https://portal.example", more: false},
    requestedFacts: [], choices: [], exclusions: [], continuation: false});
  const options = {voice: false, recent: [], signal};
  const decision = await decide(open.llm, redactText(text), "en", new PublicTask(), options);
  expect(decision?.command?.target).toBe(text.slice(5));
  expect(open.calls[0]?.user).not.toMatch(/private-row|key=content|#member/u);
  const ask = "Check my status at Cedar Civic Office";
  const personal = (agency: string) => fake({kind: "inspect_personal", agency, goal: ask, requirements: [ask],
    requestedFacts: [], choices: [], exclusions: [], continuation: false});
  expect((await decide(personal("Cedar Civic Office").llm, redactText(ask), "en", new PublicTask(), options))?.agency).toBe("Cedar Civic Office");
  expect(await decide(personal("Invented Office").llm, redactText(ask), "en", new PublicTask(), options)).toBeUndefined();
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
  expect(calls[0]?.schemaName).toBe(oracle.payload.schemaName);
  expect(calls[0]?.system).toContain("Agency catalog: " + JSON.stringify(expectedCatalog));
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
