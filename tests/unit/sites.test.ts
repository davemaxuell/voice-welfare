import { expect, it } from "vitest";
import { flatToIntent } from "../../src/understanding/llm_planner.ts";
import { uniquePortalHome } from "../../src/agents/web/portal_home.ts";
import {
  goalSiteRequest, isSiteName, KNOWN_SITES, namedSiteCommand, nearSiteGuess, publicServiceSite, resolveSite, serviceTopic,
} from "../../src/understanding/sites.ts";

function listed(label: string) {
  const site = KNOWN_SITES.find(entry => entry.label === label);
  if (site === undefined) throw new Error("missing site: " + label);
  return site;
}

it("모델이 이름에서 만들어 낸 주소는 열지 않고 원래 요청으로 목적지를 찾는다", () => {
  const text = "푸른마당 누리집 열어줘";
  const guess = "https://guessed.go.kr/";
  expect(flatToIntent({ type: "OPEN_SITE", site: guess }, text)).toEqual({ type: "OPEN_SITE", target: text });
  const related = "하이코리아연구소 열어줘";
  expect(flatToIntent({ type: "OPEN_SITE", site: "하이코리아" }, related)).toEqual({ type: "OPEN_SITE", target: related });
  expect(flatToIntent({ type: "OPEN_SITE", site: guess }, guess + " 열어줘")).toEqual({ type: "OPEN_SITE", target: guess });
  const path = guess + "agency/main.do 열어줘";
  expect(flatToIntent({ type: "OPEN_SITE", site: guess }, path)).toEqual({ type: "OPEN_SITE", target: path });
});

it("긴 기관명 일부가 알려진 이름과 겹쳐도 다른 기관으로 보내지 않는다", () => {
  expect(resolveSite("하이코리아연구소 누리집 열어줘")).toBeUndefined();
  expect(resolveSite("정부24동우회 누리집 열어줘")).toBeUndefined();
});

it("등록되지 않은 누리집도 명시된 열기와 검색을 구분하고 다른 사이트 안에서의 요청은 계획에 남긴다", () => {
  const open = "새봄자료원 공식 누리집으로 가 줘";
  expect(namedSiteCommand(open)).toEqual({type: "OPEN_SITE", target: open});
  expect(namedSiteCommand("새봄자료원 홈페이지를 검색해 줘")).toEqual({type: "SEARCH", query: "새봄자료원 홈페이지"});
  expect(namedSiteCommand("네이버에서 새봄자료원 홈페이지를 검색해 줘")).toBeUndefined();
  expect(namedSiteCommand("문서를 읽고 새봄자료원 누리집을 열어 줘")).toBeUndefined();
  expect(namedSiteCommand("이 홈페이지를 열어 줘")).toBeUndefined();
});

it("기관명이 같아도 기사, 중계 주소, 비공식 호스트, 자격 증명, 기본 포트 이외의 주소는 직접 열지 않는다", () => {
  const title = "별빛도서관", homepage = "https://library.go.kr/ko/main.do";
  const candidates = ["/news/43", "/redirect?to=home", "/#go"].map(path => ({title, url: "https://library.go.kr" + path}));
  for (const url of ["https://account@library.go.kr/", "http://library.go.kr/", "https://library.go.kr:8443/", "https://library.go.kr.example/"]) candidates.push({title, url});
  candidates.push({title: "새 소식 | 별빛도서관", url: "https://library.go.kr/"});
  expect(uniquePortalHome(title, candidates)).toBeUndefined();
  expect(uniquePortalHome(title, [...candidates, {title: "홈 < 별빛도서관", url: homepage}])).toBe(homepage);
});

it.each([
  ["복지로에서 기초연금 신청 방법 찾아줘", "https://www.bokjiro.go.kr"],
  ["기초연금에 대해 복지로 누리집에서 찾아줘", "https://www.bokjiro.go.kr"],
  ["네이버 뉴스에서 오늘 뉴스 알려줘", "https://news.naver.com"],
  ["127.0.0.1:5174/external.html에서 찾아줘", "http://127.0.0.1:5174/external.html"],
  ["https://example.org/bokjiro.go.kr에서 찾아줘", "https://example.org/bokjiro.go.kr"],
  ["지금 화면에서 기초연금 찾아줘", undefined],
  ["복지로에서 찾아보고 정부24에서 확인해줘", undefined],
])("test_goal_evidence_source_is_the_requested_site", (goal, url) => {
  expect(goalSiteRequest(goal)[0]).toBe(url);
});

// 기대값은 77aad3e의 Python understanding/sites.py로 계산했다.
it("한 사이트에서 찾을 요청을 주소와 남은 질문으로 나눈다", () => {
  for (const [goal, request] of [
    ["복지로에서 기초연금 신청 방법 찾아줘", ["https://www.bokjiro.go.kr", "기초연금 신청 방법 찾아줘"]],
    ["기초연금에 대해 복지로 누리집에서 찾아줘", ["https://www.bokjiro.go.kr", "찾아줘"]],
    ["네이버 뉴스에서 오늘 뉴스 알려줘", ["https://news.naver.com", "오늘 뉴스 알려줘"]],
    ["127.0.0.1:5174/external.html에서 찾아줘", ["http://127.0.0.1:5174/external.html", "찾아줘"]],
    ["지금 화면에서 기초연금 찾아줘", [undefined, "지금 화면에서 기초연금 찾아줘"]],
    ["주민등록등본 발급 서류 알려줘", ["https://www.gov.kr", "주민등록등본 발급 서류 알려줘"]],
    ["복지루에서 찾아줘", ["https://www.bokjiro.go.kr", "찾아줘"]],
    ["gov.kr 들어가서 등본", ["https://gov.kr", "등본"]],
    ["정부24 사이트에서 등본", ["https://www.gov.kr", "등본"]],
    ["에서 시작", [undefined, "에서 시작"]],
  ] as const) expect(goalSiteRequest(goal), goal).toEqual(request);
});

it("기관 이름이 없어도 대표 업무로 담당 누리집을 고른다", () => {
  for (const [text, label] of [
    ["주민등록등본 떼고 싶어", "정부24"], ["정부24 열어줘", "정부24"], ["복지로에서 등본", undefined], ["민원 사이트 열어줘", "정부24"],
    ["민원", "정부24"], ["민원신청", "정부24"], ["gov.kr에서 등본", undefined], ["국가장학금 신청", "한국장학재단"],
    ["장학금하고 연말정산", undefined], ["네이버에서 날씨", undefined], ["정부24에서 국민신문고", undefined], ["고용24 실업급여", "고용24"], ["", undefined],
  ] as const) expect(publicServiceSite(text)?.label, text).toBe(label);
  for (const [text, topic] of [
    ["국가장학금 2유형 신청", "국가장학금2유형"], ["다자녀 국가장학금", "다자녀국가장학금"], ["국가장학금 Ⅰ유형", "국가장학금1유형"],
    ["국가 장학금 ii유형", "국가장학금2유형"], ["학자금 대출", "학자금대출"], ["장학금", "장학금"], ["", ""],
  ] as const) expect(serviceTopic(listed("한국장학재단"), text), text).toBe(topic);
  for (const [text, topic] of [["주민등록 등본 발급", "주민등록등본"], ["전입 신고", "전입신고"], ["날씨", ""]] as const) {
    expect(serviceTopic(listed("정부24"), text), text).toBe(topic);
  }
});

it("사이트 이름만 말했는지와 한 글자 다른 이름을 가린다", () => {
  for (const [text, bare] of [
    ["복지로", true], ["복지로요", true], ["정부24 사이트요.", true], ["민원", true], ["민원 누리집", true], ["네이버 뉴스!", true],
    ["복지로 열어줘", false], ["naver", true], ["NAVER?", true], ["", false],
  ] as const) expect(isSiteName(text), text).toBe(bare);
  for (const [text, guess] of [
    ["복지루에서 찾아줘", ["복지로", "복지루"]], ["복지관에 가서", ["복지로", "복지관"]], ["네이보 열어줘", ["네이버", "네이보"]],
    ["복지로에서 찾아줘", undefined], ["복지부로 가줘", undefined], ["신문사 접속", ["국민신문고", "신문사"]], ["정부이십사 켜", undefined],
    ["그냥 복지관 얘기", undefined], ["", undefined], ["복 지루에서", undefined],
  ] as const) {
    const found = nearSiteGuess(text);
    expect(found === undefined ? undefined : [found[0].label, found[1]], text).toEqual(guess);
  }
});

it("말한 전체 주소는 그 화면을 열고 이름은 호스트로만 정한다", () => {
  for (const [target, site] of [
    ["https://www.bokjiro.go.kr.evil.example/x 열어줘", { url: "https://www.bokjiro.go.kr.evil.example/x", label: "bokjiro.go.kr.evil.example" }],
    ["http://127.0.0.1:5174/home 열어줘", { url: "http://127.0.0.1:5174/home", label: "127.0.0.1" }],
    ["주민등록등본 떼는 곳", { url: "https://www.gov.kr", label: "정부24" }],
    ["Https://WWW.GOV.KR", { url: "Https://WWW.GOV.KR", label: "정부24" }],
    ["복지루 열어줘", { url: "https://www.bokjiro.go.kr", label: "복지로" }],
    ["naver 닷 컴", { url: "https://www.naver.com", label: "네이버" }],
  ] as const) expect(resolveSite(target), target).toEqual(site);
});
