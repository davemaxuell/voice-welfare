import { expect, it, vi } from "vitest";
import { FakeLlm } from "../helpers.ts";
import { browserCases, flat } from "./browser-cases.ts";

const open = browserCases();

it.each([
  ["하이코리아 열어줘", "https://www.hikorea.go.kr/Main.pt"],
  ["하이 코리아 공식 홈페이지로 이동해 주세요", "https://www.hikorea.go.kr/Main.pt"],
  ["국민연금공단 누리집에 들어가 줘", "https://www.nps.or.kr/"],
  ["고용24 사이트 열어 주세요", "https://www.work24.go.kr/"],
])("인터넷 검색 서비스 없이 음성 요청 %s의 실제 첫 화면을 연다", async (words, url) => {
  const { session, page } = await open();
  await page.route("https://**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: "<main><h1>기관 첫 화면</h1></main>" }));
  const result = await session.handleTurn(words, { fromVoice: true });
  expect(result.intentType).toBe("OPEN_SITE");
  expect(page.url()).toBe(url);
  expect(result.actions.map(a => a.action.type)).toEqual(["navigate"]);
  expect(session.linkOfferId).toBe("");
});

it("주소록에 없는 기관은 이름이 맞는 공식 첫 화면 하나를 찾아 원래 경로로 연다", async () => {
  const { session, page } = await open();
  const url = "https://archive.go.kr/portal/main.do";
  await page.route("https://**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: "<main>국가기록마당</main>" }));
  session.deps.findPortal = vi.fn(async () => [
    { title: "국가기록마당", url: "https://archive.go.kr.example.org/" },
    { title: "국가기록마당 개관 소식", url: "https://news.go.kr/" },
    { title: "국가기록마당 공식 누리집", url },
  ]);
  const result = await session.handleTurn("국가기록마당에 접속해 주세요", { fromVoice: true });
  expect(page.url()).toBe(url);
  expect(result.actions.map(a => a.action.type)).toEqual(["navigate"]);
  expect(session.deps.findPortal).toHaveBeenCalledOnce();
  expect(vi.mocked(session.deps.findPortal).mock.calls[0]?.[0]).toContain("국가기록마당");
  await session.handleTurn("정부24 열어줘", { fromVoice: true });
  await session.handleTurn("국가 기록마당 누리집 열어줘", { fromVoice: true });
  expect(page.url()).toBe(url);
  expect(session.deps.findPortal).toHaveBeenCalledOnce();
});

it("검색 API가 없어도 검색 결과에 드러난 유일한 공식 첫 화면으로 이어 간다", async () => {
  const { session, page } = await open();
  const url = "https://culture.go.kr/portal/index.do";
  await page.route("**/external.html?q=*", route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: `<title>검색 결과</title><main id="main_pack">
      <a href="https://culture.example.org/">우리문화마당</a>
      <a href="http://notice.culture.go.kr/">우리문화마당 <span>새 창 열림</span></a>
      <a href="${url}">우리문화마당 대표 누리집 <span>새 창 열림</span></a></main>` }));
  await page.route(url, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: "<main>문화 행사 안내</main>" }));
  const answer = await session.handleTurn("우리문화마당 공식 사이트 열어줘", { fromVoice: true });
  expect(page.url()).toBe(url);
  expect(answer.actions.map(row => row.action.type)).toEqual(["navigate", "navigate"]);
  expect(answer.speech).toContain("열었어요");
  expect(session.linkOfferId).toBe("");
});

it("기관 이름을 검색해 달라는 음성 요청은 검색 결과에 머문다", async () => {
  const { session, page } = await open();
  const lookup = vi.fn(async () => []);
  session.deps.findPortal = lookup;
  const answer = await session.handleTurn("하이코리아 홈페이지 검색해 줘", { fromVoice: true });
  expect(answer.intentType).toBe("SEARCH");
  expect(new URL(page.url()).searchParams.get("q")).toBe("하이코리아 홈페이지");
  expect(lookup).not.toHaveBeenCalled();
});

it.each([
  ["하이코리아를 열어 주세요", "SEARCH", "OPEN_SITE", "https://www.hikorea.go.kr/Main.pt"],
  ["새봄자료원 누리집 열어 주세요", "SEARCH", "OPEN_SITE", "https://spring.go.kr/"],
  ["정부24 홈페이지 검색해 줘", "OPEN_SITE", "SEARCH", undefined],
] as const)("모델을 연결해도 명확한 기관 열기와 검색을 구별한다 (%s)", async (words, wrong, intended, url) => {
  const { session, page } = await open();
  await page.route("https://**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: "<main>공식 누리집</main>" }));
  session.deps.findPortal = async () => [{title: "새봄자료원", url: "https://spring.go.kr/"}];
  session.deps.llm = new FakeLlm({intent_plan: {steps: [flat(wrong, {site: "정부24", topic: "하이코리아 홈페이지"})]}});
  const answer = await session.handleTurn(words, { fromVoice: true });
  expect(answer.intentType).toBe(intended);
  if (url !== undefined) expect(page.url()).toBe(url);
  else expect(new URL(page.url()).searchParams.get("q")).toBe("정부24 홈페이지");
});

it("서로 다른 두 기관이 같은 이름을 쓰면 후보를 자동으로 열지 않는다", async () => {
  const { session, page } = await open();
  session.deps.findPortal = async () => [
    { title: "우리문화마당", url: "https://town-a.go.kr/" },
    { title: "우리문화마당", url: "https://town-b.go.kr/" },
  ];
  const answer = await session.handleTurn("우리문화마당 홈페이지 열어 주세요", { fromVoice: true });
  expect(new URL(page.url()).searchParams.get("q")).toBe("우리문화마당 홈페이지");
  expect(answer.speech).toContain("검색 결과");
  expect(session.linkOfferId).toBeTruthy();
});
