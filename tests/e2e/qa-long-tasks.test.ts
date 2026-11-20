import { expect, it, vi } from "vitest";
import { z } from "zod";
import { FIXED } from "../../src/language/i18n.ts";
import { FakeLlm, PORTAL, PORTAL2, step, withLlm } from "../helpers.ts";
import { browserCases, flat } from "./browser-cases.ts";

const open = browserCases(), contact = "대표번호는 국번없이 1234예요.", phone = PORTAL + "에서 고객센터 전화번호 찾아줘";
const contactSteps = [step("open_url", PORTAL), step("answer", null, contact, ["대표번호 국번없이 1234"])];
const utterance = z.object({utterance: z.string()});
function goalModel(steps: ReturnType<typeof step>[], extra: Record<string, unknown> = {}) {
  const seen: string[] = [];
  const model = new FakeLlm(({ schemaName, user }) => {
    if (schemaName === "intent_plan") {
      const text = utterance.parse(JSON.parse(user)).utterance;
      if (text.includes(PORTAL2) || text.includes("external.html")) return {steps: [flat("GOAL", {topic: text})]};
    }
    if (schemaName !== "browse_step") return extra[schemaName];
    seen.push(z.object({goal: z.string()}).parse(JSON.parse(user)).goal);
    return steps[Math.min(seen.length, steps.length) - 1];
  });
  return {model, seen};
}

it("test_site_goal_with_several_questions_stays_one_goal", async () => {
  const { session } = await open(), {model, seen} = goalModel([step("open_url", PORTAL2),
    step("answer", null, "주소지 행정복지센터 3층 복지과 창구를 방문하면 돼요.", ["신청 방법은 주소지 행정복지센터 3층 복지과 창구를 방문하는 것입니다."])]);
  withLlm(session, model);
  const text = PORTAL2 + "에서 보조기기 지원 신청 방법 찾아줘. 인터넷이 어려우니 어디로 직접 가면 되는지, 언제 신청할 수 있는지 알려줘.";
  expect((await session.handleTurn(text)).intentType).toBe("GOAL"); expect(seen[0]).toContain("언제 신청할 수 있는지");
  expect(model.calls.filter(c => c.schemaName === "intent_plan").map(c => utterance.parse(JSON.parse(c.user)).utterance)).toEqual([text]);
});
const longGoal = PORTAL2 + "에서 긴 안내문 끝에 있는 이의 신청 기한 알려줘.";
it("test_reads_to_the_end_of_a_long_page", async () => {
  const { session } = await open();
  withLlm(session, goalModel([step("open_url", PORTAL2), ...Array.from({length: 3}, () => step("read_more")),
    step("answer", null, "결정 통지를 받은 날부터 90일 안에 이의 신청을 할 수 있어요.", ["이의 신청은 결정 통지를 받은 날부터 90일 안에 할 수 있습니다."])]).model);
  const result = await session.handleTurn(longGoal); expect(result.speech).not.toContain("맴돌고"); expect(result.speech).toContain("90일");
});
it("test_read_more_past_the_end_is_a_failed_step", async () => {
  const { session } = await open();
  withLlm(session, goalModel([step("open_url", PORTAL2), ...Array.from({length: 9}, () => step("read_more"))]).model);
  const result = await session.handleTurn(longGoal);
  expect(result.trace.some(t => t.note?.includes("본문 끝") === true)).toBe(true); expect(result.speech).toContain("맴돌고");
});
it("test_slow_repeat_spells_the_number_and_keeps_settings", async () => {
  const { session } = await open(), {model} = goalModel(contactSteps, {simple: {text: "쉽게 바꾼 말이에요."}});
  withLlm(session, model); await session.handleTurn(phone);
  const before = session.snapshot().speechPrefs, result = await session.handleTurn("그 번호를 다시 천천히 말해줘");
  expect(result.intentType).toBe("REPHRASE"); expect(result.speech).toContain("1 2 3 4");
  expect(model.calls.some(c => c.schemaName === "simple")).toBe(false); expect(session.snapshot().speechPrefs).toEqual(before);
});
it("test_open_official_opens_the_selected_service_page", async () => {
  const { session } = await open();
  vi.spyOn(session.deps.welfare, "currentServiceName", "get").mockReturnValue("보조기기 지원");
  vi.spyOn(session.deps.welfare, "currentServiceUrl", "get").mockReturnValue("http://" + PORTAL2);
  const result = await session.handleTurn("공식 안내 열어줘");
  expect(result.intentType).toBe("OPEN_OFFICIAL"); expect(result.observation?.url).toMatch(/\/portal2\.html$/u);
  expect(result.speech.startsWith("보조기기 지원 공식 안내를 열었어요.")).toBe(true);
  expect(result.actions.every(a => a.policy.code === "ALLOWED_READ_ONLY")).toBe(true);
});
it("test_open_official_without_a_service_asks", async () => {
  const { session } = await open(), result = await session.handleTurn("공식 안내 열어줘");
  expect(result.state === "NEEDS_CLARIFICATION" || result.speech.includes("어떤 제도")).toBe(true); expect(result.actions).toEqual([]);
});
it("test_real_site_login_without_a_site_asks_instead_of_practice_login", async () => {
  const { session } = await open({practiceMode: false}), result = await session.handleTurn("로그인해줘");
  expect(result.state).not.toBe("AUTH_HANDOFF"); expect(result.actions.map(a => a.action.type)).not.toContain("navigate");
  expect(result.speech).toContain("어느 사이트"); expect((await session.handleTurn("모의 로그인 연습할래")).state).toBe("AUTH_HANDOFF");
});
it("test_verified_web_answer_carries_its_page_as_source", async () => {
  const { session } = await open(); withLlm(session, goalModel(contactSteps).model);
  const result = await session.handleTurn(phone); expect(result.sources[0]?.url).toContain("http://" + PORTAL); expect(result.speech).toBe(contact);
});
it("test_open_official_for_another_named_service_does_not_open_the_current_one", async () => {
  const { session } = await open();
  vi.spyOn(session.deps.welfare, "currentServiceName", "get").mockReturnValue("기초연금");
  vi.spyOn(session.deps.welfare, "currentServiceUrl", "get").mockReturnValue("http://" + PORTAL2);
  vi.spyOn(session.deps.welfare, "selectService").mockResolvedValue(undefined);
  const result = await session.handleTurn("장애인연금 공식 안내 열어줘");
  expect(result.intentType).toBe("OPEN_OFFICIAL"); expect(result.actions).toEqual([]); expect(result.speech).not.toContain("기초연금"); expect(result.speech).toContain("장애인연금");
});
it("test_name_question_on_a_page_without_a_form_is_answered_not_refused", async () => {
  const { session } = await open();
  withLlm(session, goalModel([step("open_url", PORTAL), step("answer", null, "상담은 보건복지상담센터에서 받을 수 있어요.", ["상담은 보건복지상담센터에서 받을 수 있습니다"])],
    {chat_route: {route: "general", reply: "행정복지센터라고 하시면 돼요.", searchQuery: null, language: null}}).model);
  await session.handleTurn(PORTAL + "에서 상담 어디서 받는지 알려줘");
  expect((await session.handleTurn("문의해야 할 기관 이름이 뭐야?")).speech).not.toContain("입력을 대신하지 않아요");
});
it("test_typed_verification_code_never_reaches_the_screen_summary", async () => {
  const { session, page } = await open();
  await page.goto("http://" + PORTAL + "?x=1");
  await page.setContent('<title>회원 정보</title><label>주민등록번호 뒷자리<input id="code" value="1234567"></label><label>이름<input id="name" value="김하늘"></label>');
  const view = await session.web.observe();
  const field = session.summarize(view)?.fields.find(f => f.label === "주민등록번호 뒷자리");
  expect(field?.value).toBe("");
});
it("test_language_switch_and_fixed_lines_during_a_login_handoff", async () => {
  const { session } = await open(); withLlm(session, new FakeLlm());
  expect((await session.handleTurn("모의 로그인 연습할래")).state).toBe("AUTH_HANDOFF");
  expect(await session.handleTurn("영어로 말해줘")).toMatchObject({intentType: "SET_LANGUAGE", lang: "en"});
  expect(session.dialogue.authWaiting).toBe(true); expect((await session.handleTurn("hmm what now")).speech).toBe(FIXED.possibleSecretAuth.en);
  expect((await session.handleTurn("I'm done")).intentType).toBe("AUTH_DONE");
});
it("test_named_source_is_spoken_once_per_site", async () => {
  const { session, page } = await open(), catalog = await session.deps.welfare.provider.catalog();
  const url = catalog.find(row => row.servNm === "기초연금")?.detailUrl;
  if (url === undefined || url === "") throw new Error("Missing fixture service URL");
  const quote = "가까운 읍면동 주민센터에 방문하여 신청합니다.";
  await page.route(url, r => r.fulfill({contentType: "text/html; charset=utf-8", body: "<title>기초연금 상세</title><main>" + quote + "</main>"}));
  withLlm(session, goalModel([step("answer", null, quote, [quote])]).model);
  const first = await session.handleTurn("복지로에서 기초연금 신청 방법 찾아줘"), again = await session.handleTurn("복지로에서 기초연금 신청 방법 찾아줘");
  expect(first.speech.endsWith("복지로 화면에서 확인했어요.")).toBe(true); expect(again.speech).toBe(quote); expect(again.sources[0]?.url).toBe(url);
});
it("test_near_miss_site_name_is_confirmed_before_going", async () => {
  const { session } = await open(), first = await session.handleTurn("복지관에서 하는 프로그램 알려줘");
  expect(first.speech).toContain("'복지로' 말씀이세요?"); expect(first.actions).toEqual([]);
  const declined = await session.handleTurn("아니"); expect(declined.actions).toEqual([]); expect(declined.intentType).not.toBe("GOAL");
});
async function naver() {
  const opened = await open();
  await opened.page.route("https://www.naver.com/**", r => r.fulfill({contentType: "text/html; charset=utf-8", body: "<title>NAVER</title><main>네이버 첫 화면</main>"}));
  return opened.session;
}
it("test_near_miss_site_name_goes_after_yes", async () => {
  const session = await naver(), first = await session.handleTurn("네이보 열어줘");
  expect(first.speech).toContain("'네이버' 말씀이세요?"); expect(first.actions).toEqual([]);
  const yes = await session.handleTurn("응"); expect(yes.intentType).toBe("OPEN_SITE"); expect(yes.observation?.url).toMatch(/^https:\/\/www\.naver\.com/u);
});
it("test_exact_site_name_is_not_confirmed", async () => {
  const session = await naver(), result = await session.handleTurn("네이버 열어줘");
  expect(result.intentType).toBe("OPEN_SITE"); expect(result.speech).not.toContain("말씀이세요");
});
