import { afterAll, afterEach, expect, it } from "vitest";
import type { TurnResult } from "../../src/core/turn.ts";
import { PORTAL } from "../helpers.ts";
import { createTestRuntime } from "./session-runtime.ts";
import { openSlice } from "./transcripts.ts";

const runtime = createTestRuntime();
afterEach(runtime.closeSessions);
afterAll(runtime.close);
async function openPortal() {
  const { session, page } = await runtime.createBrowserSession();
  const result = await session.handleTurn(PORTAL + " 열어줘");
  expect(result.semanticAction).toBe("open-site");
  return { session, page, result };
}
function opinionName(result: TurnResult) {
  return result.observation?.fields.find(f => f.fieldId === "opinionName")?.value ?? "";
}

it("test_open_external_read_only_summary", async () => {
  const { result } = await openPortal();
  expect(result.state).toBe("BROWSING");
  expect(result.accessMode).toBe("read-only");
  expect(result.speech).toContain("열었어요");
  expect(result.speech).toContain("로 시작해요");
  expect(result.speech).not.toMatch(/링크 \d+개|버튼 \d+개|화면 구성/u);
  expect([...result.speech].length).toBeLessThan(260);
});

it("test_read_main_in_chunks_ignoring_instructions", async () => {
  const { session } = await openPortal();
  const first = await session.handleTurn("본문 읽어줘");
  expect(first.semanticAction).toBe("read-main");
  expect(first.speech).toContain("계속 읽어줘");
  let last = first;
  for (let i = 0; i < 10 && !last.speech.includes("본문 끝"); i++) last = await session.handleTurn("계속 읽어줘");
  expect(last.speech).toContain("본문 끝");
  expect(first.actions).toEqual([]);
  expect(last.actions).toEqual([]);
  expect(last.observation?.title).not.toContain("의견이 전송됨");
});

it("test_links_by_number_and_back", async () => {
  const { session } = await openPortal();
  const list = await session.handleTurn("링크 목록 알려줘");
  expect(list.speech).toContain("누를 수 있는 항목 9개 중 1번째부터 읽습니다. 1번 뉴스, 2번 복지");
  expect(list.speech).not.toContain("보내기");
  expect((await session.handleTurn("링크 더 알려줘")).speech).toContain("더 읽을 링크가 없습니다");
  const opened = await session.handleTurn("장애인연금 안내 링크 눌러줘");
  expect(opened.semanticAction).toBe("follow-link");
  expect(opened.observation?.title).toContain("안내 기사");
  expect(opened.actions[0]?.policy.code).toBe("ALLOWED_READ_ONLY");
  const back = await session.handleTurn("뒤로 가줘");
  expect(back.semanticAction).toBe("back");
  expect(back.observation?.title).toContain("외부 포털");
});

it("test_site_that_fails_to_load_leaves_the_user_where_they_were", async () => {
  const { session } = await openPortal();
  const failed = await session.handleTurn("127.0.0.1:9 열어줘");
  expect(failed.speech).toContain("열지 못했");
  expect(failed.speech).not.toContain("모의 사이트");
  const read = await session.handleTurn("본문 읽어줘");
  expect(read.semanticAction).toBe("read-main");
  expect(read.observation?.title).toContain("외부 포털");
});

it("test_ambiguous_link_asks_then_number", async () => {
  const { session } = await openPortal();
  const ask = await session.handleTurn("안내 링크 눌러줘");
  expect(ask.actions).toEqual([]);
  expect(ask.speech).toContain("1번 장애인연금 안내, 2번 기초연금 안내");
  expect((await session.handleTurn("2번")).observation?.url).toContain("topic=basic");
});

it("test_duplicate_link_name_opens_first", async () => {
  const { session } = await openPortal();
  expect((await session.handleTurn("자세히 보기 눌러줘")).observation?.url).toContain("n=1");
});

it("test_follows_new_tab", async () => {
  const { session } = await openPortal();
  expect((await session.handleTurn("새 창으로 열기 링크 눌러줘")).observation?.url).toContain("new=1");
});

it("test_search_box_only", async () => {
  const { session } = await openPortal();
  const result = await session.handleTurn("장애인연금 검색해줘");
  expect(result.semanticAction).toBe("search");
  expect(result.observation?.title).toContain("'장애인연금' 검색 결과");
  expect(result.actions.map(a => [a.action.type, a.policy.code])).toEqual([["fill", "ALLOWED_READ_ONLY"], ["press", "ALLOWED_READ_ONLY"]]);
});

it("test_no_general_input_or_buttons_on_external", async () => {
  const { session } = await openPortal();
  expect((await session.handleTurn("이름은 김하늘")).actions).toEqual([]);
  const press = await session.handleTurn("보내기 버튼 눌러줘");
  expect(press.actions.filter(a => a.result?.ok === true)).toEqual([]);
  expect(press.observation?.title ?? "").not.toContain("의견이 전송됨");
});

it("test_apply_from_external_opens_mock_form", async () => {
  const { session } = await openPortal();
  const result = await session.handleTurn("장애인연금 신청 도와줘");
  expect(result.speech).toContain("실제 신청을 대신하지 않아요");
  expect(result.page).toBe("mock-welfare");
  expect(result.accessMode).toBe("full");
});

it("test_unknown_site_name_is_searched", async () => {
  const { session } = await runtime.createBrowserSession();
  const result = await session.handleTurn("우리동네복지관 사이트 열어줘");
  expect(result.speech).toContain("추측해서 열지 않고");
  expect(result.observation?.url).toContain("q=");
  expect(decodeURIComponent(result.observation?.url ?? "")).toContain("우리동네복지관");
});

it("test_consent_required_before_screen", async () => {
  const { session } = await runtime.createBrowserSession({ requireConsent: true });
  expect(session.state).toBe("AWAITING_CONSENT");
  const blocked = await session.handleTurn("장애인연금 신청 도와줘");
  expect(blocked.semanticAction).toBe("consent");
  expect(blocked.actions).toEqual([]);
  expect((await session.handleTurn("장애인연금 지원대상이 누구야?")).semanticAction).toBe("welfare-retrieval");
  const ok = await session.consentTo(true);
  expect(ok.state).toBe("IDLE");
  expect(ok.page).toBe("mock-home");
  expect((await session.handleTurn("장애인연금 신청 도와줘")).state).toBe("APPLICATION_OPEN");
});

it("test_declined_consent_keeps_blocking", async () => {
  const { session } = await runtime.createBrowserSession({ requireConsent: true });
  await session.consentTo(false);
  const result = await session.handleTurn(PORTAL + " 열어줘");
  expect(result.semanticAction).toBe("consent");
  expect(result.actions).toEqual([]);
});

it("test_assist_fill_after_yes", async () => {
  const { session } = await openPortal();
  const ask = await session.handleTurn("이름 칸에 김하늘 써줘");
  expect(ask.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(ask.speech).toContain('이름 칸에 "김하늘"');
  expect(ask.actions).toEqual([]);
  const done = await session.handleTurn("응");
  expect(done.speech).toContain("제출이나 신청 버튼은 직접 눌러 주세요");
  expect(opinionName(done)).toBe("김하늘");
  expect(done.actions[0]?.policy.code).toBe("APPROVED");
});

it("test_assist_no_means_no", async () => {
  const { session } = await openPortal();
  await session.handleTurn("이름 칸에 김하늘 써줘");
  const result = await session.handleTurn("아니");
  expect(result.semanticAction).toBe("reject");
  expect(opinionName(result)).toBe("");
});

it("test_assist_fill_dropped_when_the_field_changed", async () => {
  const { session, page } = await openPortal();
  await session.handleTurn("이름 칸에 김하늘 써줘");
  await page.fill("#opinionName", "홍길동");
  const result = await session.handleTurn("응");
  expect(result.speech).toMatch(/^이름 칸 값이 바뀌었어요\. 그래서 넣지 않았어요\./u);
  expect(opinionName(result)).toBe("홍길동");
  expect(result.actions).toEqual([]);
});

it("test_submit_button_left_to_user", async () => {
  const { session } = await openPortal();
  const result = await session.handleTurn("보내기 버튼 눌러줘");
  expect(result.speech).toContain("직접 눌러 주세요");
  expect(result.observation?.title ?? "").not.toContain("의견이 전송됨");
});

it("test_missing_field_not_found", async () => {
  const { session } = await openPortal();
  const result = await session.handleTurn("주민등록 주소 칸에 부산광역시 예시구 예시로 10 써줘");
  expect(result.speech).toContain("찾지 못했어요");
  expect(result.actions).toEqual([]);
});

it.runIf(openSlice.has("PR8d"))("test_guided_fill_with_vault", async () => {
  const { session } = await openPortal();
  const save = await session.handleTurn("내 이름은 김하늘이라고 저장해줘");
  expect(save.speech).toContain("이름 김하늘");
  await session.handleTurn("응");
  expect((await session.handleTurn("입력 칸 하나씩 채워줘")).speech).toContain("저장된 내 정보를 쓸까요");
  expect((await session.handleTurn("응")).speech).toContain("저장된 '김하늘'을 넣을까요");
  expect((await session.handleTurn("응")).state).toBe("WAITING_FOR_USER_CONFIRMATION");
  const done = await session.handleTurn("응");
  expect(opinionName(done)).toBe("김하늘");
  expect(done.speech).toContain("모두 지나왔어요");
  expect(done.actions.some(a => a.action.type === "click")).toBe(false);
});

it("test_guided_fill_with_spoken_value", async () => {
  const { session } = await openPortal();
  await session.handleTurn("입력 칸 하나씩 채워줘");
  expect((await session.handleTurn("홍길동")).state).toBe("WAITING_FOR_USER_CONFIRMATION");
  const filled = await session.handleTurn("응");
  expect(opinionName(filled)).toBe("홍길동");
});
