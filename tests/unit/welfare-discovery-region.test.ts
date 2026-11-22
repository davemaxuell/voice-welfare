import { expect, it } from "vitest";
import { WelfareInformationAgent, speakAnswerCard, type GroundedAnswer } from '../../src/agents/welfare/agent.ts';
import { FakeLlm } from '../helpers.ts';
import { fixtureCatalog, FixtureWelfareDataProvider, type WelfareService, type ServiceSummary } from "../../src/agents/welfare/data/index.ts";
import {
  matchServices, nextProfileSlot, parseProfileAnswer, profileQuestion, residenceStatus, type UserProfile,
} from "../../src/agents/welfare/discovery.ts";

const GIJANG_TRANSPORT = "WLF00005911";
const SAID = "68세, 심한 장애, 차상위, 부산 사상구에 사는데 이동이 힘든데 받을 수 있는 복지 찾아줘";
const BUSAN_ONLY = { age: 68, disability: "severe", income: "near-poor", ctpv: "부산광역시" } as const satisfies UserProfile;

function local(ctpv: string, sgg: string): ServiceSummary {
  return { servId: "L", servNm: "지자체 사업", summary: "", lifeStages: [], targets: [], themes: [], provider: "local", detailUrl: "", region: { ctpv, sgg } };
}

it("test_profile_keeps_district_said_after_province", () => {
  const p = parseProfileAnswer(SAID);
  expect([p.ctpv, p.sgg]).toEqual(["부산광역시", "사상구"]);
  expect(parseProfileAnswer("부산 살고 1인 가구예요").sgg ?? null).toBeNull();
});

it("test_other_district_program_is_never_recommended", () => {
  const catalog = fixtureCatalog("부산광역시");
  const sasang = matchServices(catalog, parseProfileAnswer(SAID));
  expect(sasang.map(m => m.service.servId)).not.toContain(GIJANG_TRANSPORT);
  expect(sasang.every(m => ["사상구", "부산광역시교육청", undefined].includes(m.service.provider === "private" ? undefined : m.service.region?.sgg))).toBe(true);

  const gijang = matchServices(catalog, { ...BUSAN_ONLY, sgg: "기장군" });
  expect(gijang[0]?.service.servId).toBe(GIJANG_TRANSPORT);
  expect(gijang[0]?.reasons).toContain("기장군 지역");
});

it.each([
  ["사상구에 살아요", "부산광역시", "사상구"],
  ["기장군이요", "부산광역시", "기장군"],
  ["부산에 살고 중구예요", "부산광역시", "중구"],
  ["분당구 살아요", "경기도", "성남시"],
] as const)("test_bare_official_district_name_is_where_the_user_lives", (said, ctpv, area) => {
  const p = parseProfileAnswer(said);
  expect(p.ctpv).toBe(ctpv);
  // 그 시·군·구 사업은 사는 곳 사업으로, 이웃 구 사업은 다른 곳 사업으로 본다
  expect(residenceStatus(local(ctpv, area), p)).toBe("met");
  expect(residenceStatus(local(ctpv, "영도구"), p)).toBe("unmet");
});

it.each(["1인 가구예요", "혼자 사는 1인 가구고 도시에 살아요", "부산 살고 분당구예요", "광주시에 살아요"])(
  "test_word_that_is_not_an_official_district_of_the_province_is_not_a_district",
  said => {
    const p = parseProfileAnswer(said);
    expect(p.sgg ?? null).toBeNull();
    expect([undefined, null, "부산광역시"]).toContain(p.ctpv);
  },
);

it.each([["중구", "어느 시의 중구인가요?"], ["고성군", "어느 도의 고성군인가요?"]])(
  "test_shared_district_name_asks_which_province_once_it_is_time",
  (name, asked) => {
    const soFar: UserProfile = { age: 70, disability: "no", income: "near-poor", ...parseProfileAnswer(`${name} 살아요`) };
    const slot = nextProfileSlot(soFar);
    expect(slot === undefined ? undefined : profileQuestion(slot, soFar)).toBe(asked);
  },
);

it("test_answer_to_which_city_keeps_the_district_only_if_that_city_has_it", () => {
  const soFar: UserProfile = { age: 70, disability: "no", income: "near-poor", ...parseProfileAnswer("중구 살아요") };
  const busan = { ...soFar, ...parseProfileAnswer("부산이요", "ctpv", soFar) };
  expect(residenceStatus(local("부산광역시", "중구"), busan)).toBe("met");
  expect(residenceStatus(local("부산광역시", "영도구"), busan)).toBe("unmet");
  // 경기도에는 중구가 없다. 구를 버려서 경기도의 시·군 사업을 모두 빼지 않는다
  const gyeonggi = { ...soFar, ...parseProfileAnswer("경기도요", "ctpv", soFar) };
  expect(residenceStatus(local("경기도", "성남시"), gyeonggi)).toBe("unknown");
});

it("test_known_province_settles_a_shared_district_name", () => {
  const p = parseProfileAnswer("중구 살아요", "age", { ctpv: "부산광역시" });
  expect(residenceStatus(local("부산광역시", "중구"), { ctpv: "부산광역시", ...p })).toBe("met");
});

it("사는 곳을 모르면 시·군·구 사업은 확인할 수 없다고 하고, 시·도 전체 사업은 거주 조건이 없다", () => {
  expect(residenceStatus(local("부산광역시", "기장군"), BUSAN_ONLY)).toBe("unknown");
  expect(residenceStatus({ ...local("부산광역시", "부산광역시"), region: { ctpv: "부산광역시", sgg: "부산광역시" } }, BUSAN_ONLY)).toBeUndefined();
  expect(residenceStatus({ ...local("부산광역시", ""), provider: "central" }, BUSAN_ONLY)).toBeUndefined();
});

const fixture = FixtureWelfareDataProvider.fromFile();
const heard = (answer: GroundedAnswer) => answer.card ? speakAnswerCard(answer.card) : answer.speech;
const matchName = "기장군 저소득 중증장애인 교통비";
const leftOut = "다른 시·군·구 사업은 뺐어요";

function localAgent(target: string, llm?: FakeLlm) {
  return new WelfareInformationAgent({
    mode:"official-api", catalog:ctpv => fixture.catalog(ctpv),
    listServices:() => Promise.resolve([]),getService:() => Promise.resolve(undefined),
    findService:() => Promise.resolve(undefined),getFieldGlossary:() => Promise.resolve(undefined),
    async getLocalService(servId, detailUrl): Promise<WelfareService> {
      return {servId,servNm:matchName,summary:"저소득 중증장애인의 이동을 돕는 교통비 지원",target,criteria:"",
        applyMethod:"주소지 읍·면 행정복지센터 방문 신청",applySteps:[],
        contacts:[{name:"노인장애인복지과",value:"051-000-0000"}],forms:[{name:"기장군 저소득 중증장애인 교통비 지원 조례.hwp",url:"https://example.invalid/f"}],
        dataOrigin:"official-api",source:{title:"복지로 '기장군 교통비'",url:detailUrl ?? "https://example.invalid/d",lastCheckedAt:"2026-11-19",version:"API 실시간"}};
    },
  },llm);
}

function checks(...conditions: string[]) {
  return new FakeLlm({precheck:{checks:conditions.map(condition=>({condition,status:"met",note:""}))}});
}

function remainingPages(agent: WelfareInformationAgent): string[] {
  const pages: string[] = [];
  for (;;) {
    const text = agent.moreMatches().speech;
    pages.push(text);
    if (text.startsWith("찾은 제도를 모두")) return pages;
  }
}

it("test_list_says_once_that_other_district_programs_were_left_out", async () => {
  const agent = new WelfareInformationAgent(fixture);
  const profile = {...BUSAN_ONLY,sgg:"사상구"};
  const first = await agent.discover(profile);
  expect(first.speech.split(leftOut)).toHaveLength(2);
  expect(remainingPages(agent).every(p => !p.includes(leftOut))).toBe(true);
  expect((await agent.discover(profile)).speech).not.toContain(leftOut);
});

it.each([BUSAN_ONLY, {...BUSAN_ONLY,ctpv:"서울특별시",sgg:"중구"}])("test_list_does_not_mention_left_out_programs_when_none_were", async profile => {
  expect((await new WelfareInformationAgent(fixture).discover(profile)).speech).not.toContain(leftOut);
});

it("test_unknown_district_ranks_district_programs_lower_and_names_their_district", async () => {
  const agent = new WelfareInformationAgent(fixture);
  const first = (await agent.discover(BUSAN_ONLY)).speech;
  expect(first).toContain("1번 장애인연금");
  expect([first,...remainingPages(agent)].join(" ")).toContain("부산진구 저소득노인 건강보험료 지원");
});

it("explains the leading match and its application route before the resident chooses a number", async () => {
  const agent = localAgent("기장군에 거주하는 중증장애인");
  const result = await agent.discover({ ...BUSAN_ONLY, sgg: "기장군" });
  const lead = agent.findInMatches("1번")!;
  expect(lead.servId).toBe(GIJANG_TRANSPORT);
  expect(result.speech.indexOf("주소지 읍·면 행정복지센터 방문 신청")).toBeGreaterThan(result.speech.indexOf("1번"));
  expect(result.speech.indexOf("2번")).toBeGreaterThan(result.speech.indexOf("주소지 읍·면 행정복지센터 방문 신청"));
  expect(result.sources.some(source => source.title === "복지로 '기장군 교통비'")).toBe(true);
  expect(agent.pick(undefined)).toBeUndefined();
  expect(agent.pick("2번")?.servId).not.toBe(lead.servId);
});

it.each([["사상구","맞지 않을 수 있어요"],["기장군","말씀하신 대로면 맞아요"],[undefined,"확인이 필요해요"]] as const)("test_precheck_surfaces_the_residence_gate", async (home,word) => {
  const agent = localAgent("신청일 현재 기장군에 주민등록을 둔 차상위 이하 저소득 장애 정도가 심한 장애인(시설 입소자 제외)",checks("차상위","장애 정도가 심한 장애인"));
  await agent.discover(BUSAN_ONLY);
  const answer = heard(await agent.precheck(matchName,{...BUSAN_ONLY,sgg:home}));
  expect(answer).toContain("기장군 거주: "+word);
  expect(answer).toContain("장애 정도가 심한 장애인: 말씀하신 대로면 맞아요");
  expect(answer).toContain("공식 판정");
});

it.each(["기장군에 1년 이상 거주","전입 후 6개월"])("test_precheck_keeps_length_of_residence_from_the_model", async duration => {
  const agent = localAgent("신청일 현재 기장군에 주민등록을 두고 기장군에 1년 이상 거주했거나 전입 후 6개월이 지난 차상위 이하 저소득 장애 정도가 심한 장애인",checks("기장군에 주민등록",duration,"차상위"));
  await agent.discover(BUSAN_ONLY);
  const answer = heard(await agent.precheck(matchName,{...BUSAN_ONLY,sgg:"기장군"}));
  expect(answer).toContain("기장군 거주: 말씀하신 대로면 맞아요. "+duration+": 확인이 필요해요. 차상위: 말씀하신 대로면 맞아요");
  expect(answer).not.toContain("주민등록");
});

it("test_precheck_without_official_criteria_still_names_residence", async () => {
  const agent = new WelfareInformationAgent(fixture);
  await agent.discover(BUSAN_ONLY);
  expect(heard(await agent.precheck(matchName,{...BUSAN_ONLY,sgg:"사상구"}))).toContain("기장군 거주: 맞지 않을 수 있어요");
});

it("test_prepare_does_not_call_attachments_required_forms", async () => {
  const agent = localAgent("교통비 지원");
  await agent.discover(BUSAN_ONLY);
  const answer = heard(await agent.prepare(matchName));
  expect(answer).not.toContain("필요한 서식");
  expect(answer).toContain("서식·자료");
});
