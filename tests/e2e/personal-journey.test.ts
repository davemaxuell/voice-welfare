import { expect, it } from "vitest";
import { z } from "zod";
import { parseTurnResult } from "../../src/core/turn.ts";
import { FakeLlm, step, type LlmRequest } from "../helpers.ts";
import { pageFor, runtimeCases } from "./browser-runtime-cases.ts";
import { dashboardUrl, heldOut, layouts, mountPortal, portalOrigin, portalPrivate, signIn, type PortalLayout } from "./personal-journey-portal.ts";

const create = runtimeCases();
const Completion = z.object({
  request: z.string(),
  evidence: z.array(z.object({ id: z.number(), text: z.string(), kind: z.string() })),
});
const Observation = z.object({
  page: z.object({ title: z.string(), items: z.array(z.object({ name: z.string() })) }).nullable(),
});

async function openJourney(layout: PortalLayout, options: { missingStatus?: boolean; fetch?: typeof fetch; env?: Record<string, string> } = {}) {
  const stt = { name: "fixture-transcript", supported: true, async transcribe(bytes: Uint8Array) {
    return { text: new TextDecoder().decode(bytes).trim() };
  } };
  const { app, session: start, runtime } = await create({ PRACTICE_MODE: "false", ...options.env }, { stt, fetch: options.fetch });
  const { session, id } = await start();
  const page = pageFor(session);
  const portal = await mountPortal(page, layout, options);
  await page.goto(portalOrigin + layout.home);
  async function say(text: string) {
    const response = await app.request("/api/audio/turn?sessionId=" + id, {
      method: "POST", headers: { "content-type": "audio/wav" }, body: text.padEnd(256),
    });
    expect(response.status).toBe(200);
    return parseTurnResult(await response.json());
  }
  return { ...portal, say, page, session, runtime };
}

function privateMarkers(layout: PortalLayout) {
  return [...Object.values(portalPrivate), layout.workspacePath, layout.detailPath, "Resident ID"];
}

function expectPrivate(model: FakeLlm, layout: PortalLayout) {
  for (const { user } of model.calls) {
    for (const value of privateMarkers(layout)) expect(user).not.toContain(value);
  }
}

it("직접 요청한 뒤로 가기는 음성 계획에서 한 번만 실행한다", async () => {
  const layout = layouts[0]!;
  const journey = await openJourney(layout);
  await journey.page.goto(portalOrigin + layout.detour!.path);
  const model = new FakeLlm(({schemaName}) => schemaName === "public_service_decision" ? {
    kind: "browser_command", command: {type: "PREV", target: null, more: false}, requestedFacts: [],
    exclusions: [], choices: [], continuation: false,
  } : undefined);
  journey.session.deps.llm = model;
  const result = await journey.say("이전 페이지로 한 번만 돌아가 줘");
  expect(result.actions.map(row => row.action.type)).toEqual(["back"]);
  expect(new URL(journey.page.url()).pathname).toBe(layout.home);
  expect(model.calls.map(call => call.schemaName)).toContain("public_service_decision");
});

function fixtureModel(layout: PortalLayout, { missingStatus = false } = {}) {
  let exploredPublicGuide = false;
  let testedWrite = false;
  return new FakeLlm(({ schemaName, user }: LlmRequest) => {
    if (schemaName === "public_service_decision") {
      const input = z.object({ utterance: z.string(), voice: z.boolean() }).parse(JSON.parse(user));
      if (input.utterance !== layout.ask || !input.voice) return undefined;
      return { kind: "inspect_personal", source: null, agency: null, subject: null, goal: layout.ask,
        requestedFacts: [], exclusions: [], continuation: false, question: null, choices: [],
        reply: null, skill: null, difficulty: "medium", requirements: [layout.ask] };
    }
    if (schemaName === "browse_step") {
      const page = Observation.parse(JSON.parse(user)).page;
      const visible = (label: string) => page?.items.some(item => item.name === label) === true;
      const detour = layout.detour;
      if (detour !== undefined && !exploredPublicGuide && visible(detour.link)) {
        exploredPublicGuide = true;
        return { ...step("click", detour.link), expected: "Find the account's requests", assessment: "unknown" };
      }
      if (detour !== undefined && page?.title === detour.title) {
        return { ...step("back"), assessment: "dead_end", expected: "Return to the portal" };
      }
      if (visible(layout.account)) return { ...step("click", layout.account), assessment: "progress", expected: "Open the resident area" };
      if (visible(layout.detail)) {
        if (missingStatus && !testedWrite) {
          testedWrite = true;
          return step("click", "제출");
        }
        return { ...step("click", layout.detail), assessment: "progress", expected: "Find the request status" };
      }
      if (page?.title === layout.statusTitle) return missingStatus ? step("back") : step("answer", null, layout.status, [layout.status]);
      return step("fail");
    }
    if (schemaName === "review_before_output") {
      const { request, evidence } = Completion.parse(JSON.parse(user));
      const proof = evidence.find(e => e.kind === "fact" && e.text.includes(layout.status));
      return { checks: [{ request, kind: "fact", citations: proof === undefined ? [] : [{ id: proof.id, quote: layout.status }] }],
        answer: proof === undefined ? "" : layout.status, nextRoute: null };
    }
    return undefined;
  });
}

async function navigateThroughLogin(journey: Awaited<ReturnType<typeof openJourney>>, layout: PortalLayout) {
  const initial = await journey.say(layout.ask);
  expect(initial.state, initial.speech).toBe("AUTH_HANDOFF");
  expect(initial.authHandoff).toMatchObject({ kind: "login", status: "waiting" });
  expect(initial.review?.status).toBe("needs_input");
  expect(initial.pendingConfirmation).toBeUndefined();
  expect(journey.page.url()).toBe(portalOrigin + layout.accountPath);
  expect(await journey.page.getByLabel("Password").inputValue()).toBe("");

  const premature = await journey.say("다 했어");
  expect(premature.authHandoff).toEqual(initial.authHandoff);
  expect(premature.actions).toEqual([]);
  expect(journey.page.url()).toBe(portalOrigin + layout.accountPath);
  await signIn(journey.page, layout);
  expect(journey.page.url()).toBe(dashboardUrl(layout));
  return initial;
}

it("keeps the original journey and budget through consecutive clarifications", async () => {
  const layout = layouts[1]!;
  const journey = await openJourney(layout);
  const model = new FakeLlm(({schemaName, user}) => {
    if (schemaName === "browse_step") return step("ask_user", undefined, "어느 기록을 확인할까요?");
    if (schemaName !== "public_service_decision") return undefined;
    const {utterance} = z.object({utterance: z.string()}).parse(JSON.parse(user));
    if (utterance === layout.ask) return {kind: "inspect_personal", goal: utterance, requirements: [utterance],
      requestedFacts: [], choices: [], exclusions: [], continuation: false, difficulty: "easy"};
    return {kind: "clarify", question: "어느 달에 접수하셨나요?", requestedFacts: [], choices: [], exclusions: [], continuation: true};
  });
  journey.session.deps.llm = journey.session.deps.goalLlm = model;
  await journey.say(layout.ask);
  const initial = journey.session.reviewQuestion?.[1];
  expect(initial?.browserSteps).toBeGreaterThan(0);
  const remaining = initial?.journey?.remaining;
  const asked = await journey.say("최근 기록 가운데 하나요");
  expect(asked.speech).toContain("어느 달");
  expect(journey.session.reviewQuestion?.[1]).toBe(initial);
  expect(journey.session.reviewQuestion?.[1].journey?.remaining).toBe(remaining);
});

it("asks before a scripted control and resumes the same inspection after approval and login", async () => {
  const layout = layouts[1]!;
  const journey = await openJourney(layout);
  await journey.page.getByRole("link", {name: layout.account}).evaluate(node => {
    const link = node as HTMLAnchorElement;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = link.textContent;
    button.addEventListener("click", () => location.assign(link.href));
    link.replaceWith(button);
  });
  const model = fixtureModel(layout);
  journey.session.deps.llm = journey.session.deps.webLlm = journey.session.deps.goalLlm = model;
  const first = await journey.say(layout.ask);
  expect(first.state, first.speech).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(first.pendingConfirmation?.kind).toBe("click");
  expect(journey.visited).not.toContain(layout.accountPath);
  const opened = await journey.say("눌러");
  expect(opened.state, opened.speech).toBe("AUTH_HANDOFF");
  expect(journey.visited.filter(path => path === layout.accountPath)).toHaveLength(1);
  await signIn(journey.page, layout);
  const result = await journey.say("다 했어");
  expect(result.review?.status, result.speech).toBe("completed");
  expect(result.speech).toContain(layout.status);
  expectPrivate(model, layout);
  const followup = "그 화면의 결과를 설명해 주세요";
  const nextModel = new FakeLlm(call => call.schemaName === "public_service_decision" ? {
    kind: "inspect_personal", goal: followup, continuation: true, requirements: [followup],
    choices: [], exclusions: [], requestedFacts: [],
  } : model.generate(call));
  journey.session.deps.llm = journey.session.deps.goalLlm = nextModel;
  const explained = await journey.say(followup);
  expect(explained.review?.status, explained.speech).toBe("completed");
  expect(explained.speech).toContain(layout.status);
  const intake = nextModel.calls.find(call => call.schemaName === "public_service_decision");
  expect(JSON.parse(intake?.user ?? "{}")).toMatchObject({currentInspectionScreen: true, task: {goal: layout.ask}});
  expect(intake?.user).not.toContain(layout.status);
  expectPrivate(nextModel, layout);
});

it.each(layouts)("resumes the $language portal journey after the resident signs in", async layout => {
  const journey = await openJourney(layout);
  const model = fixtureModel(layout);
  journey.session.deps.llm = journey.session.deps.goalLlm = journey.session.deps.webLlm = model;
  try {
    const initial = await navigateThroughLogin(journey, layout);
    const done = await journey.say("다 했어");
    expect(done.sessionId).toBe(initial.sessionId);
    expect(done.review?.status, done.speech).toBe("completed");
    expect(done.speech).toContain(layout.status);
    expect(new URL(journey.page.url()).pathname).toBe(layout.detailPath);
    expect(done.sources.map(source => source.url)).toContain(portalOrigin + "/");
    expect(done.pendingConfirmation).toBeUndefined();
    expect(journey.outside).toEqual([]);
    if (layout.detour !== undefined) {
      expect(journey.visited).toContain(layout.detour.path);
      expect(initial.actions.some(item => item.action.type === "back" && item.result?.ok === true)).toBe(true);
    }
    const calls = model.calls.map(call => call.schemaName);
    expect(calls).toContain("public_service_decision");
    expect(calls).toContain("browse_step");
    expect(calls).toContain("review_before_output");
    const observations = model.calls.filter(call => call.schemaName === "browse_step")
      .map(call => Observation.parse(JSON.parse(call.user)).page);
    expect(observations.map(page => page?.title)).toContain(layout.workspace);
    expect(observations.map(page => page?.title)).toContain(layout.statusTitle);
    expect(observations.map(page => page?.title)).not.toContain(layout.loginTitle);
  } finally {
    expectPrivate(model, layout);
  }
});

it("stops a repeated route when the portal has no status to verify", async () => {
  const layout = layouts[1]!;
  const journey = await openJourney(layout, { missingStatus: true });
  const model = fixtureModel(layout, { missingStatus: true });
  journey.session.deps.llm = journey.session.deps.goalLlm = journey.session.deps.webLlm = model;
  try {
    await navigateThroughLogin(journey, layout);
    const done = await journey.say("다 했어");
    expect(done.review?.status, done.speech).toBe("incomplete");
    expect(done.speech).not.toContain(layout.status);
    expect(journey.visited).toContain(layout.detailPath);
    expect(journey.visited).not.toContain("/submitted");
    expect(done.review?.browserIterations ?? Infinity).toBeLessThanOrEqual(16);
    expect(journey.outside).toEqual([]);
  } finally {
    expectPrivate(model, layout);
  }
});

it("speaks personal handoff, wait, return, and incomplete guidance locally in English", async () => {
  const layout = {...layouts[1]!, ask: "Please check the status of the application I filed on this website"};
  const journey = await openJourney(layout, { missingStatus: true });
  const model = fixtureModel(layout, { missingStatus: true });
  journey.session.deps.llm = journey.session.deps.goalLlm = journey.session.deps.webLlm = model;
  try {
    const initial = await journey.say(layout.ask);
    expect(initial).toMatchObject({ state: "AUTH_HANDOFF", lang: "en", localSpeechOnly: true });
    expect(initial.speech).toContain("Please sign in");
    const callsBeforeWaiting = model.calls.length;
    const waiting = await journey.say("I'm done");
    expect(waiting.authHandoff).toEqual(initial.authHandoff);
    expect(waiting.lang).toBe("en");
    expect(waiting.speech).toContain("You're still on the sign-in");

    const otherWebsite = "https://another-office.example.invalid/";
    await journey.page.route(otherWebsite, route => route.fulfill({
      contentType: "text/html; charset=utf-8", body: "<title>Other office</title><main><h1>Office hours</h1></main>",
    }));
    await journey.page.goto(otherWebsite);
    const wrongPage = await journey.say("I'm done");
    expect(wrongPage.authHandoff).toEqual(initial.authHandoff);
    expect(wrongPage.lang).toBe("en");
    expect(wrongPage.speech).toContain("return to the original website");
    expect(model.calls).toHaveLength(callsBeforeWaiting);

    await journey.page.goto(portalOrigin + layout.accountPath);
    await signIn(journey.page, layout);
    const incomplete = await journey.say("I'm done");
    expect(incomplete).toMatchObject({ lang: "en", localSpeechOnly: true, review: { status: "incomplete" } });
    expect(incomplete.speech).toContain("I couldn't confirm everything you asked for");
    expect(incomplete.speech).toContain(layout.ask);
    expect(model.calls.map(call => call.schemaName)).not.toContain("translate_out");
  } finally {
    expectPrivate(model, layout);
  }
});

const ProviderRequest = z.object({
  response_format: z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({ name: z.string() }),
  }),
});

// CHEONGEUM_LIVE_PERSONAL_JOURNEY=1과 Node의 --env-file-if-exists=.env 옵션으로 실제 모델을 사용한다.
it.skipIf(process.env.CHEONGEUM_LIVE_PERSONAL_JOURNEY !== "1")("finds the resident's status in a held-out portal with the configured model", async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    /^(?:LLM_[A-Z_]+|OPENAI_API_KEY|VOICE_API_KEY|VOICE_BASE_URL)$/u.test(entry[0]) && entry[1] !== undefined));
  const schemas = new Set<string>();
  const violations: string[] = [];
  const responses: number[] = [];
  const guardedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const payload = await request.clone().text();
    const parsed = ProviderRequest.safeParse(JSON.parse(payload));
    if (!new URL(request.url).pathname.endsWith("/chat/completions") || !parsed.success ||
        privateMarkers(heldOut).some(value => payload.includes(value))) {
      violations.push("Blocked unexpected or private provider payload");
      throw new Error(violations.at(-1));
    }
    schemas.add(parsed.data.response_format.json_schema.name);
    const response = await fetch(request, { redirect: "error" });
    responses.push(response.status);
    return response;
  };
  const journey = await openJourney(heldOut, { env: { LLM_PROVIDER: "", ...env }, fetch: guardedFetch });
  expect(journey.runtime.understandLlm, "Set a structured model using the repo's normal LLM config").toBeDefined();
  expect(journey.runtime.goalLlm, "Set a structured browser model using the repo's normal LLM config").toBeDefined();
  try {
    const initial = await navigateThroughLogin(journey, heldOut);
    const done = await journey.say("다 했어");
    expect(done.sessionId).toBe(initial.sessionId);
    expect(done.review?.status, done.speech).toBe("completed");
    expect(done.speech).toMatch(/추가\s*(자료|서류)/u);
    expect(new URL(journey.page.url()).pathname).toBe(heldOut.detailPath);
    expect(journey.outside).toEqual([]);
    expect([...schemas]).toEqual(expect.arrayContaining(["public_service_decision", "browse_step", "review_before_output"]));
  } finally {
    expect(violations).toEqual([]);
    const statuses = responses.length === 0 ? "none" : responses.join(", ");
    expect(responses.some(status => status >= 200 && status < 300), `Provider HTTP statuses ${statuses}`).toBe(true);
  }
}, 180_000);
