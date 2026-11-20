import { expect, it } from "vitest";
import { blockedSpeech, forUrl, guideSection, helpHumanSpeech, loadsBokjiroSearchResults, publicGuideUrl } from "../../src/agents/web/playbook.ts";

it("test_help_human_says_cant_speaks_129_then_alternatives", () => {
  const said = helpHumanSpeech();
  expect(said).toMatch(/전화|연결/u);
  expect(said).toMatch(/못|않/u);
  expect(said).toContain("129");
  expect(said.indexOf("129")).toBeLessThan(said.indexOf("대신"));
  expect(["찾아", "읽", "신청", "열어", "검색"].filter(word => said.includes(word)).length).toBeGreaterThanOrEqual(2);
  expect(said).toMatch(/다시 들려|다시 말씀/u);
});

it("test_help_human_prefers_service_contact_over_129", () => {
  const said = helpHumanSpeech({ contactName: "국민연금공단", contactNumber: "1355", serviceName: "기초연금" });
  expect(said).toContain("1355");
  expect(said.slice(0, said.indexOf("1355"))).not.toContain("129");
  expect(said).toContain("기초연금");
});

it("test_help_human_uses_gov24_playbook_number", () => {
  expect(helpHumanSpeech({ url: "https://www.gov.kr/mw/AA020InfoServiceList.do" })).toContain("1588-2188");
});

it("test_blocked_bokjiro_ends_with_next_step_and_notice_once", () => {
  const given = new Set<string>();
  const once = (key: string, text: string) => {
    if (given.has(key)) return "";
    given.add(key);
    return text;
  };
  const url = "https://www.bokjiro.go.kr/";
  const notice = forUrl(url)!.automationNotice;
  const first = blockedSpeech(url, once);
  const second = blockedSpeech(url, once);
  expect(first).toMatch(/막을|자동/u);
  expect(first).toContain("브라우저");
  expect(first).toMatch(/직접|찾아/u);
  expect(first).toContain(notice);
  expect(second).not.toContain(notice);
  expect(second).toMatch(/직접|찾아/u);
});

// 기대값은 pyref(77aad3e)의 cheongeum.agents.web.playbook을 같은 입력에 돌린 결과다.
it("기관의 업무별 안내 페이지를 Python과 같게 고른다", () => {
  const cases: Array<[string | undefined, string, string | undefined]> = [
    ["https://www.gov.kr/", "주민등록 등본 떼고 싶어", "https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=13100000015"],
    ["https://www.gov.kr/?a=1", "등본발급", undefined],
    ["https://www.kosaf.go.kr/", "국가장학금 2유형 신청 방법", "https://www.kosaf.go.kr/ko/scholar.do?pg=scholarship05_12_01_02&ttab1=2"],
    ["https://www.kosaf.go.kr/", "국가장학금 다자녀 서류", "https://www.kosaf.go.kr/ko/scholar.do?pg=scholarship05_12_10&ttab1=3"],
    ["https://www.kosaf.go.kr/", "국가장학금 일정", "https://www.kosaf.go.kr/ko/scholar.do?pg=scholarship_submain01&naviParam=JH,02,00,00"],
    ["https://www.kosaf.go.kr/x", "국가장학금", undefined],
    [undefined, "국가장학금", undefined],
    ["https://www.kosaf.go.kr/", "국가 장학금 Ⅱ유형 어떻게 신청", "https://www.kosaf.go.kr/ko/scholar.do?pg=scholarship05_12_01_02&ttab1=2"],
  ];
  for (const [site, question, expected] of cases) expect(publicGuideUrl(site, question), question).toBe(expected);
});

it("장학재단 절차 탭은 지원절차 제목부터 읽고 일정 질문은 그대로 둔다", () => {
  const view = { url: "https://www.kosaf.go.kr/ko/scholar.do?pg=x&ttab1=2", outline: { mainText: "일정 배너\n  2026 국가장학금 지원절차  \n1. 신청\n2. 서류" } };
  expect(guideSection(view, "국가장학금 신청 방법 알려줘").outline.mainText).toBe("2026 국가장학금 지원절차  \n1. 신청\n2. 서류");
  expect(guideSection(view, "신청 일정도 알려줘")).toBe(view);
  expect(["https://bokjiro.go.kr/ssis-tbu/TWZZ01000M/getHeaderInf.do?x=1", "https://www.bokjiro.go.kr/other", "x"].map(loadsBokjiroSearchResults))
    .toEqual([true, false, false]);
});
