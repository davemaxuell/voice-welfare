import { expect, it, vi } from "vitest";
import { BUNDLED } from "../../src/agents/welfare/open_data/datasets.ts";
import * as time from "../../src/core/time.ts";
import { FakeLlm, scripted, step } from "../helpers.ts";
import { flat } from "./browser-cases.ts";
import { pageFor, runtimeCases } from "./browser-runtime-cases.ts";

const service = runtimeCases();

it("test_directory_before_consent_disambiguates_and_preserves_short_speech", async () => {
  const app = await service({REQUIRE_CONSENT: "true", DATASETS_DIR: BUNDLED}), {session} = await app.session();
  await session.handleTurn("받을 수 있는 복지 찾아줘");
  const choices = await session.handleTurn("서울 강남구 개포동 주민센터 어디야?");
  expect(choices.intentType).toBe("FIND_PLACE");
  expect(choices.speech).toContain("개포1동"); expect(choices.speech).toContain("개포2동");
  expect(session.dialogue.profileQuestion).toBeUndefined();
  session.personal.saveSpeech({...session.personal.speech(), length: "short"});
  const found = await session.handleTurn("1번");
  expect(found.semanticAction).toBe("find-place"); expect(found.actions).toEqual([]);
  for (const text of ["선릉로 35", "전화번호가 없어요", "기준"]) expect(found.speech).toContain(text);
  expect(found.sources[0]?.url).toContain("15059715");
  session.deps.llm = new FakeLlm({intent_plan: {steps: [flat("FIND_PLACE", {topic: "서울 강남구 개포1동 주민센터"}), flat("POLICY_QUESTION", {topic: "기초연금은 몇 살부터야?"})]}});
  const multi = await session.handleTurn("우리 동네 주민센터 어디야? 그리고 기초연금은 몇 살부터야?");
  expect(multi.intentType).toBe("PLAN(FIND_PLACE>POLICY_QUESTION)"); expect(multi.speech).not.toContain("선릉로");
  expect(multi.sources.some(s => s.url.includes("15059715"))).toBe(false);
  session.deps.llm = undefined;
  await session.handleTurn("우리 동네 주민센터 어디야?"); await session.handleTurn("멈춰");
  expect((await session.handleTurn("서울 강남구 개포1동")).state).toBe("STOPPED"); expect(session.dialogue.placeAsk).toBeUndefined();
});

it("test_private_program_discovery_followups_use_its_own_record", async () => {
  const app = await service({DATASETS_DIR: BUNDLED}), {session} = await app.session();
  const date = vi.spyOn(time, "todayIso").mockReturnValue("2026-11-18");
  try {
    const welfare = session.deps.welfare, first = await welfare.discover({age: 15, income: "basic"});
    const program = /(\d+)번 민간 사업 [^,]*?꿈장학\(초중고등학생\)/u;
    let match = program.exec(first.speech);
    for (let i = 3; i < first.count && !match; i += 3) match = program.exec(welfare.moreMatches().speech);
    if (!match) throw new Error("The scholarship was missing from discovery results");
    const detail = await session.handleTurn(match[1] + "번 자세히");
    expect(detail.speech).toContain("민간 사업"); expect(detail.sources[0]?.url).toContain("15116392");
    expect(detail.answerCard).toMatchObject({dataKind: "private-program", fields: ["target"]});
    expect((await session.handleTurn("지금 신청할 수 있어?")).speech).toContain("확인하지 못했어요");
    const prep = await session.handleTurn("신청 도와줘");
    expect(prep.speech).toContain("제출서류"); expect(prep.sources[0]?.url).toContain("15116392"); expect(prep.actions).toEqual([]);
    const unknown = await session.handleTurn("없는연금 신청 도와줘"); expect(unknown.semanticAction).toBe("clarify"); expect(unknown.actions).toEqual([]);
  } finally {date.mockRestore();}
});

it("test_direct_links_cover_local_bokjiro_csv_related_sites_and_official_hints", async () => {
  const app = await service({DATASETS_DIR: BUNDLED, PRACTICE_MODE: "false"}), {session} = await app.session(), page = pageFor(session);
  const base = "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=";
  const localUrl = base + "WLF00006793&wlfareInfoReldBztpCd=02", childcareUrl = base + "WLF00000024&wlfareInfoReldBztpCd=01", quote = "신분증과 신청서를 준비합니다.";
  for (const [host, title, text] of [["www.bokjiro.go.kr", "복지로 상세", quote], ["www.mnuri.kr", "문화누리카드", "문화누리카드 공식 누리집입니다."], ["idolbom.go.kr", "아이돌봄 서비스", "아이돌봄 서비스 안내입니다."]]) {
    await page.route("https://" + host + "/**", r => r.fulfill({contentType: "text/html; charset=utf-8", body: "<title>" + title + "</title><main>" + text + "</main>"}));
  }
  const opened = await session.handleTurn("문화누리카드 열어줘");
  expect(opened.intentType).toBe("OPEN_SITE"); expect(opened.observation?.url).toContain("https://www.mnuri.kr");
  const site = await session.handleTurn("아이돌봄서비스 관련 사이트 열어줘");
  expect(site.intentType).toBe("OPEN_SITE"); expect(site.observation?.url).toContain("https://idolbom.go.kr/");
  const official = await session.handleTurn("아이돌봄서비스 공식 안내 열어줘");
  expect(official.intentType).toBe("OPEN_OFFICIAL"); expect(official.observation?.url).toBe(childcareUrl);
  const seen = scripted(session, [step("answer", null, quote, [quote])]);
  const local = await session.handleTurn("복지로에서 부산 해운대구 첫째아 출산지원금 서류 알려줘");
  expect(seen[0]?.page?.url).toBe(localUrl); expect(local.sources[0]?.url).toBe(localUrl);
  const csv = scripted(session, [step("answer", null, quote, [quote])]);
  const goal = await session.handleTurn("복지로에서 아이돌봄서비스 서류 알려줘");
  expect(csv[0]?.page?.url).toBe(childcareUrl); expect(csv[0]?.conversation).toMatchObject({officialLinks: {relatedSites: [{url: "https://idolbom.go.kr/"}]}});
  expect(goal.sources[0]?.url).toBe(childcareUrl);
});
