import { expect, it } from "vitest";
import { z } from "zod";
import type { LlmRequest } from "../../src/core/llm.ts";
import type { PortalCandidate } from "../../src/agents/web/autopilot.ts";
import { isOfficialPortal } from "../../src/core/sites.ts";
import { tryUrl } from "../../src/core/url.ts";
import { PUBLIC_DOMAINS, TavilySearch } from "../../src/server/public_search.ts";
import { context, page, pilot } from "./fake-browser.ts";

const HIKOREA = "https://www.hikorea.go.kr/";
const LOGIN = page("https://www.hikorea.go.kr/login", "로그인", {
  fields: [{ fieldId: "pw", type: "password", visible: true, label: "비밀번호", required: true, value: "", filled: false, invalid: false, sensitive: true }],
});
const matches = (request: LlmRequest) => z.object({ portalMatches: z.array(z.object({ host: z.string(), name: z.string() })).optional() }).parse(JSON.parse(request.user)).portalMatches;

const MIXED: readonly PortalCandidate[] = [
  { url: "https://www.hikorea.go.kr/Main.pt", title: "하이코리아" },
  { url: "http://insecure.go.kr/", title: "http" },
  { url: "https://blog.example.com/visa", title: "블로그" },
  { url: "https://user@account.go.kr/", title: "계정" },
  { url: "https://port.go.kr:8443/", title: "포트" },
  { url: "https://www.hikorea.go.kr/other", title: "같은 누리집" },
];

it("find_portal은 걸러 낸 공공 누리집만 후보로 두고 그 host를 open_url로 연다", async () => {
  const discoveryQuery = "site:go.kr 체류기간 연장";
  const requestsToProvider: string[] = [];
  const { auto, requests, opened, executed } = pilot({ [HIKOREA]: page(HIKOREA, "하이코리아") }, [
    { action: "find_portal", target: discoveryQuery },
    { action: "open_url", target: "www.hikorea.go.kr" },
    { action: "ask_user", target: "user_choice", answer: "지금 어떤 비자로 체류하고 계세요?" },
  ], { discoverPortal: async query => { requestsToProvider.push(query); return MIXED; } });
  const result = await auto.run("비자 연장 절차 알려줘", context());
  expect(result.status).toBe("asked");
  expect(matches(requests[1]!)).toEqual([{ host: "www.hikorea.go.kr", name: "하이코리아" }]);
  expect(result.steps.map(s => [s.action, s.ok])).toEqual([["find_portal", true], ["open_url", true]]);
  expect(opened).toEqual([HIKOREA]);
  expect(requestsToProvider).toEqual([discoveryQuery]);
  expect(JSON.stringify([result.steps, result.speech, result.actions])).not.toContain("site:");
  expect(executed).not.toContain("fill");
});

it("찾지 않은 host는 열지 않고 주소를 추측하지 않는다", async () => {
  const { auto, opened } = pilot({}, [
    { action: "open_url", target: "www.hikorea.go.kr" },
    { action: "ask_user", answer: "어느 사이트인가요?" },
  ], { discoverPortal: async () => MIXED });
  const result = await auto.run("비자 연장 절차 알려줘", context());
  expect(result.steps[0]).toMatchObject({ action: "open_url", ok: false });
  expect(opened).toEqual([]);
});

it("후보가 없거나 검색이 실패해도 다음 행동으로 이어진다", async () => {
  for (const discover of [async () => [], async (): Promise<PortalCandidate[]> => { throw new Error("네트워크"); }]) {
    const { auto, requests } = pilot({}, [{ action: "find_portal", target: "비자" }, { action: "ask_user", target: "user_choice", answer: "지금 어떤 비자로 체류하고 계세요?" }], { discoverPortal: discover });
    const result = await auto.run("비자 연장", context());
    expect(result.steps[0]).toMatchObject({ action: "find_portal", ok: false });
    expect(matches(requests[1]!)).toBeUndefined();
    expect(result.status).toBe("asked");
  }
});

it("후보를 찾는 길이 주어지지 않으면 find_portal은 실패로 기록하고 안내 글도 보내지 않는다", async () => {
  const { auto, requests } = pilot({}, [{ action: "find_portal", target: "비자" }, { action: "ask_user", answer: "더 알려 주세요." }]);
  const result = await auto.run("비자 연장", context());
  expect(result.steps[0]).toMatchObject({ action: "find_portal", ok: false });
  expect(requests[0]?.system).not.toContain("find_portal로");
});

it("공식 누리집을 열고 로그인 화면이 나오면 입력하지 않고 멈춘다", async () => {
  const { auto, executed, opened } = pilot({ [HIKOREA]: LOGIN }, [
    { action: "find_portal", target: "내 체류 신청 현황" },
    { action: "open_url", target: "https://www.hikorea.go.kr/" },
    { action: "fail", answer: "로그인해야 볼 수 있어요." },
  ], { discoverPortal: async () => MIXED });
  const result = await auto.run("내 비자 연장 신청 현황 보여줘", context());
  expect(result.status).toBe("failed");
  expect(result.speech).toBe("사이트에서 직접 확인이 필요해요.");
  expect(opened).toEqual([HIKOREA]);
  expect(executed.filter(type => type !== "navigate")).toEqual([]);
});

it("멈추라는 요청이 오면 후보 검색을 기다리지 않고 멈춘다", async () => {
  const controller = new AbortController();
  const { auto, opened } = pilot({}, [{ action: "find_portal", target: "비자" }], {
    discoverPortal: () => new Promise(() => { controller.abort(); }),
  });
  expect((await auto.run("비자", context(controller.signal))).status).toBe("stopped");
  expect(opened).toEqual([]);
});

it("공공 누리집 판정은 https·기본 포트·계정 정보 없음·공공 도메인만 통과시킨다", () => {
  const ok = (raw: string) => isOfficialPortal(tryUrl(raw)!);
  expect(ok("https://www.hikorea.go.kr/")).toBe(true);
  expect(ok("https://www.nhis.or.kr/")).toBe(true);
  expect(ok("http://www.hikorea.go.kr/")).toBe(false);
  expect(ok("https://www.hikorea.go.kr:8443/")).toBe(false);
  expect(ok("https://admin@www.hikorea.go.kr/")).toBe(false);
  expect(ok("https://hikorea.go.kr.example.com/")).toBe(false);
  expect(ok("https://www.example.or.kr/")).toBe(false);
});

it("공공 도메인의 첫 화면과 기사 주소를 그대로 돌려주고 개인 정보 검색어는 보내지 않는다", async () => {
  const payloads: unknown[] = [];
  const results = [
    { url: "https://www.hikorea.go.kr/Main.pt", title: "하이코리아", content: "체류기간 연장 안내" },
    { url: "https://www.hikorea.go.kr/b", title: "같은 곳", content: "다른 글" },
    { url: "https://evil.example.com/", title: "블로그", content: "광고" },
    { url: "http://www.moj.go.kr/", title: "법무부", content: "http 주소" },
    { url: "https://www.immigration.go.kr/", title: "출입국", content: "출입국 안내" },
    { url: "https://www.hikorea.go.kr/Main.pt", title: "같은 주소", content: "홈" },
  ];
  const postJson = async (_url: string, _headers: Record<string, string>, body: unknown) => { payloads.push(body); return { results }; };
  const search = new TavilySearch("test", undefined, undefined, { postJson });
  const found = await search.portals("체류기간 연장 신청", new AbortController().signal);
  expect(found).toEqual([
    { url: "https://www.hikorea.go.kr/Main.pt", title: "하이코리아" },
    { url: "https://www.hikorea.go.kr/b", title: "같은 곳" },
    { url: "https://www.immigration.go.kr/", title: "출입국" },
  ]);
  expect(payloads).toMatchObject([{ query: "체류기간 연장 신청", include_domains: PUBLIC_DOMAINS }]);

  payloads.length = 0;
  expect(await search.portals("주민번호 900101-1234567 연장", new AbortController().signal)).toEqual([]);
  expect(payloads).toEqual([]);
});
