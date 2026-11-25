import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import type { LlmRequest } from "../../src/core/llm.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { translateIn } from "../../src/language/i18n.ts";
import { planWithLlm } from "../../src/understanding/llm_planner.ts";
import { reviewBeforeOutput, reviewEvidence } from "../../src/orchestrator/task_review.ts";
import { AGENCY_CATALOG, DECISION_SCHEMA, PublicTask, RESEARCH_SCHEMA, SYSTEM, decide, parseDecision, reviewCompletion, type PlannerSaved } from "../../src/orchestrator/public_task.ts";

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
  const facts = z.looseObject({items: z.looseObject({enum: z.array(z.string())})}).parse(schema.properties.requestedFacts);
  return {...schema, properties: {...schema.properties, agency: {type: ["string", "null"], enum: [...Object.keys(expectedCatalog), null]},
    requestedFacts: {...facts, items: {...facts.items, enum: [...facts.items.enum, "page_title"]}, description: DECISION_SCHEMA.properties.requestedFacts.description}}};
}

function fake(reply: unknown) {
  const calls: LlmRequest[] = [];
  return { calls, llm: { name: "fake", generate: async (request: LlmRequest) => { calls.push(request); return reply; } } };
}
const signal = new AbortController().signal;

it("개인 탐색과 한 단계 명령은 앞에서 실행하는 계획에만 추가한다", () => {
  const {command, research, outcome, needUpdate, ...properties} = DECISION_SCHEMA.properties;
  expect(needUpdate.properties.changes.items.properties.aspect.enum).toContain("region");
  expect(command.properties.type.enum).toContain("PREV");
  expect(research.properties.action.enum).toEqual(["read"]);
  expect(outcome.anyOf[0]).toMatchObject({enum: ["answer", "arrival"]});
  const additions = new Set(["inspect_personal", "browser_command", "saved_research"]);
  expect(properties.kind.enum.filter(k => additions.has(k))).toEqual(["inspect_personal", "browser_command", "saved_research"]);
  expect(properties.agency.anyOf[0]).toMatchObject({type: "string"});
  expect({...DECISION_SCHEMA, properties: {...properties, agency: RESEARCH_SCHEMA.properties.agency, kind: {...properties.kind, enum: properties.kind.enum.filter(k => !additions.has(k))}},
    required: DECISION_SCHEMA.required.filter(k => !["command", "research", "outcome", "needUpdate"].includes(k))}).toEqual(withCurrentAgencies(oracle.schema));
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
it.each([
  ["https://portal.example/a/private-row?key=content#member", "https://portal.example"],
  ["127.0.0.1:5174/a/private-row?key=content#member", "http://127.0.0.1:5174"],
  ["portal.example?key=content#member", "https://portal.example"],
])("keeps the local address %s out of translation, fallback planning and source review", async (address, origin) => {
  const raw = address.startsWith("https://") ? address : origin + address.slice(new URL(origin).host.length);
  const utterance = redactText(`Open ${address} and read the title`);
  const translator = fake({text: `${origin}에서 제목을 읽어 줘`});
  const translated = await translateIn(translator.llm, utterance, "en", signal);
  expect(translated).toContain(raw);
  const goal = fake({steps: [{type: "GOAL", site: origin, topic: "제목을 읽어 줘"}]});
  const step = await planWithLlm(goal.llm, redactText(translated!), {state: "BROWSING"}, [], {signal});
  expect(step?.[0]).toMatchObject({type: "GOAL", goal: expect.stringContaining(raw)});
  const request = `Open ${origin} and read the title`;
  const title = "Cedar Archive";
  const review = fake({answer: title, checks: [{request, kind: "document_title", citations: [{id: 0, quote: title}]}], nextRoute: null});
  const verdict = await reviewBeforeOutput(review.llm, utterance,
    [reviewEvidence("page", `${new URL(raw).origin}${new URL(raw).pathname} · ${title}`, {documentTitle: title, pageKey: "local", sourceUrls: [raw]})],
    signal, {requirements: [utterance]});
  expect(verdict.status).toBe("complete");
  for (const call of [...translator.calls, ...goal.calls, ...review.calls]) {
    expect(call.user).toContain(origin);
    expect(call.user).not.toMatch(/private-row|key=content|#member/u);
  }
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
const unused = {requestedFacts: [], choices: [], exclusions: [], continuation: false};
const readSaved = (jobs: unknown, more: Record<string, unknown> = {}) => ({...unused, kind: "saved_research", research: {action: "read", jobs, answer: null, ...more}});

it("저장한 조사 결정은 종류와 research가 짝이 맞고 읽기와 보낸 번호 모양일 때만 받는다", () => {
  expect(parseDecision(readSaved([]))).toMatchObject({kind: "saved_research", research: {action: "read", jobs: []}});
  expect(parseDecision(readSaved(["j1", "j8"]))?.research?.jobs).toEqual(["j1", "j8"]);
  expect(parseDecision({...unused, kind: "saved_research", research: {action: "read", jobs: ["j2"]}})?.research?.jobs).toEqual(["j2"]);
  const rejected: Record<string, unknown> = {
    "research 없는 saved_research": {...unused, kind: "saved_research", research: null},
    "다른 종류에 붙은 research": {...readSaved([]), kind: "existing"},
    "아직 없는 일": {...unused, kind: "saved_research", research: {action: "cancel", jobs: ["j1"], answer: null}},
    "목록 밖 번호": readSaved(["j9"]),
    "조사 번호를 그대로 쓴 값": readSaved(["3f1c2a9e-0000-4000-8000-000000000000"]),
    "여덟 건을 넘는 목록": readSaved(["j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8", "j1"]),
    "목록이 아닌 jobs": readSaved("j1"),
    "읽기에 붙은 답": readSaved(["j1"], {answer: "서울"}),
    "모르는 칸": readSaved(["j1"], {result: "신분증을 준비하세요."}),
  };
  for (const [name, raw] of Object.entries(rejected)) expect(parseDecision(raw), name).toBeUndefined();
});

it("맡겨 둔 조사가 있을 때만 그 목록과 안내 문단을 보내고, 목록에는 정해진 칸만 싣는다", async () => {
  const jobs = [
    {ref: "j1", request: "기초연금 신청 서류", state: "ready", savedOn: "2026-11-25", lastSaved: true},
    {ref: "j2", request: "아동수당 신청 방법", state: "asking-restart", savedOn: "2026-11-24"},
  ] as const;
  const wider: PlannerSaved = {jobs: jobs.map(job => ({...job, result: "구별되는결과글", sources: ["구별되는출처"], question: "구별되는질문"}))};
  const said = redactText("아까 맡긴 거 어떻게 됐어?");
  const ask = async (saved?: PlannerSaved) => {
    const {llm, calls} = fake(oracle.cases.find);
    await decide(llm, said, "ko", new PublicTask(), {voice: true, recent: [], signal, ...(saved === undefined ? {} : {saved})});
    return {system: calls[0]?.system ?? "", user: calls[0]?.user ?? ""};
  };
  const without = await ask(), empty = await ask({jobs: []}), listed = await ask(wider);
  const catalog = "\nAgency catalog: " + JSON.stringify(expectedCatalog);
  expect(without.system).toBe(SYSTEM + catalog);
  expect(empty).toEqual(without);
  const keys = (user: string) => Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(user)));
  expect(keys(without.user)).not.toContain("savedJobs");
  expect(keys(listed.user)).toEqual([...keys(without.user), "savedJobs"]);
  expect(z.object({savedJobs: z.unknown()}).parse(JSON.parse(listed.user)).savedJobs).toEqual(jobs);
  expect(listed.user).not.toMatch(/구별되는/u);
  expect(listed.system.startsWith(SYSTEM)).toBe(true);
  expect(listed.system.endsWith(catalog)).toBe(true);
  expect(listed.system.slice(SYSTEM.length, -catalog.length)).toContain("savedJobs");
});

it("저장한 조사 결정이 보낸 목록 밖의 조사를 가리키거나 목록 없이 오거나 모양이 틀리면 결정 없음이 아니라 되물을 결정이 된다", async () => {
  const saved: PlannerSaved = {jobs: [{ref: "j1", request: "기초연금 신청 서류", state: "ready", savedOn: "2026-11-25"}]};
  const said = redactText("아까 맡긴 거 어떻게 됐어?");
  const decided = (raw: unknown, options: {saved?: PlannerSaved; research?: boolean} = {}) =>
    decide(fake(raw).llm, said, "ko", new PublicTask(), {voice: true, recent: [], signal, ...options});
  expect(await decided(readSaved(["j1"]), {saved})).toMatchObject({kind: "saved_research", research: {action: "read", jobs: ["j1"]}});
  expect(await decided(readSaved([]), {saved})).toMatchObject({kind: "saved_research", research: {jobs: []}});
  expect(await decided(readSaved([]), {saved: {jobs: []}})).toMatchObject({kind: "saved_research", research: {jobs: []}});
  const unclear = {kind: "saved_research_unclear"};
  expect(await decided(readSaved(["j2"]), {saved})).toEqual(unclear);
  expect(await decided(readSaved(["j1", "j2"]), {saved})).toEqual(unclear);
  expect(await decided(readSaved(["j1"]))).toEqual(unclear);
  expect(await decided(readSaved([]))).toEqual(unclear);
  expect(await decided(readSaved([]), {research: true})).toEqual(unclear);
  expect(await decided({...unused, kind: "saved_research", research: null}, {saved})).toEqual(unclear);
  expect(await decided(readSaved(["j1"], {answer: "서울"}), {saved})).toEqual(unclear);
  expect(await decided({...unused, kind: "existing"}, {saved})).toMatchObject({kind: "existing"});
  expect(await decided({kind: "existing"}, {saved})).toBeUndefined();
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
