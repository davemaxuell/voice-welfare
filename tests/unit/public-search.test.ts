import { expect, it } from "vitest";
import { z } from "zod";
import type { LlmRequest } from "../../src/core/llm.ts";
import { PublicTask } from "../../src/orchestrator/public_task.ts";
import { AGENCY_DOMAINS, PUBLIC_DOMAINS, TavilySearch } from "../../src/server/public_search.ts";
import { splitUrl, urlPort } from "../../src/server/workflows.ts";

const QUESTION = new PublicTask({ goal: "대한민국 어린이날 날짜", facts: ["dates"] });
const PAGE = { url: "https://www.korea.kr/news/holiday", title: "공휴일 안내", content: "어린이날은 5월 5일입니다." };
const signal = () => new AbortController().signal;

function searchFake(replies: unknown[]) {
  const payloads: unknown[] = [];
  const postJson = async (_url: string, _headers: Record<string, string>, body: unknown) => {
    payloads.push(body);
    return replies.shift();
  };
  return { payloads, postJson };
}
function modelFake(replies: unknown[]) {
  const calls: LlmRequest[] = [];
  return { calls, llm: { name: "fake", generate: async (request: LlmRequest) => { calls.push(request); return replies.shift(); } } };
}
const queryOf = (body: unknown) => typeof body === "object" && body !== null && "query" in body ? body.query : undefined;

it("fetches the vetted notice when document search excerpts lack the requirements", async () => {
  const official = { ...PAGE, content: "사업을 안내합니다." };
  const quote = "신청서와 주민등록등본이 필요합니다.";
  const fetch = searchFake([
    { results: [official, { ...official, url: PAGE.url + "?session=test" }, { ...official, url: "https://agency.example/" }] },
    { results: [{ url: "https://another.go.kr/notice", raw_content: "잘못된 기관" }, { url: PAGE.url, raw_content: quote }] },
  ]);
  const model = { name: "document reader", generate: async (request: LlmRequest) => {
    const {excerpts} = z.object({excerpts: z.array(z.object({text: z.string()}))}).parse(JSON.parse(request.user));
    const index = excerpts.findIndex(page => page.text === quote);
    return index < 0 ? { answer: "", citations: [], retryQuery: null } : { answer: quote, citations: [{index, quote}] };
  }};
  const result = await new TavilySearch("test", model, undefined, { postJson: fetch.postJson })
    .search(new PublicTask({ goal: "신청 서류", facts: ["documents"] }), "ko", signal());
  expect(fetch.payloads[1]).toMatchObject({ urls: [PAGE.url] });
  expect(result).toMatchObject({ speech: quote, reviewQuoteSources: { [quote]: [PAGE.url] } });
});

it("test_refines_empty_results_and_cites_the_matching_official_excerpt", async () => {
  const fetch = searchFake([{ results: [] }, { results: [{ ...PAGE, url: "https://korea.kr.example.org/holiday" }, PAGE] }]);
  const model = modelFake([
    { answer: "", citations: [], retryQuery: "대한민국 공휴일 어린이날 공식 달력" },
    { answer: "Children’s Day is May 5.", citations: [{ index: 0, quote: PAGE.content }], retryQuery: null },
  ]);
  const result = await new TavilySearch("test", model.llm, undefined, { postJson: fetch.postJson }).search(QUESTION, "en", signal());
  expect(fetch.payloads.map(queryOf)).toEqual([QUESTION.goal, "대한민국 공휴일 어린이날 공식 달력"]);
  expect(result?.speech).toBe("Children’s Day is May 5.");
  expect(result?.sources.map(source => source.url)).toEqual([PAGE.url]);
  expect(JSON.parse(model.calls[1]?.user ?? "{}")).toMatchObject({ attempt: 2, searchQuery: "대한민국 공휴일 어린이날 공식 달력", excerpts: [{ title: "공휴일 안내", text: PAGE.content }] });
});

it.each(["어린이날은 6월 20일입니다.", PAGE.content])("test_unverified_citation_or_date_returns_no_answer", async quote => {
  const fetch = searchFake([{ results: [PAGE] }, { results: [PAGE] }]);
  const model = modelFake([{ answer: "June 20.", citations: [{ index: 0, quote }], retryQuery: null }]);
  expect(await new TavilySearch("test", model.llm, undefined, { postJson: fetch.postJson }).search(QUESTION, "en", signal())).toBeUndefined();
});

it("keeps an agency referral while looking up the receiving office's procedure", async () => {
  const referral = { url: "https://city.go.kr/reuse", title: "수리 지원", content: "수리 접수는 자원순환센터에서 담당합니다." };
  const procedure = { url: "https://reuse.go.kr/repair", title: "방문 수리", content: "방문 전에 예약표를 받아 주세요." };
  const fetch = searchFake([{ results: [referral] }, { results: [procedure] }]);
  const model = modelFake([{ answer: "", citations: [], retryQuery: "자원순환센터 방문 수리 절차" }, {
    answer: referral.content + " " + procedure.content, citations: [{ index: 0, quote: referral.content }, { index: 1, quote: procedure.content }],
  }]);
  const result = await new TavilySearch("test", model.llm, undefined, { postJson: fetch.postJson })
    .search(new PublicTask({ goal: "고장 난 물건을 어디로 가져가고 무엇을 먼저 해야 하나요?", facts: ["procedure"] }), "ko", signal());
  expect(result?.sources.map(source => source.url)).toEqual([referral.url, procedure.url]);
  expect(result?.reviewQuoteSources).toEqual({ [referral.content]: [referral.url], [procedure.content]: [procedure.url] });
});

it("stops a cycle of follow-up searches without claiming an answer", async () => {
  const fetch = searchFake([{ results: [] }, { results: [] }]);
  const model = modelFake([{ retryQuery: "다른 공식 자료" }, { retryQuery: QUESTION.goal }]);
  const result = await new TavilySearch("test", model.llm, undefined, { postJson: fetch.postJson }).search(QUESTION, "ko", signal());
  expect(fetch.payloads.map(queryOf)).toEqual([QUESTION.goal, "다른 공식 자료"]);
  expect(result).toBeUndefined();
});

it("test_private_query_never_reaches_search_provider", async () => {
  const fetch = searchFake([]);
  const task = new PublicTask({ goal: "Search for tvly-" + "private-test-token" });
  expect(await new TavilySearch("test", modelFake([]).llm, undefined, { postJson: fetch.postJson }).search(task, "en", signal())).toBeUndefined();
  expect(fetch.payloads).toEqual([]);
});

it("test_next_date_can_restate_the_reference_date_and_cite_the_calendar_year", () => {
  const quote = "12월 25~27일(기독탄신일 및 토·일요일, 3일)";
  const calendar = { url: PAGE.url, title: "「2026년 월력요항」 발표", text: quote };
  const answer = "The next public holiday after November 20, 2026 is Christmas Day, December 25, 2026.";
  const response = { answer, citations: [{ index: 0, quote }, { index: 0, quote: calendar.title }] };
  const verified = TavilySearch.sourcedAnswer(response, [calendar], "2026-11-20", "2026년 11월 20일 기준 다음 공휴일");
  expect(verified?.speech).toBe(answer);
  expect(verified?.sources).toHaveLength(1);
  expect(verified?.reviewQuoteSources).toEqual({ [quote]: [PAGE.url], [calendar.title]: [PAGE.url] });
});

it("searches the agency's own domain or the official public domains", async () => {
  // Python AGENCY_DOMAINS와 PUBLIC_DOMAINS
  expect(PUBLIC_DOMAINS).toEqual(["go.kr", "gov.kr", "hira.or.kr", "kead.or.kr", "korea.kr", "letskorail.com", "nhis.or.kr", "nps.or.kr"]);
  expect([AGENCY_DOMAINS.get("정부24"), AGENCY_DOMAINS.get("기초연금"), AGENCY_DOMAINS.get("코레일")]).toEqual(["gov.kr", "basicpension.mohw.go.kr", "letskorail.com"]);
  const fetch = searchFake([{ results: [] }]);
  const model = modelFake([{ answer: "", citations: [], retryQuery: null }]);
  await new TavilySearch("key", model.llm, undefined, { postJson: fetch.postJson }).search(new PublicTask({ agency: "정부24", goal: "등본 발급 수수료" }), "ko", signal());
  expect(fetch.payloads).toEqual([{ query: "등본 발급 수수료", search_depth: "advanced", chunks_per_source: 3, max_results: 6,
    include_domains: ["gov.kr"], include_answer: false, include_raw_content: false }]);
  expect(model.calls).toHaveLength(1);
});

it("keeps only https excerpts on the allowed domains and hides their contacts", async () => {
  const bad = [{ url: "http://www.gov.kr/a", content: "x" }, { url: "https://user@www.gov.kr/a", content: "x" }, { url: "https://www.gov.kr:8443/a", content: "x" },
    { url: "https://www.gov.kr:abc/a", content: "x" }, { url: "https://evilgov.kr/a", content: "x" }, { url: "https://[::1/a", content: "x" },
    { url: "https://www.gov.kr/blank", content: "   " }, "not a row"];
  const good = [{ url: "https://www.gov.kr:443/ok", content: " 문의 010-1234-5678 ", title: 5 }, { url: "https://gov.kr/second", content: "본문", title: "메일 a@b.kr" }];
  const excerpts = async (rows: unknown[]) =>
    await new TavilySearch("key", undefined, undefined, { postJson: searchFake([{ results: rows }]).postJson }).excerpts("q", ["gov.kr"], signal());
  expect(await excerpts([...bad.slice(0, 4), ...good, ...bad.slice(4)])).toEqual([
    { url: "https://www.gov.kr:443/ok", title: "www.gov.kr", text: "문의 [비공개]" }, { url: "https://gov.kr/second", title: "메일 [비공개]", text: "본문" }]);
  expect(await excerpts([...bad.slice(0, 6), ...good])).toEqual([]);
  expect(await new TavilySearch("key", undefined, undefined, { postJson: searchFake([{ results: "x" }]).postJson }).excerpts("q", ["gov.kr"], signal())).toBeUndefined();
  expect(splitUrl("https://[FE80::1%Eth0]:443/").hostname).toBe("fe80::1%Eth0");
  expect(() => urlPort("70000")).toThrow(RangeError);
});
