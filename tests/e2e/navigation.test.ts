import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, expect, it } from "vitest";
import { PORTAL2, scripted, step } from "../helpers.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime({ readOnlyClicks: "any" });
afterEach(runtime.closeSessions);
afterAll(runtime.close);
const url = "http://" + PORTAL2;
async function openPortal(query = "") {
  const open = await runtime.createBrowserSession();
  await open.session.handleTurn(PORTAL2 + query + " 열어줘");
  return open;
}
const applyQuote = "신청 방법은 주소지 행정복지센터 3층 복지과 창구를 방문하는 것입니다";

it("test_menu_buttons_reach_the_model", async () => {
  const { session } = await runtime.createBrowserSession();
  const seen = scripted(session, [step("open_url", url), step("answer", null, "복지서비스 메뉴가 있어요.", ["복지서비스"])]);
  await session.handleTurn(PORTAL2 + "에서 메뉴 뭐 있는지 알려줘");
  const names = seen[1]?.page?.items.map(item => item.name);
  expect(names).toEqual(expect.arrayContaining(["복지서비스", "서비스 찾기", "복지지도"]));
  expect(names).not.toContain("글자 크게");
});

it.each([
  ["복지 상담 센터", "복지 상담 센터"], ["이용 안내서", "이용 안내서"], ["관련 법령 보기", "관련 법령"], ["보조기기 체험관 둘러보기", "보조기기 체험관"],
])("test_clicks_elements_missed_before", async (target, title) => {
  const { session } = await runtime.createBrowserSession();
  const seen = scripted(session, [step("open_url", url), step("click", target), step("answer", null, "열었어요.", [title])]);
  const result = await session.handleTurn(PORTAL2 + "에서 " + target + " 찾아줘");
  expect(seen[1]?.page?.items.map(item => item.name)).toContain(target);
  expect(result.observation?.title).toBe("[테스트] 복지 포털 2 - " + title);
});

it.each([
  ["신청방법", applyQuote], ["서비스 내용", "서비스 내용은 보조기기 대여료를 한 달에 최대 3만 원까지 지원하는 것입니다"],
])("test_tab_reveals_its_panel", async (tab, quote) => {
  const { session } = await runtime.createBrowserSession();
  const answer = quote.slice(0, 30) + "예요.";
  const seen = scripted(session, [step("open_url", url), step("click", tab), step("answer", null, answer, [quote])]);
  const result = await session.handleTurn(PORTAL2 + "에서 " + tab + " 알려줘");
  expect(result.speech).toBe(answer);
  expect(seen[1]?.page?.items.find(item => item.name === tab)?.kind).toBe("tab");
  expect(seen[2]?.page?.mainText.startsWith(quote.slice(0, 20))).toBe(true);
  expect(result.trace.some(t => /새로 보이는 내용입니다|같은 화면에서 내용이 바뀌었어요/u.test(t.note ?? ""))).toBe(true);
});

it("test_expander_opens_in_place", async () => {
  const { session } = await runtime.createBrowserSession();
  const quote = "필요한 서류는 신분증 사본과 진단서 두 가지입니다";
  const seen = scripted(session, [step("open_url", url), step("click", "서류는 몇 장인가요?"), step("answer", null, "신분증 사본과 진단서, 두 가지예요.", [quote])]);
  const result = await session.handleTurn(PORTAL2 + "에서 서류 몇 장인지 알려줘");
  expect(result.speech).toBe("신분증 사본과 진단서, 두 가지예요.");
  const expanded = (i: number) => seen[i]?.page?.items.find(item => item.name === "서류는 몇 장인가요?")?.expanded;
  expect([expanded(1), expanded(2)]).toEqual([false, true]);
});

it("test_find_moves_the_text_window", async () => {
  const { session } = await runtime.createBrowserSession();
  const quote = "이의 신청은 결정 통지를 받은 날부터 90일 안에 할 수 있습니다";
  const answer = "결정 통지를 받고 90일 안에 이의 신청할 수 있어요.";
  const seen = scripted(session, [step("open_url", url), step("find", "이의 신청"), step("answer", null, answer, [quote])]);
  const result = await session.handleTurn(PORTAL2 + "에서 이의 신청 기한 알려줘");
  expect(seen[1]?.page?.mainText).not.toContain(quote);
  expect(seen[2]?.page?.mainText).toContain(quote);
  expect(result.speech).toBe(answer);
});

it("test_nothing_changed_is_reported", async () => {
  const { session } = await runtime.createBrowserSession();
  scripted(session, [step("open_url", url), step("click", "글자 크게"), step("fail", null, "못 찾았어요.")]);
  const result = await session.handleTurn(PORTAL2 + "에서 글자 크게 버튼 찾아줘");
  expect(result.semanticAction).toBe("goal");
  expect(result.trace.some(t => t.note?.includes("바뀌지 않았") === true)).toBe(true);
});

it("test_voice_tab_click_reads_revealed_text_quickly", async () => {
  const { session } = await openPortal();
  const start = performance.now();
  const result = await session.handleTurn("신청방법 탭 눌러줘");
  expect(result.speech).toContain("행정복지센터 3층 복지과");
  expect(result.speech).not.toContain("링크를 열었습니다");
  expect(performance.now() - start).toBeLessThan(4000);
});

it("test_slow_tab_panel_is_read_after_it_loads", async () => {
  const { session } = await openPortal();
  const result = await session.handleTurn("부산 창구 탭 눌러줘");
  expect(result.speech).toContain("시청 2층 민원실");
  expect(result.speech).not.toContain("불러오는 중");
});

it("test_rotating_notice_is_not_read_as_the_click_effect", async () => {
  const { session } = await openPortal("?rotate=1");
  await delay(1500);
  await session.handleTurn("본문 읽어줘");
  await delay(1500);
  expect((await session.handleTurn("글자 크게 버튼 눌러줘")).speech).toContain("바뀌지 않았");
  await delay(1000);
  const tab = await session.handleTurn("신청방법 탭 눌러줘");
  expect(tab.speech).toContain("행정복지센터 3층 복지과");
  expect(tab.speech).not.toContain("점검");
});

it("test_content_that_arrived_late_does_not_hide_the_next_click", async () => {
  const { session } = await openPortal("?lazy=1");
  await delay(3000);
  await session.handleTurn("본문 읽어줘");
  expect((await session.handleTurn("다음 쪽 버튼 눌러줘")).speech).toContain("2쪽 첫 항목");
});

it("test_link_acting_as_tab_finishes_quickly", async () => {
  const { session } = await openPortal();
  const start = performance.now();
  const result = await session.handleTurn("문의처 안내 링크 눌러줘");
  expect(result.speech).toContain("내선 204번");
  expect(performance.now() - start).toBeLessThan(4000);
});

it("test_voice_click_without_effect_says_so", async () => {
  const { session } = await openPortal();
  expect((await session.handleTurn("글자 크게 버튼 눌러줘")).speech).toContain("바뀌지 않았");
});

it("test_link_inside_popup_can_be_pressed", async () => {
  const { session } = await openPortal();
  const start = performance.now();
  expect((await session.handleTurn("공지 팝업 열기 버튼 눌러줘")).speech).toContain("대여 품목이 늘어납니다");
  expect(performance.now() - start).toBeLessThan(4000);
  const result = await session.handleTurn("공지 자세히 보기 링크 눌러줘");
  expect(result.observation?.title).toBe("[테스트] 복지 포털 2 - 공지");
});

it("test_login_button_waits_for_the_go_word", async () => {
  const { session } = await openPortal();
  const result = await session.handleTurn("로그인 눌러줘");
  expect(result.speech).toContain("누를까요?");
  expect(result.actions.filter(a => a.action.type === "click")).toEqual([]);
});

it("test_login_click_is_dropped_when_the_button_changed", async () => {
  const { session, page } = await openPortal();
  await session.handleTurn("로그인 눌러줘");
  const approval = session.dialogue.approval;
  const ref = approval !== undefined && "action" in approval ? approval.action.target?.ref : undefined;
  expect(ref).toBeDefined();
  await page.locator('[data-cheongeum-ref="' + ref + '"]').evaluate(el => { el.textContent = "회원 탈퇴"; });
  const result = await session.handleTurn("눌러");
  expect(result.speech).toMatch(/^누르려던 '로그인' 버튼이 다른 것으로 바뀌었어요\. 그래서 누르지 않았어요\./u);
  expect(result.actions.filter(a => a.action.type === "click")).toEqual([]);
  expect(session.dialogue.approval).toBeUndefined();
});

it("test_rotating_notice_does_not_cancel_an_approval", async () => {
  const { session } = await openPortal("?rotate=1");
  await session.handleTurn("로그인 눌러줘");
  await delay(1500);
  const result = await session.handleTurn("눌러");
  const click = result.actions.filter(a => a.action.type === "click").at(-1);
  expect(click?.policy.code).toBe("APPROVED");
  expect(click?.result?.ok).toBe(true);
});

it("test_cloned_elements_get_their_own_ref", async () => {
  const { session, page } = await openPortal();
  await session.web.observe();
  await page.getByRole("link", { name: "담당 기관 안내", exact: true }).evaluate(original => {
    const clone = original.cloneNode(true);
    clone.textContent = "담당 기관 안내 2";
    original.parentElement!.append(clone);
    clone.addEventListener("click", () => { location.href = "/portal2.html?section=agency"; });
  });
  const refs = (await session.web.observe()).outline?.items?.map(item => item.ref) ?? [];
  expect(refs.length).toBeGreaterThan(1);
  expect(new Set(refs).size).toBe(refs.length);
  const result = await session.handleTurn("담당 기관 안내 2 링크 눌러줘");
  expect(result.observation?.title).toBe("[테스트] 복지 포털 2 - 담당 기관");
});

it("test_elements_are_classified_for_the_guard", async () => {
  const { session } = await openPortal();
  const roles = Object.fromEntries(((await session.web.observe()).outline?.items ?? []).map(item => [item.name, item.role]));
  expect(roles).toMatchObject({
    "맞춤 서비스": "link", "관련 법령 보기": "scriptlink", "복지서비스": "button", "신청방법": "tab", "보조기기 체험관 둘러보기": "generic",
  });
});

it("test_safe_mode_allows_information_tabs_only", async () => {
  const { session } = await runtime.createBrowserSession({ readOnlyClicks: "safe" });
  const answer = "행정복지센터 3층 복지과 창구에서 신청해요.";
  scripted(session, [step("open_url", url), step("click", "온라인 신청하기"), step("click", "보조기기 체험관 둘러보기"),
    step("click", "신청방법"), step("answer", null, answer, [applyQuote])]);
  const result = await session.handleTurn(PORTAL2 + "에서 신청 방법 알려줘");
  expect(result.trace.filter(t => t.note?.includes("안전 규칙으로 막힘") === true)).toHaveLength(2);
  expect(result.speech).toBe(answer);
  expect(result.observation?.title).toBe("[테스트] 복지 포털 2 - 보조기기 지원 상세");
});
