import { expect, it } from "vitest";
import { FakeLlm, PORTAL } from "../helpers.ts";
import { browserCases, flat } from "./browser-cases.ts";

const open = browserCases();
const search = "하이코리아 홈페이지 열어줘";
const first = "하이코리아 홈페이지 신청 방법";
const list = "링크 목록 알려줘";
async function listed() {
  const opened = await open();
  await opened.session.handleTurn(PORTAL + " 열어줘");
  await opened.session.handleTurn(list);
  return opened;
}

it.each([
  ["2번 눌러줘","welfare"],
  ["1번 말고 2번 눌러줘","welfare"],
  ["1번은 누르지 말고 2번을 눌러줘","welfare"],
  ["첫 링크 눌러줘","news"],
  ["1번이 뭐였지?",null],
  ["1번?",null],
  ["1번 눌러줄래?","news"],
  ["1번은 누르지 마",null],
  ["1번이나 2번 눌러줘",null],
] as const)("test_listed_links_respect_the_whole_request", async (utterance, section) => {
  const { session, page } = await listed();
  const before = page.url();
  session.deps.llm = new FakeLlm();
  const result = await session.handleTurn(utterance);
  if (section !== null) expect([...new URL(page.url()).searchParams]).toEqual([["section", section]]);
  else {
    expect(page.url()).toBe(before);
    expect(result.actions).toEqual([]);
    if (utterance.includes("뭐였지")) expect(result.speech).toContain("뉴스");
  }
});

it.each([
  "네",
  "그거 눌러줘",
  "네, 그거 열어줘",
  "첫 번째 검색 결과 열어줘",
  "네, 화면에 있는 첫 번째 링크가 맞아요",
  ",네화면에있는첫번째링크가맞아요.",
  "예. 첫 검색 결과가 맞습니다.",
  "첫 번째가 맞아요",
  "네, 그 링크 맞아. 화면에 있는 첫 링크가 맞아. 그거 열어줘.",
] as const)("test_search_proposes_a_result_and_remembers_it_without_listing", async reply => {
  const { session, page } = await open();
  expect((await session.handleTurn(search)).speech).toContain(first);
  await session.handleTurn(reply, { fromVoice: true });
  const url = new URL(page.url());
  expect(url.pathname).toBe("/external2.html");
  expect([...url.searchParams]).toEqual([["q", first]]);
});

it.each([
  "네, 화면에 있는 첫 번째 링크가 맞아요?",
  "네, 화면에 있는 첫 번째 링크가 맞아요?!.",
  "네, 화면에 있는 첫 번째 링크가 맞나요",
  "네, 화면에 있는 첫 번째 링크가 맞나요? 그거 열어줘.",
  "네, 두 번째 링크가 맞아요",
  "네, 첫 번째나 두 번째 링크가 맞아요",
  "아니요, 첫 번째 링크가 맞지 않아요",
  "아니요, 첫 번째 링크가 맞지 않아요. 그거 열어줘.",
  "네, 첫 번째 링크가 맞아요. 열지 마세요.",
  "네, 첫 번째 링크가 맞아요. 날씨 링크도 열어줘.",
  "첫 번째가 맞아요. 지원금도 열어줘.",
  "첫 번째 링크가 맞아요라고 말한 적이 있어요.",
] as const)("test_search_confirmation_requires_one_matching_affirmative", async reply => {
  const { session, page } = await open();
  await session.handleTurn(search);
  const before = page.url();
  session.deps.llm = new FakeLlm({ link_choice: { index: 1 } });
  expect((await session.handleTurn(reply, { fromVoice: true })).actions).toEqual([]);
  expect(page.url()).toBe(before);
});

it.each([
  "링크 목록 알려줘",
  "청음 소개해줘",
] as const)("test_ordinal_confirmation_requires_a_live_proposal", async between => {
  const { session, page } = await open();
  await session.handleTurn(search);
  await session.handleTurn(between);
  const before = page.url();
  expect((await session.handleTurn("네, 첫 번째 결과가 맞아요", { fromVoice: true })).actions).toEqual([]);
  expect(page.url()).toBe(before);
});

it.each([
  "첫 번째",
  "두 번째",
] as const)("test_ordinal_confirmation_cannot_accept_a_replaced_proposal", async ordinal => {
  const { session, page } = await open();
  await session.handleTurn(search);
  const firstOffer = session.linkOfferId;
  expect((await session.handleTurn("2번?")).speech).toContain("하이코리아 홈페이지 지원 대상");
  const before = page.url();
  const result = await session.handleTurn("네, " + ordinal + " 링크가 맞아요", { fromVoice: true, linkOfferId: firstOffer });
  expect(page.url()).toBe(before);
  expect(result.actions).toEqual([]);
  expect(result.speech).toContain("선택지가 바뀌었어요");
});

it("test_ordinal_confirmation_cannot_click_a_changed_target", async () => {
  const { session, page } = await open();
  await session.handleTurn(search);
  const before = page.url();
  await page.getByRole("link", { name: first }).evaluate(el => el.setAttribute("href", "/external2.html?n=changed"));
  const result = await session.handleTurn("네, 화면에 있는 첫 번째 링크가 맞아요", { fromVoice: true });
  expect(page.url()).toBe(before);
  expect(result.actions).toEqual([]);
  expect(result.speech).toContain("바뀌");
});

it("test_changed_link_destination_requires_a_new_choice", async () => {
  const { session, page } = await listed();
  const before = page.url();
  await page.getByRole("link", { name: "뉴스" }).evaluate(el => el.setAttribute("href", "/external2.html?n=changed"));
  const result = await session.handleTurn("1번 눌러줘");
  expect(page.url()).toBe(before);
  expect(result.actions).toEqual([]);
  expect(result.speech).toContain("바뀌");
});

it("test_foreign_affirmative_uses_the_pending_link_before_public_planning", async () => {
  const { session, page } = await open();
  await session.handleTurn(search);
  const model = new FakeLlm();
  session.deps.llm = model;
  session.lang = "en";
  await session.handleTurn("yes", { fromVoice: true });
  expect(page.url()).toContain("/external2.html?");
  expect(model.calls.some(call => call.schemaName === "translate_in")).toBe(false);
});

it("test_information_request_rejects_a_model_generated_click", async () => {
  const { session, page } = await listed(), before = page.url();
  session.deps.llm = new FakeLlm({ intent_plan: { steps: [flat("FOLLOW_LINK", { topic: "뉴스" })] },
    chat_route: { route: "web_task", reply: "" } });
  expect((await session.handleTurn("첫 항목은 누가 운영하나요?")).actions).toEqual([]);
  expect(page.url()).toBe(before);
});

it("test_result_selection_never_uses_header_links", async () => {
  const { session, page } = await open();
  await page.route("**/external.html?q=*", route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: '<nav><a href="/external2.html">처음 화면</a></nav><main><h1>검색 결과가 없습니다</h1></main>' }));
  await session.handleTurn(search);
  const before = page.url();
  expect((await session.handleTurn("화면에 있는 첫 링크 눌러줘")).actions).toEqual([]);
  expect(page.url()).toBe(before);
});

it("test_search_result_numbers_are_consistent_after_reading_the_list", async () => {
  const { session, page } = await open();
  await session.handleTurn(search);
  expect((await session.handleTurn(list)).speech).toContain("1번 " + first);
  await session.handleTurn("2번");
  expect([...new URL(page.url()).searchParams]).toEqual([["q", "하이코리아 홈페이지 지원 대상"]]);
});

it("test_reply_already_queued_cannot_accept_a_new_search_proposal", async () => {
  const { session, page } = await open();
  const [opened, answer] = await Promise.all([session.handleTurn(search), session.handleTurn("네")]);
  expect(page.url()).toBe(opened.observation?.url);
  expect(answer.actions).toEqual([]);
});

it("test_questioning_or_leaving_a_proposal_cannot_open_it", async () => {
  const { session, page } = await open();
  await session.handleTurn(search);
  const before = page.url();
  expect((await session.handleTurn("네?")).actions).toEqual([]);
  expect(page.url()).toBe(before);
  await session.handleTurn("청음 소개해줘");
  expect((await session.handleTurn("그거 열어줘")).actions).toEqual([]);
  expect(page.url()).toBe(before);
});

it.each([
  [3,"weather"],
  [900,null],
  [null,null],
] as const)("test_flexible_reference_uses_only_an_observed_candidate", async (index, section) => {
  const { session, page } = await listed(), before = page.url();
  const model = new FakeLlm({ link_choice: { index } });
  session.deps.llm = model;
  const result = await session.handleTurn("그 링크들 중에 일기 예보를 볼 수 있는 걸 열어줘");
  const calls = model.calls.filter(call => call.schemaName === "link_choice");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.user).toContain("날씨");
  expect(calls[0]?.user).not.toContain("사용자의 주소");
  if (section !== null) expect([...new URL(page.url()).searchParams]).toEqual([["section", section]]);
  else {
    expect(page.url()).toBe(before);
    expect(result.actions).toEqual([]);
  }
});

it("test_voice_opens_the_named_search_heading_without_reading_the_page", async () => {
  const { session, page } = await open();
  await page.route("**/external.html?q=*", route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: '<title>검색 결과</title><header><a href="/">전체</a></header><main id="search"><div id="rso">'
      + '<a href="/external2.html?section=immigration"><h3>하이코리아 홈페이지</h3></a>'
      + '<a href="/external2.html?section=help"><h3>출입국 이용 안내</h3></a></div></main>' }));
  expect((await session.handleTurn(search, { fromVoice: true })).speech).toContain("하이코리아 홈페이지");
  expect(new URL(page.url()).pathname).toBe("/external.html");
  const opened = await session.handleTurn("네, 그 링크 맞아. 화면에 있는 첫 링크가 맞아. 그거 열어줘.", { fromVoice: true });
  expect(opened.intentType).toBe("FOLLOW_LINK");
  expect([...new URL(page.url()).searchParams]).toEqual([["section", "immigration"]]);
});
