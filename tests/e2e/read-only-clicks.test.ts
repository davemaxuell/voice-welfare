import { expect, it, vi } from "vitest";
import { PORTAL, PORTAL2, scripted, step } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();

async function askChange() {
  const opened = await open();
  await opened.session.handleTurn(PORTAL2 + " 열어줘");
  const result = await opened.session.handleTurn("검색 조건 변경 눌러줘");
  expect(result.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(result.speech).toContain("검색 조건 변경");
  expect(result.speech).toContain("누를까요");
  expect(await opened.page.locator("#filter-panel").isHidden()).toBe(true);
  const approval = opened.session.dialogue.approval;
  if (approval?.kind !== "click") throw new Error("Expected a click approval");
  const actionId = approval.action.id;
  return { ...opened, actionId };
}

it("test_ask_tier_button_presses_after_yes", async () => {
  const { session, page, actionId } = await askChange();
  const result = await session.handleTurn("눌러");
  expect(await page.locator("#filter-panel").isVisible()).toBe(true);
  expect(result.actions.filter(a => a.policy.code === "APPROVED").map(a => a.action.id)).toEqual([actionId]);
  expect(session.dialogue.approval).toBeUndefined();
});

it.each(["거절", "눌러"])("test_ask_tier_decline_or_target_change_never_clicks", async answer => {
  const { session, page } = await askChange();
  if (answer === "눌러") await page.locator("#filter-change").evaluate(el => { el.textContent = "검색 조건 초기화"; });
  const result = await session.handleTurn(answer);
  if (answer === "눌러") expect(result.speech).toContain("누르지 않았어요");
  expect(await page.locator("#filter-panel").isHidden()).toBe(true);
  expect(session.dialogue.approval).toBeUndefined();
});

it("test_hard_tier_still_refused", async () => {
  const { session } = await open();
  await session.handleTurn(PORTAL + " 열어줘");
  const result = await session.handleTurn("보내기 눌러줘");
  expect(result.speech).toContain("직접 눌러 주세요");
  expect(result.state).not.toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(result.actions.some(a => a.result?.ok === true)).toBe(false);
});

it.each(["아니, 눌러", "응 그리고 본문 읽어줘"])("test_offline_partial_approval_never_clicks", async reply => {
  const { session, page } = await askChange();
  await session.handleTurn(reply);
  expect(await page.locator("#filter-panel").isHidden()).toBe(true);
});

it("test_ask_tier_does_not_follow_an_approval_to_another_record", async () => {
  const { session, page } = await askChange();
  await page.evaluate(() => history.pushState({}, "", "?item=2#details"));
  expect((await session.handleTurn("눌러")).speech).toContain("화면 주소가 바뀌었어요");
  expect(await page.locator("#filter-panel").isHidden()).toBe(true);
  expect(session.dialogue.approval).toBeUndefined();
});

it("test_unrestricted_goal_pauses_at_generic_control", async () => {
  const { session, page } = await open();
  scripted(session, [step("open_url", PORTAL2), step("click", "보조기기 체험관 둘러보기")]);
  const result = await session.handleTurn(PORTAL2 + "에서 보조기기 체험관 찾아줘");
  expect(result.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(result.speech).toContain("보조기기 체험관 둘러보기");
  expect(page.url()).toMatch(/portal2\.html$/u);
});

it("test_approved_ask_click_does_not_retry_after_timeout", async () => {
  const { session, page, adapter, actionId } = await askChange();
  const original = adapter.execute.bind(adapter), attempts: string[] = [];
  vi.spyOn(adapter, "execute").mockImplementation(async (action, signal) => {
    if (action.type !== "click") return original(action, signal);
    attempts.push(action.id);
    return { actionId: action.id, ok: false, verified: false, latencyMs: 0, errorCode: "TIMEOUT" };
  });
  await session.handleTurn("눌러");
  expect(attempts).toEqual([actionId]);
  expect(await page.locator("#filter-panel").isHidden()).toBe(true);
});
