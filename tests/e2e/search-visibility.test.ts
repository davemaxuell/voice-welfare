import { afterEach, expect, it, vi } from "vitest";
import * as browser from "../../src/agents/web/browser/index.ts";
import { ModelTransportError } from "../../src/core/llm.ts";
import { LOOKUP_TIMEOUT, LOOKUP_UNAVAILABLE, PublicTask } from "../../src/orchestrator/public_task.ts";
import { BROWSE_TIME_BUDGET_MS } from "../../src/agents/web/autopilot.ts";
import { redactText } from "../../src/safety/privacy.ts";
import type { OrchestratorDeps } from "../../src/orchestrator/session.ts";
import { FakeLlm, withLlm } from "../helpers.ts";
import { latch } from "./browser-cases.ts";
import { pageFor, runtimeCases } from "./browser-runtime-cases.ts";

const service = runtimeCases(), original = browser.launchBrowser;
afterEach(() => vi.restoreAllMocks());
const question = "우리나라 어린이날이 언제인지 알려줘.", visible = "정부24에서 어린이날 날짜를 검색하는 화면을 직접 보여줘.";
const goal = "대한민국 어린이날 날짜", fact = "어린이날은 5월 5일입니다.";
const source = {title: "공휴일 안내", url: "https://www.gov.kr/", lastCheckedAt: "2026-11-20"};
function lookup(mode: "quiet" | "visible") {
  return {kind: "find_information", source: "browser", searchMode: mode, agency: mode === "visible" ? "정부24" : null, subject: "어린이날",
    goal, requestedFacts: ["dates"], exclusions: [], continuation: false, question: null, choices: [], skill: null, reply: null};
}
async function desktop() {
  const launches = vi.spyOn(browser, "launchBrowser").mockImplementation(async (headless, slow) => {
    expect(headless).toBe(false);
    const chromium = await original(true, slow), create = chromium.newContext.bind(chromium);
    vi.spyOn(chromium, "newContext").mockImplementation(async opts => {
      const context = await create(opts); await context.route("https://www.gov.kr/**", route =>
        route.fulfill({contentType: "text/html; charset=utf-8", body: "<title>공휴일 안내</title><main><p>" + fact + "</p></main>"})); return context;
    });
    return chromium;
  });
  const { session: create } = await service({PRACTICE_MODE: "false", REQUIRE_CONSENT: "true", HEADLESS: "false"});
  const {session} = await create(); await session.consentTo(true); expect(launches).not.toHaveBeenCalled();
  return {session, launches};
}

it("test_answer_first_then_show_on_request_and_keep_the_page", async () => {
  const {session, launches} = await desktop();
  const quiet = vi.fn<NonNullable<OrchestratorDeps["quietSearch"]>>().mockResolvedValue({speech: fact, sources: [source]});
  const delegate = vi.fn<NonNullable<OrchestratorDeps["delegateResearch"]>>();
  session.deps.quietSearch = quiet; session.deps.delegateResearch = delegate;
  let mode: "quiet" | "visible" = "quiet";
  const model = new FakeLlm(({schemaName}) => schemaName === "public_service_decision" ? lookup(mode) : schemaName === "public_browse_step" ?
    {action: "answer", target: null, answer: null, claims: [{fact: "dates", quote: fact}]} : undefined);
  withLlm(session, model);
  const first = await session.handleTurn(question, {fromVoice: true}); expect(first.speech).toContain(fact); expect(first.sources[0]?.url).toBe(source.url);
  expect(first.actions).toEqual([]); expect(first.pendingConfirmation).toBeUndefined();
  expect(quiet).toHaveBeenCalledWith(expect.objectContaining({goal}), "ko", expect.objectContaining({aborted: false})); expect(launches).not.toHaveBeenCalled();
  mode = "visible";
  const shown = await session.handleTurn(visible); expect(launches).toHaveBeenCalledTimes(1); expect(quiet).toHaveBeenCalledTimes(1);
  expect(shown.observation?.url).toContain(source.url); expect(shown.speech).toContain(fact);
  const page = pageFor(session); await page.evaluate(() => { document.documentElement.dataset.lookupMarker = "keep this document"; });
  mode = "quiet";
  const final = await session.handleTurn(question); expect(final.speech).toContain(fact); expect(final.actions).toEqual([]);
  expect(quiet).toHaveBeenCalledTimes(2); expect(pageFor(session)).toBe(page);
  expect(await page.evaluate(() => document.documentElement.dataset.lookupMarker)).toBe("keep this document"); expect(delegate).not.toHaveBeenCalled();
});
it.each([true, false])("test_quiet_search_unavailable_stays_in_conversation", async configured => {
  const {session, launches} = await desktop();
  withLlm(session, new FakeLlm({public_service_decision: lookup("quiet")}));
  session.deps.quietSearch = configured ? async () => {throw new Error("timeout");} : undefined;
  const reply = await session.handleTurn(question); expect(reply.speech).toBeTruthy(); expect(reply.sources).toEqual([]); expect(reply.actions).toEqual([]);
  expect(reply.pendingConfirmation).toBeUndefined(); expect(launches).not.toHaveBeenCalled();
});
it("test_browser_fallback_failure_stays_in_conversation", async () => {
  const {session, launches} = await desktop();
  withLlm(session, new FakeLlm({public_service_decision: lookup("quiet")}));
  session.deps.quietSearch = undefined;
  session.deps.browsePublicSources = async () => {throw new Error("worker browser failed");};
  const reply = await session.handleTurn(question);
  expect(reply.speech).toBe(LOOKUP_UNAVAILABLE.ko); expect(reply.state).not.toBe("RECOVERING");
  expect(reply.sources).toEqual([]); expect(launches).not.toHaveBeenCalled();
});
it("조용히 조사한 탭에서 근거를 찾지 못하면 도착한 곳과 음성으로 이어갈 동작을 알려 준다", async () => {
  const {session} = await desktop();
  withLlm(session, new FakeLlm({public_service_decision: lookup("quiet")}));
  session.deps.quietSearch = undefined;
  session.deps.browsePublicSources = async () => ({
    state: "BROWSING", semanticAction: "goal", speech: "검증되지 않은 답", lastVisitedTitle: "도시 기록 열람실", browserIterations: 10,
  });
  const reply = await session.handleTurn(question);
  expect(reply.speech).toContain("도시 기록 열람실");
  expect(reply.speech).toContain("공식 사이트의 검색 화면을 열어 줘");
  expect(reply.speech).not.toContain("검증되지 않은 답");
  expect(reply.sources).toEqual([]);
});
it("test_browser_fallback_model_outage_is_reported", async () => {
  const {session} = await desktop();
  withLlm(session, new FakeLlm({public_service_decision: lookup("quiet")}));
  session.deps.quietSearch = undefined;
  session.deps.browsePublicSources = async () => {throw new ModelTransportError(503);};
  const reply = await session.handleTurn(question);
  expect(reply.state).toBe("RECOVERING"); expect(reply.speech).toContain("AI 서비스"); expect(reply.sources).toEqual([]);
  expect(reply.researchDelivery).toBe("outcome");
  session.detachForRecovery();
  expect(session.researchReceipts().outcomes).toContainEqual({turnId: reply.turnId, speech: reply.speech, lang: reply.lang});
  session.acknowledgeResearch(reply.turnId);
  expect(session.researchReceipts().outcomes).toEqual([]);
});

it("나중에 비공개로 밝혀진 값은 미전달 결과에서도 지운다", async () => {
  const {session} = await desktop();
  const turn = session.beginTurn(redactText(question));
  const result = session.finish(turn, {state: "IDLE", semanticAction: "web-answer", speech: "가온누리 접수처입니다.", researchDelivery: "outcome"});
  expect(session.researchReceipts().outcomes[0]?.speech).toBe(result.speech);
  session.redactEarlierMentions(["가온누리"]);
  expect(session.researchReceipts().outcomes[0]?.speech).not.toContain("가온누리");
  session.cancel();
  expect(session.researchReceipts().outcomes).toEqual([]);
});
it("test_stop_discards_late_silent_search_answer", async () => {
  const {session, launches} = await desktop(), started = latch(), aborted = latch();
  withLlm(session, new FakeLlm({public_service_decision: lookup("quiet")}));
  session.deps.quietSearch = async (_task, _lang, signal) => {
    started.resolve(); signal.addEventListener("abort", aborted.resolve, {once: true}); await aborted.promise; return {speech: fact, sources: [source]};
  };
  const work = session.handleTurn(question);
  try {
    await started.promise; session.cancel();
    const result = await work; expect(result.state).toBe("STOPPED"); expect(result.speech).not.toContain(fact);
    expect(result.sources).toEqual([]); expect(launches).not.toHaveBeenCalled();
  } finally {aborted.resolve(); await work;}
});

it("공식 사이트 확인을 알린 뒤 브라우저가 응답하지 않아도 같은 턴에서 종료를 한 번 알린다", async () => {
  const {session} = await desktop();
  const aborts: string[] = [];
  session.deps.quietSearch = undefined;
  session.deps.browsePublicSources = async (_task, ctx) => new Promise(resolve => {
    ctx.signal.addEventListener("abort", () => {aborts.push("worker"); resolve(undefined);}, {once: true});
  });
  const turn = {...session.beginTurn(redactText(question)), started: performance.now() - BROWSE_TIME_BUDGET_MS + 100};
  const result = session.finish(turn, await session.planner.quietLookup(new PublicTask({goal, subject: goal, facts: ["dates"]}), turn));
  expect(aborts).toEqual(["worker"]);
  expect(result).toMatchObject({researchDelivery: "outcome", speech: LOOKUP_TIMEOUT.ko});
  expect(result.speech).toContain("검색 화면을 열어 줘");
  expect(session.researchReceipts().outcomes).toEqual([{turnId: result.turnId, speech: result.speech, lang: "ko"}]);
});
