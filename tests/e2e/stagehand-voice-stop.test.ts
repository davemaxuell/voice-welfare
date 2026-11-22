import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { stagehandTab } from "../../src/agents/web/browser/stagehand_browser.ts";
import { PORTAL } from "../helpers.ts";
import { browserCases, latch } from "./browser-cases.ts";

const open = browserCases();
beforeAll(() => { vi.stubEnv("BROWSER_DRIVER", "stagehand"); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { vi.unstubAllEnvs(); });

it("확인을 승인했어도 단추가 가려진 사이에 멈춰라고 하면 누르지 않는다", async () => {
  const { page, session } = await open();
  await session.handleTurn(PORTAL + " 열어줘");
  await page.setContent('<title>안내 목록</title><main><button onclick="document.title=\'눌림\'">확인</button></main>');
  const ask = await session.handleTurn("확인 버튼 눌러줘");
  expect(ask.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(ask.speech).toContain("확인");
  await page.evaluate(() => {
    const cover = document.createElement("div");
    cover.id = "가림";
    cover.style.cssText = "position:fixed;inset:0;z-index:10";
    document.body.append(cover);
  });
  const cover = page.locator("#가림");
  const waiting = latch();
  await page.addLocatorHandler(cover, async () => { waiting.resolve(); });
  const pressing = session.handleTurn("응");
  try {
    await Promise.race([waiting.promise, pressing.then(turn => { throw new Error(turn.speech); })]);
    expect((await session.handleTurn("멈춰")).state).toBe("STOPPED");
    expect((await pressing).state).toBe("STOPPED");
  } finally {
    await page.evaluate(() => { document.getElementById("가림")?.remove(); });
    await page.removeLocatorHandler(cover);
  }
  expect(await page.title()).toBe("안내 목록");
  await session.handleTurn("다시 시작해줘");
  expect(await page.title()).toBe("안내 목록");
});

it("개인정보 입력을 승인했어도 입력 직전에 멈춰라고 하면 늦게 도착한 요청이 값을 쓰지 않는다", async () => {
  const { page, session } = await open();
  await session.handleTurn(PORTAL + " 열어줘");
  const ask = await session.handleTurn("이름 칸에 김하늘 써줘");
  expect(ask.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  const field = page.locator("#opinionName");
  await field.evaluate(el => { el.addEventListener("input", () => { el.dataset.input = "입력됨"; }); });
  const { tab } = await stagehandTab(page);
  const policy = vi.spyOn(session.deps.web.guard, "check");
  const evaluate = tab.evaluate.bind(tab);
  const waiting = latch(), release = latch(), dispatched = latch();
  vi.spyOn(tab, "evaluate").mockImplementation(async (source, arg) => {
    if (typeof arg !== "object" || arg === null || !("token" in arg)) return evaluate(source, arg);
    waiting.resolve();
    await release.promise;
    try { return await evaluate(source, arg); }
    finally { dispatched.resolve(); }
  });
  const filling = session.handleTurn("응");
  try {
    await Promise.race([waiting.promise, filling.then(turn => { throw new Error(turn.speech); })]);
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ type: "fill", requiresConfirmation: true,
      target: expect.objectContaining({ ref: expect.any(String), role: "textbox", name: "이름", fieldId: "opinionName" }),
    }), expect.anything());
    expect((await session.handleTurn("멈춰")).state).toBe("STOPPED");
    expect((await filling).state).toBe("STOPPED");
  } finally { release.resolve(); }
  await dispatched.promise;
  expect(await field.inputValue()).toBe("");
  expect(await field.getAttribute("data-input")).toBeNull();
});

it("이름이 같은 새 입력 칸에는 예전 음성 승인으로 개인정보를 쓰지 않는다", async () => {
  const { page, session } = await open();
  await session.handleTurn(PORTAL + " 열어줘");
  expect((await session.handleTurn("이름 칸에 김하늘 써줘")).state).toBe("WAITING_FOR_USER_CONFIRMATION");
  const field = page.locator("#opinionName");
  await field.evaluate(el => el.replaceWith(el.cloneNode(true)));
  const reply = await session.handleTurn("응");
  expect(reply.speech).toContain("바뀌");
  expect(reply.actions.some(entry => entry.result?.ok === true)).toBe(false);
  expect(await field.inputValue()).toBe("");
});

it.each(["실행 전", "요소를 찾는 동안"])("%s 다시 연 문서가 똑같은 번호·역할·이름을 써도 이전 문서의 입력을 보내지 않는다", async when => {
  const { page, adapter } = await open();
  await page.addInitScript(() => { Math.random = () => 0.25; });
  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent('<input id="field" aria-label="이름">'));
  const signal = new AbortController().signal;
  const first = await adapter.bindTarget!({fieldId: "field"}, signal);
  let reloaded = false;
  const reload = async () => {
    await page.reload();
    reloaded = true;
  };
  if (when === "실행 전") await reload();
  else {
    const {tab} = await stagehandTab(page);
    const evaluate = tab.evaluate.bind(tab);
    vi.spyOn(tab, "evaluate").mockImplementation(async (source, arg) => {
      if (!reloaded && typeof source === "string" && source.startsWith("JSON.stringify(")) await reload();
      return evaluate(source, arg);
    });
  }
  const stale = await adapter.execute({id: "이전-입력", type: "fill", target: first, value: "시험", risk: "sensitive",
    reason: "이전 문서에서 승인된 입력", requiresConfirmation: true}, signal);
  expect(reloaded).toBe(true);
  expect(await adapter.bindTarget!({fieldId: "field"}, signal)).toEqual(first);
  expect(stale.errorCode).toBe("VERIFY_FAILED");
  expect(await page.locator("#field").inputValue()).toBe("");
});
