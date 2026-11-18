import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { parseAction } from "../../src/core/actions.ts";
import { evaluateRetrieval, loadRagQa } from "../../src/evaluation/index.ts";
import { parseIntent } from "../../src/core/intents.ts";
import { AGENT_IDS, AgentHandoffSchema } from "../../src/core/turn.ts";
import { cite, sourceSentence, WelfareInformationAgent } from "../../src/agents/welfare/agent.ts";
import {
  cleanApiText, FixtureWelfareDataProvider, OfficialCentralWelfareApiProvider, parseWelfareDetail, parseWelfareList, parseXml,
  type WelfareDataProvider, type WelfareService,
} from "../../src/agents/welfare/data/index.ts";
import { chunkService } from "../../src/agents/welfare/rag.ts";
import { fakeFetch, FakeLlm } from "../helpers.ts";

const xml = (file: string) => readFileSync(join(import.meta.dirname, "../fixtures", file), "utf8");
const list = xml("welfare-list-disability-pension.xml");
const detail = xml("welfare-detail-WLF00003249.xml");
const bokjiro = "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00003249&wlfareInfoReldBztpCd=01";
const service = parseWelfareDetail(detail, "https://www.bokjiro.go.kr/x", "2026-11-16");
const fixtures = FixtureWelfareDataProvider.fromFile();
const fixtureAgent = new WelfareInformationAgent(fixtures);
const apiBase = "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001";
const apiError = "<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</errMsg><returnAuthMsg>등록되지 않은 서비스키</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>";

function official(fetchImpl: typeof fetch, apiKey = "test-key") {
  return new OfficialCentralWelfareApiProvider({ apiKey, baseUrl: apiBase }, fixtures, fetchImpl);
}

const listOrDetail = (request: Request) => new Response(new URL(request.url).pathname.endsWith("NationalWelfarelistV001") ? list : detail);

function provider(find = (name: string) => name === service.servNm ? service : undefined): WelfareDataProvider {
  return {
    mode: "official-api", async listServices() { return [service]; }, async getService() { return service; },
    async findService(name) { return find(name); }, async catalog() { return []; },
    getFieldGlossary(id) { return fixtures.getFieldGlossary(id); },
  };
}

function rag(answer: string, chunkId?: string) {
  return new FakeLlm({}, ({user}) => {
    const {근거} = z.object({근거: z.tuple([z.object({id: z.string()})]).rest(z.unknown())}).parse(JSON.parse(user));
    return { answerable: true, answer, usedChunkIds: [chunkId ?? 근거[0].id] };
  });
}

const noEvidence = { answerable: false, answer: "", usedChunkIds: [] };
const general = (answer: string) => new FakeLlm({grounded_answer: noEvidence, general_answer: {known: true, answer}});
const pensionWhen = "장애인연금 받으면 언제 돈이 들어와?";
const pensionAmount = "장애인연금 한 달에 얼마 받아?";

it("test_list_mapping", () => {
  const first = parseWelfareList(list, "2026-11-16")[0];
  expect(first).toMatchObject({ servId: "WLF00003249", servNm: "장애인연금", onlineApply: true, dataOrigin: "official-api", source: {url: bokjiro} });
  expect(first?.summary).toContain("중증장애인");
});

it("test_detail_mapping", () => {
  const result = parseWelfareDetail(detail, bokjiro, "2026-11-16");
  expect(result.target.startsWith("18세 이상의 등록한 중중장애인")).toBe(true);
  expect(result.criteria).toContain("2026년 선정기준액은 단독가구 140만원, 부부가구 224만원");
  expect(result.benefit).toContain("349,700원");
  expect(result.benefit).toContain("×");
  expect(result.applySteps?.[0]).toEqual({step:"신청기관",detail:"거주지 읍/면/동 주민센터, 읍면동 또는 복지로 웹사이트(PC/모바일앱)에서 ‘서비스 신청’"});
  expect(result.contacts).toContainEqual({name: "보건복지상담센터", value: "129"});
  expect(result.forms?.map(f => f.name)).toContain("★2026년 장애인연금 사업안내(최종).pdf");
  expect(result.laws).toEqual(["장애인연금법"]);
  expect(result.criteriaYear).toBe("2026");
  expect(result.source).toMatchObject({url: bokjiro,version:"2026년 기준",lastCheckedAt:"2026-11-16"});
});

it("test_entity_cleanup", () => {
  expect(cleanApiText("a&#13;b &times; c &#9312;")).toBe("a\nb × c ①");
  expect(cleanApiText("&constructor;")).toBe("&constructor;");
});

it("rejects incomplete XML and declarations; preserves repeated children and HTML entities", () => {
  expect(parseXml("<root><child></root>")).toEqual({});
  expect(parseXml("<!DOCTYPE root><root/>")).toEqual({});
  expect(parseXml("<a/><b/>")).toEqual({});
  expect(parseXml("<root>before<child>value</child>after</root>")).toEqual({root:{child:"value"}});
  expect(parseXml("<root>pre<![CDATA[a&amp;b]]>post</root>")).toEqual({root:"prea&amp;bpost"});
  expect(parseXml("<root><child> &copy; </child><child> &amp; </child></root>")).toEqual({root:{child:["©", "&"]}});
});

it("test_official_paths_params_and_cache", async () => {
  const fetchImpl = fakeFetch(listOrDetail);
  const officialProvider = official(fetchImpl);
  const result = await officialProvider.findService("장애인연금");
  expect(result?.criteria).toContain("선정기준액");
  expect(result?.source.url).toBe(bokjiro);
  const urls = fetchImpl.calls.map(c => new URL(c.url));
  expect(urls.map(c => c.pathname.split("/").at(-1))).toEqual(["NationalWelfarelistV001", "NationalWelfaredetailedV001"]);
  expect(Object.fromEntries(urls[0]?.searchParams ?? [])).toMatchObject({callTp:"L",pageNo:"1",numOfRows:"10",srchKeyCode:"001",searchWrd:"장애인연금"});
  expect(Object.fromEntries(urls[1]?.searchParams ?? [])).toMatchObject({callTp:"D",servId:"WLF00003249"});
  await officialProvider.findService("장애인연금");
  expect(fetchImpl.calls).toHaveLength(2);
});

it("test_official_error_falls_back", async () => {
  const p = official(fakeFetch(() => new Response(apiError, {status:401})));
  expect((await p.findService("장애인연금"))?.dataOrigin).toBe("fixture");
  expect(p.lastError).toContain("SERVICE_KEY_IS_NOT_REGISTERED_ERROR");
});

it("keeps the API credential out of recorded request URLs and fallback diagnostics", async () => {
  const key = "test+key/with=symbols";
  const fetchImpl = fakeFetch(listOrDetail);
  const raw = await official(fetchImpl, key).fetchRaw({callTp:"L",extra:{serviceKey:"caller-supplied"}});
  expect(new URL(raw.requestUrl).searchParams.has("serviceKey")).toBe(false);
  expect(new URL(fetchImpl.calls[0]?.url ?? apiBase).searchParams.get("serviceKey")).toBe(key);
  const provider = official(fakeFetch(request => { throw new Error(request.url); }), key);
  await provider.listServices();
  expect(provider.lastError).not.toContain(encodeURIComponent(key));
});

it.each([
  ["장애인연금 지원대상이 누구야?", ["18세 이상의 등록한 중중장애인", "단독가구 140만원"]],
  ["장애인연금 얼마 받아?", ["349,700원"]],
  ["장애인연금 신청 절차 알려줘", ["신청기관은 거주지 읍/면/동 주민센터", "결정기관은"]],
  ["장애인연금 필요한 서류 알려줘", ["금융정보 등(금융ㆍ신용ㆍ보험정보) 제공 동의서"]],
  ["장애인연금 어디에 문의해?", ["보건복지상담센터 129"]],
] as const)("test_topic_answers_from_official_data", async (q, parts) => {
  const a = await new WelfareInformationAgent(official(fakeFetch(listOrDetail))).answerPolicyQuestion(q);
  for (const part of parts) expect(a.speech).toContain(part);
  expect(a.speech.includes("최종 판단")).toBe(q.includes("대상"));
  expect(a.speech).toContain("2026년 기준");
  expect(a.sources[0]?.url).toBe(bokjiro);
  expect(a.service?.dataOrigin).toBe("official-api");
});

it("test_chunk_sections", () => {
  expect([...new Set(chunkService(service).map(c => c.section))]).toEqual(["개요","지원대상","선정기준","지원내용","신청절차","서식","문의처","근거법령"]);
});

it("test_retrieval_quality", () => {
  expect(evaluateRetrieval(service, loadRagQa(), 3)).toEqual({ k: 3, questions: 20, recallAtK: 1, mrr: 0.95, misses: [] });
});

it("test_retrieval_recall_misses_rank_k", () => {
  const plain: WelfareService = {
    servId: "S", servNm: "가나", summary: "다라", target: "마바", criteria: "사아", benefit: "자차", applyMethod: "카타",
    source: { title: "t", url: "https://example.test/", lastCheckedAt: "2026-11-19", version: "v" }, dataOrigin: "fixture",
  };
  // 'zz'는 어느 조각과도 겹치지 않아 순서가 개요·지원대상·선정기준·지원내용이다. 지원내용은 4위(rank 3).
  const r = evaluateRetrieval(plain, { description: "", service: "가나", items: [{ q: "zz", expected: ["지원내용"] }] }, 3);
  expect(r).toMatchObject({ recallAtK: 0, mrr: 0.25 });
});

it("test_rag_answer_within_evidence", async () => {
  const a = await new WelfareInformationAgent(provider(),rag("18세에서 64세는 2026년 기준 매월 최대 349,700원입니다.")).answerQuestion(pensionAmount);
  expect(a).toMatchObject({method:"rag-llm", grounded:true});
  expect(a.speech).toContain("349,700원");
  expect(a.speech).not.toContain("최종 판단");
  expect(a.retrieval?.sections[0]).toBe("지원내용");
});

it("test_rag_invented_amount_replaced", async () => {
  const a = await new WelfareInformationAgent(provider(),rag("매월 최대 50만 원을 받아요.")).answerQuestion(pensionAmount);
  expect(a.method).toBe("topic-rule");
  expect(a.speech).not.toContain("50만");
  expect(a.verification?.reasons.join(",")).toContain("50만");
});

it("test_rag_not_answerable", async () => {
  const a = await new WelfareInformationAgent(provider(),new FakeLlm({grounded_answer:noEvidence})).answerQuestion("장애인연금 받으면 교통비도 할인돼?");
  expect(a.grounded).toBe(false);
  expect(a.speech).toContain("찾지 못했습니다");
  expect(a.speech).toContain("129");
});

it("test_general_answer_without_number_is_spoken", async () => {
  const answer = "보통 매달 정해진 날에 계좌로 들어와요.";
  const a = await new WelfareInformationAgent(provider(), general(answer)).answerQuestion(pensionWhen);
  expect(a).toMatchObject({method:"general-llm",grounded:false});
  expect(a.speech).toContain("공식 자료에는 그 내용이 없어요");
  expect(a.speech).toContain(answer);
});

it.each(["보통 매달 20일에 계좌로 들어와요.","교통비는 한 달에 5만 원까지 할인돼요.","신청하고 3개월쯤 걸려요.","매달 ２０일이에요."])("test_general_answer_with_number_is_not_spoken", async answer => {
  const a = await new WelfareInformationAgent(provider(),general(answer)).answerQuestion(pensionWhen);
  expect(a).toMatchObject({method:"rag-llm",grounded:false,verification:{ok:false}});
  expect(a.speech).toContain("찾지 못했습니다");
  expect(a.speech).not.toContain("일반적으로 알려진 바로는");
  expect(a.speech).not.toContain(answer);
});

it("keeps personal identifiers out of both model requests", async () => {
  const llm = general("보통 계좌로 들어와요.");
  await new WelfareInformationAgent(provider(),llm).answerQuestion(pensionWhen + " 내 주민등록번호는 900101-1234567");
  expect(llm.calls.map(c => c.schemaName)).toEqual(["grounded_answer","general_answer"]);
  for (const {user} of llm.calls) {
    expect(JSON.parse(user)).toHaveProperty("question");
    expect(user).not.toContain("900101-1234567");
    expect(user).toContain("[비공개]");
  }
});

it("test_rag_unknown_chunk_ids_replaced", async () => {
  const a = await new WelfareInformationAgent(provider(),rag("주민센터에 가면 바로 받을 수 있어요.", "made-up#9")).answerQuestion("장애인연금 얼마 받아?");
  expect(a.method).toBe("topic-rule");
  expect(a.speech).not.toContain("바로 받을 수 있어요");
});

it("test_rag_follow_up_remembers_service", async () => {
  const agent = new WelfareInformationAgent(provider(), rag("거주지 읍면동 주민센터나 복지로에서 신청합니다."));
  await agent.answerQuestion("장애인연금 대상이 누구야?");
  const a = await agent.answerQuestion("그럼 어디서 신청해?");
  expect(a.service?.servNm).toBe("장애인연금");
  expect(a.retrieval?.sections[0]).toBe("신청절차");
});

it("test_application_context_switches_service", async () => {
  const other = {...service,servId:"WLF-BASIC",servNm:"기초연금"};
  const agent = new WelfareInformationAgent(provider(n => [other,service].find(s => s.servNm === n)),rag("답"));
  await agent.answerQuestion("기초연금은 몇 살부터 받아?");
  await agent.applicationContext();
  expect((await agent.answerQuestion("소득이 조금 있어도 받을 수 있어?")).service?.servNm).toBe("장애인연금");
});

it("test_rule_answer_without_llm", async () => {
  const a = await new WelfareInformationAgent(provider()).answerQuestion("장애인연금 얼마 받아?");
  expect(a.method).toBe("topic-rule");
  expect(a.speech).toContain("349,700원");
});

it("test_explain_field_has_source", async () => {
  const a = await fixtureAgent.explainField("incomeStatus","소득·재산 신고");
  expect(a.grounded).toBe(true);
  expect(a.sources[0]?.url.startsWith("https://")).toBe(true);
  expect(a.sources[0]?.lastCheckedAt).toBe("2026-11-15");
  expect(a.speech).toContain("출처");
});

it("test_explain_unknown_field_no_guess", async () => {
  const a = await fixtureAgent.explainField("unknownField","알 수 없음");
  expect(a).toMatchObject({grounded:false,sources:[]});
});

it("test_policy_question_has_disclaimer", async () => {
  const a = await fixtureAgent.answerPolicyQuestion("장애인연금 지원대상과 신청 절차 알려줘");
  for (const part of ["지원 대상","신청 방법","최종 판단"]) expect(a.speech).toContain(part);
});

it("test_contracts", () => {
  expect(parseAction({id:"1",type:"click",reason:"x",risk:"low",requiresConfirmation:false,x:1})).toBeUndefined();
  expect(AgentHandoffSchema.safeParse({from:AGENT_IDS.welfare,to:AGENT_IDS.web,taskId:"t",goal:"신청 페이지 열기",targetUrl:"http://localhost:5174/apply.html",sources:[],requiresApprovedDomain:true,domainApproved:true}).success).toBe(true);
  expect(parseIntent({type:"FILL",fills:[]})).toBeUndefined();
});

function deadlineAgent(extra: Partial<WelfareService>, llm?: FakeLlm) {
  const s: WelfareService = {servId:"T1",servNm:"시험지원금",summary:"요약",target:"대상",applyMethod:"방문 신청",
    source:{title:"출처",url:"https://example.com/x",lastCheckedAt:"2026-11-18",version:"API 실시간"}, dataOrigin:"official-api",
    contacts:[{name:"담당과",value:"051-111-2222"}], ...extra};
  return new WelfareInformationAgent(provider(() => s), llm);
}

const deadlineQ = "시험지원금 지금 신청할 수 있어?";
it("test_deadline_open_from_enforcement_dates", async () => {
  const a = await deadlineAgent({enfcBgngYmd:"20240101",enfcEndYmd:"99991231"}).answerQuestion(deadlineQ,"2026-11-18");
  expect(a).toMatchObject({method:"topic-rule",grounded:true});
  expect(a.speech).toContain("신청할 수 있어요");
  expect(a.speech).not.toContain("신청할 수 없어요");
});

it("test_deadline_closed_from_enforcement_dates", async () => {
  const a = await deadlineAgent({enfcBgngYmd:"20240101",enfcEndYmd:"20241231"}).answerQuestion(deadlineQ,"2026-11-18");
  expect(a.grounded).toBe(true);
  expect(a.speech).toContain("신청할 수 없어요");
});

it("test_deadline_uses_korean_date_at_0830_kst", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-11-17T23:30:00Z"));
    const a = await deadlineAgent({enfcBgngYmd:"20261118",enfcEndYmd:"20261118"}).answerQuestion(deadlineQ);
    expect(a.speech).toContain("신청할 수 있어요");
  } finally { vi.useRealTimers(); }
});

it("test_deadline_open_from_year_round_text", async () => {
  const a = await deadlineAgent({applyMethod:"신청기간 : 연중 신청. 방문 또는 인터넷."}).answerQuestion(deadlineQ,"2026-06-01");
  expect(a.grounded).toBe(true);
  expect(a.speech).toContain("신청할 수 있어요");
});

it.each([
  ["없는 날짜의 시행 종료일", {enfcBgngYmd:"20240101",enfcEndYmd:"20260230"}, "2026-11-18"],
  ["본문의 2월 30일 마감", {applyMethod:"신청기간 : 2026년 2월 30일까지 방문 신청."}, "2026-02-25"],
  ["윤년이 아닌 해의 2월 29일", {enfcBgngYmd:"20250301",enfcEndYmd:"20250301"}, "2025-02-29"],
] as const)("test_deadline_invalid_day_is_unknown (%s)", async (_name, extra, today) => {
  const a = await deadlineAgent(extra).answerQuestion(deadlineQ, today);
  expect(a.speech).toContain("확인하지 못");
  expect(a.speech).not.toContain("신청할 수 있어요");
  expect(a.speech).not.toContain("신청할 수 없어요");
});

it("test_deadline_unknown_without_period_gives_contact", async () => {
  const a = await new WelfareInformationAgent(provider()).answerQuestion("장애인연금 지금 신청할 수 있어?","2026-11-18");
  expect(a.speech).toContain("확인하지 못");
  expect(a.speech).not.toContain("신청할 수 있어요");
  expect(a.speech).not.toContain("신청할 수 없어요");
  expect(a.speech).toContain("129");
});

it("test_deadline_question_bypasses_llm", async () => {
  const llm = rag("네, 지금 바로 신청할 수 있어요.");
  const a = await deadlineAgent({enfcBgngYmd:"20200101",enfcEndYmd:"20201231"},llm).answerQuestion(deadlineQ,"2026-11-18");
  expect(a.method).toBe("topic-rule");
  expect(a.speech).toContain("신청할 수 없어요");
  expect(a.speech).not.toContain("바로 신청할 수 있어요");
  expect(llm.calls).toHaveLength(0);
});

it("test_fixture_field_speech_says_saved_not_live_api", async () => {
  const a = await fixtureAgent.explainField("incomeStatus","소득·재산 신고");
  expect(a.grounded).toBe(true);
  expect(a.speech).toContain("저장된 자료 기준");
  expect(a.speech).not.toContain("API 실시간");
  expect(a.sources[0]?.version).toBe("저장된 자료 기준");
});

it("test_fixture_policy_speech_says_saved_not_live_api", async () => {
  const a = await fixtureAgent.answerPolicyQuestion("장애인연금 지원대상과 신청 절차 알려줘");
  expect(a.speech).toContain("저장된 자료 기준");
  expect(a.speech).not.toContain("API 실시간");
  expect(a.sources.every(s => s.version === "저장된 자료 기준")).toBe(true);
});

it("test_fixture_catalog_source_not_labelled_live_api", async () => {
  const a = await fixtureAgent.discover({age:40,disability:"severe",income:"basic",ctpv:null});
  expect(a.sources[0]?.version).toBe("저장된 자료 기준");
});

it("test_api_fallback_catalog_source_not_labelled_live_api", async () => {
  const a = await new WelfareInformationAgent(official(fakeFetch(() => new Response(apiError,{status:503})))).discover({age:40,disability:"severe",income:"basic",ctpv:null});
  expect(a.sources[0]?.version).toBe("저장된 자료 기준");
});

it("test_cite_rewrites_fixture_version_label", () => {
  const s = cite({title:"보건복지부 안내",url:"https://example.com",lastCheckedAt:"2026-11-15",version:"fixture-v1",note:"fixture 작성일 기준"});
  expect(s.version).toBe("저장된 자료 기준");
  expect(sourceSentence(s)).toContain("저장된 자료 기준");
  expect(sourceSentence(s)).not.toContain("fixture-v1");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return {promise, resolve};
}

it("a cancelled welfare lookup cannot select a service after the next turn starts", async () => {
  const request = deferred<WelfareService>();
  const started = deferred<void>();
  const agent = new WelfareInformationAgent({
    ...provider(),
    findService() { started.resolve(); return request.promise; },
  });
  const controller = new AbortController();
  const answer = agent.answerQuestion(pensionAmount, undefined, controller.signal);
  await started.promise;
  controller.abort();
  request.resolve(service);
  await expect(answer).rejects.toBe(controller.signal.reason);
  expect(agent.lastService).toBeUndefined();
});

it("cancelling a welfare turn aborts its official API request and bypasses the fixture fallback", async () => {
  const started = deferred<AbortSignal>();
  const fetchImpl = fakeFetch(request => new Promise<Response>((_resolve, reject) => {
    started.resolve(request.signal);
    request.signal.addEventListener("abort", () => reject(request.signal.reason), {once:true});
  }));
  const controller = new AbortController();
  const data = official(fetchImpl);
  const answer = new WelfareInformationAgent(data).answerQuestion(pensionAmount, undefined, controller.signal);
  const networkSignal = await started.promise;
  controller.abort();
  await expect(answer).rejects.toBe(controller.signal.reason);
  expect(networkSignal.aborted).toBe(true);
  expect(data.lastError).toBeUndefined();
});

it("cancelling a model reply stops the general-answer fallback", async () => {
  const started = deferred<AbortSignal | undefined>();
  const reply = deferred<typeof noEvidence>();
  const llm = new FakeLlm({}, request => { started.resolve(request.signal); return reply.promise; });
  const controller = new AbortController();
  const answer = new WelfareInformationAgent(provider(), llm).answerQuestion(pensionAmount, undefined, controller.signal);
  expect(await started.promise).toBe(controller.signal);
  controller.abort();
  reply.resolve(noEvidence);
  await expect(answer).rejects.toBe(controller.signal.reason);
  expect(llm.calls.map(c => c.schemaName)).toEqual(["grounded_answer"]);
});

it("test_precheck_empty_ref_uses_current_service", async () => {
  const agent = new WelfareInformationAgent(fixtures);
  await agent.applicationContext();
  const r = await agent.precheck("", { age: 30 });
  expect(r.speech).toContain("장애인연금 자격을 미리 살펴봤어요");
  expect(r.grounded).toBe(true);
});

it("test_prepare_empty_ref_uses_current_service", async () => {
  const agent = new WelfareInformationAgent(fixtures);
  await agent.applicationContext();
  const r = await agent.prepare("");
  expect(r.speech).toContain("장애인연금 신청은");
  expect(r.grounded).toBe(true);
});
