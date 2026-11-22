import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { SettingsStore } from "../../src/server/settings.ts";
import { FakeLlm, withLlm } from "../helpers.ts";
import { adapterFor, pageFor, runtimeCases } from "./browser-runtime-cases.ts";

const referral = {
  request: "별빛생활주간에 가려는데 어디로 가면 되고 토요일에는 몇 시까지 들어갈 수 있어?",
  requirements: ["별빛생활주간에 가려는데 어디로 가면 되고", "토요일에는 몇 시까지 들어갈 수 있어"],
  firstFact: "location",
  firstQuote: "별빛생활주간 행사는 솔바람전시관에서 열립니다.",
  firstTitle: "행사 안내",
  firstLink: "별빛생활주간 행사 안내",
  publicQuery: "별빛생활주간 솔바람전시관 토요일 입장 안내",
  kind: "review_before_output",
};
const comparison = {
  request: "별가람박물관은 토요일에 언제 문을 닫아? 그리고 솔바람전시관은 토요일에 몇 시까지 들어갈 수 있어?",
  requirements: ["별가람박물관은 토요일에 언제 문을 닫아", "그리고 솔바람전시관은 토요일에 몇 시까지 들어갈 수 있어"],
  firstFact: "dates",
  firstQuote: "별가람박물관은 토요일 오후 8시에 문을 닫습니다.",
  firstTitle: "별가람박물관 이용 안내",
  firstLink: "별가람박물관 이용 안내",
  publicQuery: "별가람박물관 솔바람전시관 토요일 관람 시간",
  kind: "find_information",
};
const admission = "토요일 마지막 입장은 오후 4시 20분입니다.";
const listing = "https://culture.example.go.kr/notice";
const hours = "https://venue.example.go.kr/visitors";
const searchOrigin = "https://search.example.org";
const live = process.env.CHEONGEUM_LIVE_EVAL === "1";
const service = runtimeCases();

it.each([
  {description: "referral with the cutoff", task: referral, published: true},
  {description: "referral with the cutoff missing", task: referral, published: false},
  {description: "two websites for the same fact kind", task: comparison, published: true},
  {description: "a model outage during the quiet browser fallback", task: referral, published: true, outage: true},
])("checks $description", async ({task, published, outage = false}) => {
  if (live && outage) return;
  const {request, requirements, firstFact, firstQuote, firstTitle, firstLink, publicQuery, kind} = task;
  function responseFor(schemaName: string, user: string) {
    if (schemaName === "public_service_decision") return {kind, source: "browser", searchMode: "quiet",
      goal: request, agency: null, requestedFacts: [...new Set([firstFact, "dates"])], requirements,
      difficulty: "medium", continuation: false, exclusions: [], choices: []};
    if (schemaName === "public_browse_step") {
      const {page, history} = z.object({page: z.object({title: z.string()}).nullable(), history: z.array(z.string())}).parse(JSON.parse(user));
      if (page === null) return {action: "search", target: history.length === 0 ? request : publicQuery, claims: []};
      if (page.title === "검색 결과") return {action: "click", target: firstLink, claims: []};
      if (page.title === firstTitle) return {action: "click", target: "전시관 이용 안내", claims: [{fact: firstFact, quote: firstQuote}]};
      return published ? {action: "answer", claims: [{fact: "dates", quote: admission}]} : {action: "fail", claims: []};
    }
    if (schemaName === "review_before_output") {
      const {evidence} = z.object({evidence: z.array(z.object({id: z.number(), text: z.string()}))}).parse(JSON.parse(user));
      const checks = [firstQuote, admission].map((quote, i) => ({request: requirements[i], kind: "fact",
        citations: evidence.filter(row => row.text === quote).map(row => ({id: row.id, quote}))}));
      const supported = checks.every(check => check.citations.length > 0);
      return {checks, answer: supported ? firstQuote + " " + admission : "", nextRoute: supported ? null : "quiet"};
    }
    return undefined;
  }
  const completions: typeof fetch = async (_url, init) => {
    const body = z.object({response_format: z.object({json_schema: z.object({name: z.string()})}),
      messages: z.array(z.object({role: z.string(), content: z.string()}))}).parse(JSON.parse(String(init?.body)));
    if (outage && body.response_format.json_schema.name === "public_browse_step") {
      return Response.json({error: {message: "Fixture outage"}}, {status: 503});
    }
    const result = responseFor(body.response_format.json_schema.name, body.messages.find(message => message.role === "user")?.content ?? "");
    return Response.json({choices: [{message: {content: JSON.stringify(result ?? {})}}]});
  };
  const directory = process.env.CHEONGEUM_EVAL_SETTINGS_DIR;
  const settings = live && directory !== undefined ? new SettingsStore(join(directory, "preferences.json")) : undefined;
  const config = loadConfig({...(live ? process.env : {OPENAI_API_KEY: "fixture"}), PILOT_PROFILE: "shared",
    HEADLESS: "true", REQUIRE_CONSENT: "false", PRACTICE_MODE: "false", WEB_SEARCH_URL: searchOrigin + "/?q={q}",
    TAVILY_API_KEY: ""});
  const runtime = await AgentRuntime.create(config, live ? fetch : completions, settings);
  const visited: string[] = [];
  const queries: (string | null)[] = [];
  const bodies = new Map([
    [searchOrigin, `<title>검색 결과</title><main><a href="${listing}">${firstLink}</a></main>`],
    [listing, `<title>${firstTitle}</title><main><p>${firstQuote}</p><a href="${hours}">전시관 이용 안내</a></main>`],
    [hours, '<title>솔바람전시관 이용 안내</title><main><p>금요일 마지막 입장은 오후 6시입니다.</p><p>' +
      (published ? admission : "토요일 입장 마감 시각은 추후 공지합니다.") + '</p></main>'],
  ]);
  const create = runtime.createSession.bind(runtime);
  const opened = vi.spyOn(runtime, "createSession").mockImplementation(async options => {
    const session = await create(options);
    const context = adapterFor(session).context;
    if (!context) throw Error("Expected a fresh browser context");
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      const key = url.origin === searchOrigin ? searchOrigin : url.href;
      const body = bodies.get(key);
      if (body === undefined) return route.abort();
      visited.push(key);
      if (key === searchOrigin) queries.push(url.searchParams.get("q"));
      return route.fulfill({contentType: "text/html; charset=utf-8", body});
    });
    return session;
  });
  try {
    const session = await runtime.createSession();
    try {
      const result = await session.handleTurn(request);
      const why = JSON.stringify({speech: result.speech, review: result.review, visited, trace: result.trace.map(step => step.note)});
      if (outage) {
        expect(result.state, why).toBe("RECOVERING");
        expect(result.speech).toMatch(/모델|연결/u);
        expect(result.sources).toEqual([]);
        return;
      }
      expect(visited, why).toEqual(expect.arrayContaining([searchOrigin, listing, hours]));
      expect(queries).not.toContain(request);
      if (!live) expect(queries[0]).toBe(publicQuery);
      expect(session.progress.shiftSpoken()).toBe("공식 사이트를 직접 확인하고 있어요.");
      if (published) {
        expect(result.review?.status, why).toBe("completed");
        expect(result.speech, why).toContain(task === referral ? "솔바람전시관" : "별가람박물관");
        expect(result.speech, why).toMatch(/(?:4시\s*20분|16시\s*20분|16:20)/u);
        expect(result.sources.map(source => source.url), why).toEqual(expect.arrayContaining([listing, hours]));
      } else {
        expect(result.speech, why).not.toMatch(/(?:4시\s*20분|16:20|토요일[^.]*6시)/u);
        expect(result.speech, why).toMatch(/추후|미정|공개되지|확인하지|확인할 수 없|아직/u);
      }
      expect(result.pendingConfirmation).toBeUndefined();
      expect(adapterFor(session).page?.url()).toBe("about:blank");
      expect(adapterFor(session).context?.browser()?.contexts()).toHaveLength(1);
      expect(opened.mock.calls.some(([opts]) => opts?.background === true)).toBe(true);
    } finally { await session.close(); }
  } finally { opened.mockRestore(); await runtime.close(); }
}, 180_000);

/** 첫 검색 결과는 로그인 화면이고, 다시 검색하면 공개 안내 화면으로 가는 누리집. */
async function blockedEntrySite(page: ReturnType<typeof pageFor>) {
  const login = "https://loan.example.go.kr/login", guide = "https://loan.example.go.kr/guide";
  const visits: string[] = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    const searched = url.origin === searchOrigin;
    const retry = searched && visits.includes(login);
    const body = searched ? `<title>검색</title><main><a href="${retry ? guide : login}">대여 서비스</a></main>` :
      url.href === login ? "<title>로그인</title><main><input type=password></main>" :
      url.href === guide ? "<title>대여 서비스 이용 안내</title><main>방문 전에 안내문을 확인하세요.</main>" : undefined;
    if (body === undefined) return route.abort();
    visits.push(searched ? searchOrigin : url.href);
    return route.fulfill({contentType: "text/html; charset=utf-8", body});
  });
  return {login, guide, visits};
}

it("finds a public route to the requested screen after the first result requires login", async () => {
  const goal = "대여 서비스 이용 안내 화면을 열어줘. 신청은 하지 마.";
  const {session: create} = await service({PRACTICE_MODE: "false", WEB_SEARCH_URL: searchOrigin + "/?q={q}"});
  const {session} = await create();
  const {login, guide, visits} = await blockedEntrySite(pageFor(session));
  withLlm(session, new FakeLlm(({schemaName, user}) => {
    if (schemaName === "public_service_decision") return {kind: "review_before_output", source: "browser", searchMode: "visible",
      goal, requestedFacts: [], outcome: "arrival", requirements: [goal], exclusions: ["application"], difficulty: "medium", choices: [], continuation: false};
    if (schemaName === "public_browse_step") {
      const {page} = z.object({page: z.object({title: z.string()}).nullable()}).parse(JSON.parse(user));
      if (page === null) return {action: "search", target: visits.includes(login) ? "대여 서비스 공식 공개 안내" : "대여 서비스 이용안내", claims: []};
      return page.title === "검색" ? {action: "click", target: "대여 서비스", claims: []} :
        {action: "answer", claims: [{fact: "other", quote: "방문 전에 안내문을 확인하세요."}]};
    }
    if (schemaName === "review_before_output") {
      const data = z.object({exclusions: z.array(z.string()), currentPageId: z.number().nullable(),
        evidence: z.array(z.object({id: z.number(), text: z.string()}))}).parse(JSON.parse(user));
      expect(data.exclusions).toEqual(["application"]);
      const current = data.evidence.find(row => row.id === data.currentPageId && row.text.includes("대여 서비스 이용 안내"));
      return {checks: [{request: goal, kind: "arrival", citations: current ? [{id: current.id, quote: "대여 서비스 이용 안내"}] : []}],
        nextRoute: current ? null : "browser", answer: current ? "대여 서비스 이용 안내를 열었어요." : ""};
    }
    return undefined;
  }));
  const result = await session.handleTurn(goal);
  expect(result.review?.status).toBe("completed");
  expect(result.observation?.url).toBe(guide);
  expect(visits).toEqual([searchOrigin, login, searchOrigin, guide]);
  expect(result.actions.some(entry => entry.action.type === "fill")).toBe(false);
});

it("retries a blocked first result without spending a review round when the decision omits the search mode", async () => {
  const goal = "대여 서비스 이용 안내에서 방문 전에 무엇을 확인해야 하는지 알려줘.";
  const quote = "방문 전에 안내문을 확인하세요.";
  const {session: create} = await service({PRACTICE_MODE: "false", WEB_SEARCH_URL: searchOrigin + "/?q={q}"});
  const {session} = await create();
  const {login, guide, visits} = await blockedEntrySite(pageFor(session));
  withLlm(session, new FakeLlm(({schemaName, user}) => {
    if (schemaName === "public_service_decision") return {kind: "review_before_output", source: "browser",
      goal, requestedFacts: ["other"], outcome: null, requirements: [goal], exclusions: [], difficulty: "medium", choices: [], continuation: false};
    if (schemaName === "public_browse_step") {
      const {page} = z.object({page: z.object({title: z.string()}).nullable()}).parse(JSON.parse(user));
      if (page === null) return {action: "search", target: visits.includes(login) ? "대여 서비스 공식 공개 안내" : "대여 서비스 이용안내", claims: []};
      return page.title === "검색" ? {action: "click", target: "대여 서비스", claims: []} : {action: "answer", claims: [{fact: "other", quote}]};
    }
    if (schemaName === "review_before_output") {
      const {evidence} = z.object({evidence: z.array(z.object({id: z.number(), text: z.string()}))}).parse(JSON.parse(user));
      const citations = evidence.filter(row => row.text === quote).map(row => ({id: row.id, quote}));
      return {checks: [{request: goal, kind: "fact", citations}], nextRoute: citations.length > 0 ? null : "browser", answer: citations.length > 0 ? quote : ""};
    }
    return undefined;
  }));
  const result = await session.handleTurn(goal);
  expect(visits).toEqual([searchOrigin, login, searchOrigin, guide]);
  expect(result.review?.status).toBe("completed");
  expect(result.review?.rounds).toBe(1);
  expect(result.speech).toContain(quote);
});
