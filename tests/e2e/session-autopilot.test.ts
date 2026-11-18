import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, expect, it } from "vitest";
import type { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { FakeLlm, Gate, PORTAL, scripted, step } from "../helpers.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
afterEach(runtime.closeSessions);
afterAll(runtime.close);
const goal = PORTAL + "에서 장애인연금 안내 기사 내용 알려줘";
const clicked = "127.0.0.1에서 '장애인연금 안내'를 눌렀어요.";
const article = "두 번째 페이지라는 안내 기사예요.";

function goalMode(session: SessionOrchestrator, steps: ReturnType<typeof step>[]) {
  let index = 0;
  const model = new FakeLlm(({schemaName}) => {
    if (schemaName === "chat_route") return {route: "web_task", reply: "", searchQuery: null, language: null};
    if (schemaName === "browse_step") return steps[Math.min(index++, steps.length - 1)];
    return undefined;
  });
  session.deps.llm = model;
  return model;
}

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  const timer = new AbortController();
  const timeout = delay(ms, undefined, {signal: timer.signal}).then(() => { throw new Error(`세션 응답 대기 시간 ${ms}ms 초과`); });
  try { return await Promise.race([work, timeout]); }
  finally { timer.abort(); }
}

function runToThirdDecision(session: SessionOrchestrator) {
  const gate = new Gate([
    step("open_url", "http://" + PORTAL), step("click", "장애인연금 안내"), step("answer", null, article, ["두 번째 페이지입니다"]),
  ], 3);
  session.deps.llm = gate;
  const running = session.handleTurn(goal);
  const reached = Promise.race([gate.reached, running.then(result => {
    throw new Error(`모델이 세 번째 결정을 내리기 전에 턴이 종료되었습니다: ${result.speech}`);
  })]);
  return {gate, reached, running};
}

it("test_goal_intent_by_rules", async () => {
  const {session} = await runtime.createBrowserSession();
  const requests = scripted(session, [step("answer", null, "테스트 답")]);
  const result = await session.handleTurn("네이버에서 오늘 뉴스 알려줘");
  expect(result.intentType).toBe("GOAL");
  expect(result.semanticAction).toBe("goal");
  expect(requests.length).toBeGreaterThan(0);
});

it("test_goal_mode_asks_aloud_before_mock_submit", async () => {
  const {session} = await runtime.createBrowserSession();
  for (const said of ["장애인연금 신청 도와줘", "이름은 김하늘", "주소는 부산광역시 예시구 예시로 10", "다음", "다음"]) await session.handleTurn(said);
  expect(session.web.currentView?.step?.index).toBe(3);
  const model = goalMode(session, [step("click", "모의접수"), step("fail", null, "더 할 일이 없어요.")]);
  const result = await session.handleTurn("남은 거 알아서 마무리해 줘");
  expect(result.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(result.speech).toContain("남은 거 알아서 마무리해 줘");
  expect(result.speech).toContain("김하늘");
  expect(result.observation?.status ?? "").not.toContain("MOCK-");
  expect(result.actions.some(a => a.action.target?.name === "모의접수" && a.result?.ok === true)).toBe(false);
  expect(model.calls.map(r => r.schemaName)).toEqual(expect.arrayContaining(["chat_route", "browse_step"]));
  const done = await session.handleTurn("눌러");
  expect(done.state).toBe("MOCK_SUBMITTED");
  expect(done.observation?.status).toContain("MOCK-");
});

it("test_goal_mode_asks_aloud_before_risky_button_and_clicks_after_go", async () => {
  const {session} = await runtime.createBrowserSession();
  goalMode(session, [step("open_url", "http://localhost:5174/login.html"), step("click", "모의 로그인"), step("fail", null, "더 할 일이 없어요.")]);
  const asked = await session.handleTurn("남은 거 알아서 마무리해 줘");
  expect(asked.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(asked.speech).toContain("'모의 로그인'");
  expect(asked.speech).toContain("눌러");
  expect(asked.actions.some(a => a.policy.code === "NEEDS_CONFIRMATION")).toBe(true);
  const done = await session.handleTurn("눌러");
  const clicked = done.actions.filter(a => a.action.target?.name === "모의 로그인").at(-1);
  expect(clicked?.policy.code).toBe("APPROVED");
  expect(clicked?.result?.ok).toBe(true);
  expect(done.state).not.toBe("WAITING_FOR_USER_CONFIRMATION");
});

it("test_rejecting_a_risky_click_leaves_the_page_alone", async () => {
  const {session, page} = await runtime.createBrowserSession();
  goalMode(session, [step("open_url", "http://localhost:5174/login.html"), step("click", "모의 로그인")]);
  await session.handleTurn("남은 거 알아서 마무리해 줘");
  const url = page.url();
  const rejected = await session.handleTurn("거절");
  expect(rejected.speech).toContain("누르지 않았어요");
  expect(rejected.actions.some(a => a.result?.ok === true)).toBe(false);
  expect(session.dialogue.approval).toBeUndefined();
  expect(page.url()).toBe(url);
});

it("test_progress_question_mid_goal_names_the_current_step", async () => {
  const {session} = await runtime.createBrowserSession();
  const idle = await session.handleTurn("지금 어디까지 했어?");
  expect(idle.intentType).toBe("PROGRESS");
  expect(idle.speech).toBe("지금 하고 있는 일은 없어요.");
  const {gate, reached, running} = runToThirdDecision(session);
  try {
    await within(reached, 30_000);
    const progress = await within(session.handleTurn("청음아, 지금 어디까지 했어?"), 5_000);
    expect(progress.speech).toBe("지금까지 2단계 했어요. 방금 " + clicked);
    expect(progress.actions).toEqual([]);
  } finally { gate.release(); }
  expect((await running).speech).toBe(article);
  expect((await session.handleTurn("어디까지 됐어?")).speech).toBe("지금 하고 있는 일은 없어요. 마지막으로 " + clicked);
});

it("test_stop_still_interrupts_a_goal", async () => {
  const {session} = await runtime.createBrowserSession();
  const {gate, reached, running} = runToThirdDecision(session);
  try {
    await within(reached, 30_000);
    await within(session.handleTurn("지금 어디까지 했어?"), 5_000);
    const stopped = await within(session.handleTurn("멈춰"), 5_000);
    expect(stopped.state).toBe("STOPPED");
    expect((await within(running, 5_000)).state).toBe("STOPPED");
  } finally { gate.release(); }
  const progress = await session.handleTurn("지금 어디까지 했어?");
  expect(progress.state).toBe("STOPPED");
  expect(progress.speech).toBe("지금 하고 있는 일은 없어요. 마지막으로 " + clicked);
  expect(gate.calls).toBe(3);
});

it("test_no_llm_step_by_step", async () => {
  const {session} = await runtime.createBrowserSession();
  const result = await session.handleTurn("네이버에서 오늘 뉴스 알려줘");
  expect(result.semanticAction).toBe("goal");
  expect(result.actions).toEqual([]);
});
