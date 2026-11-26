import { expect, it, vi } from "vitest";
import { z } from "zod";
import * as browser from "../../src/agents/web/browser/index.ts";
import { STACK } from "../../src/core/model_stack.ts";
import type { JobPhase, ResearchDesk, SavedJob } from "../../src/core/research_desk.ts";
import { detectScriptLang } from "../../src/language/i18n.ts";
import { parseDecision, PublicTask, reviewCompletion } from "../../src/orchestrator/public_task.ts";
import { loadConfig } from "../../src/server/runtime.ts";
import { SettingsInput } from "../../src/server/settings.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { FakeLlm, withLlm } from "../helpers.ts";
import { browserCases, latch } from "./browser-cases.ts";
import { adapterFor, pageFor, runtimeCases } from "./browser-runtime-cases.ts";

const open = browserCases(), service = runtimeCases(), source = "방문 신청자는 신분증과 신청서를 지참합니다.";
function decision(fields: Record<string, unknown> = {}) {
  return {kind: "find_information", agency: "정부24", source: "browser", subject: "주민등록등본", goal: "주민등록등본 발급 서류",
    requestedFacts: ["documents"], exclusions: [], continuation: false, question: null, choices: [], ...fields};
}

it("passes the preceding ordinary conversation to Sol when a spoken request refers back to it", async () => {
  const {session} = await open();
  const question = "장학금과 학자금 대출의 차이를 쉬운 말로 설명해 주세요.";
  const answer = "첫째는 장학금, 둘째는 나중에 갚는 학자금 대출이에요.";
  const followup = "두 번째 제도는 어디에서 신청하는지 찾아 주세요.";
  const model = new FakeLlm({ public_service_decision: {
    kind: "conversation", reply: answer, requestedFacts: [], exclusions: [], continuation: false, choices: [],
  } });
  withLlm(session, model);
  expect((await session.handleTurn(question)).speech).toBe(answer);
  await session.handleTurn(followup, {fromVoice: true});
  const requests = model.calls.filter(call => call.schemaName === "public_service_decision");
  expect(requests).toHaveLength(2);
  expect(JSON.parse(requests[1]!.user)).toMatchObject({
    utterance: followup, voice: true, task: {goal: ""}, dialogue: [{user: question, assistant: answer}],
  });
});

it("keeps only the latest safe exchanges and clears them across a private readback or Stop", async () => {
  const {session} = await open();
  const ask = "장학금과 학자금 대출의 차이를 설명해 주세요.";
  const answer = "장학금과 학자금 대출은 학비를 지원하는 서로 다른 방식이에요.";
  const model = new FakeLlm({public_service_decision: {kind: "conversation", reply: answer,
    requestedFacts: [], exclusions: [], continuation: false, choices: []}});
  withLlm(session, model);
  for (let i = 1; i <= 5; i++) await session.handleTurn(ask + " " + i);
  expect(session.plannerDialogue().map(row => row.user)).toEqual([2, 3, 4, 5].map(i => ask + " " + i));
  await session.handleTurn("내 이름은 별구름이라고 저장해줘");
  await session.handleTurn("응");
  await session.handleTurn("내 정보 알려줘");
  expect(session.plannerDialogue()).toEqual([]);
  const readback = session.handleTurn("내 정보 알려줘");
  const followup = session.handleTurn(ask, {fromVoice: true, plannerDialogue: [{user: "stale snapshot", assistant: answer}]});
  await Promise.all([readback, followup]);
  const latest = model.calls.filter(call => call.schemaName === "public_service_decision").at(-1);
  expect(latest?.user).toContain(ask);
  expect(latest?.user).not.toContain("stale snapshot");
  expect(session.plannerDialogue().at(-1)?.assistant).toBe(answer);
  session.cancel();
  expect(session.plannerDialogue()).toEqual([]);
});

it("redacts a frozen handoff, preserves its ordering and marks an oversized exchange incomplete", async () => {
  const {session} = await open();
  session.rememberCallName("별구름");
  const handoff = [{user: "Can you compare these?", assistant: "First student loans, then scholarships."}];
  const prior = session.plannerDialogue([{user: "And in Japan?", assistant: "별구름: contact@example.org, https://example.org/private?q=hidden."}], handoff);
  expect(prior[0]).toEqual(handoff[0]);
  expect(session.plannerDialogue([{user: "내 정보 알려줘", assistant: "저장된 이름은 솔바람이에요."}], handoff)).toEqual([]);
  expect(prior[1]?.assistant).toContain("https://example.org");
  for (const secret of ["별구름", "contact@example.org", "hidden"]) expect(JSON.stringify(prior)).not.toContain(secret);
  const big = session.plannerDialogue([{user: "選択肢", assistant: "🍊".repeat(3000)}], []);
  expect(big).toHaveLength(1);
  expect(big[0]?.incomplete).toBe(true);
  expect(big[0]?.assistant).not.toContain("�");
  expect(Buffer.byteLength(big[0]!.user) + Buffer.byteLength(big[0]!.assistant)).toBeLessThanOrEqual(6400);
});

it("test_decision_schema_scopes_memory_and_keeps_explicit_model_overrides", () => {
  const config = loadConfig({OPENAI_API_KEY: "test"});
  expect(config.llmUnderstand.model).toBe(STACK.agent); expect(config.llmGoal.model).toBe(STACK.agent);
  const custom = loadConfig({OPENAI_API_KEY: "test", LLM_MODEL: "configured", LLM_GOAL_MODEL: "another"});
  expect(custom.llmUnderstand.model).toBe("configured"); expect(custom.llmGoal.model).toBe("another");
  for (const variant of [{kind: "approve"}, {agency: "https://external.invalid"}, {tool: "submit"}, {goal: "https://external.invalid"}]) expect(parseDecision(decision(variant))).toBeUndefined();
  const task = new PublicTask({agency: "정부24", exclusions: ["login"]});
  expect(task.advance(parseDecision(decision({continuation: true}))!).exclusions).toEqual(["login"]);
  expect(task.advance(parseDecision(decision({agency: "한국장학재단", continuation: true}))!).exclusions).toEqual([]);
  expect(detectScriptLang("Can you find 국가장학금 documents?")).toBe("en");
  const rules = new RuleBasedIntentProvider([]);
  for (const phrase of ["정부24에서 로그인은 건너뛰고 주민등록등본 발급 서류만 알려줘", "로그인은 됐고 국가장학금 서류만 알려줘"]) expect(rules.parseSync(phrase, {state: "IDLE"}).type).toBe("GOAL");
  expect(rules.parseSync("승인하면 어떻게 되나요?", {state: "WAITING_FOR_USER_CONFIRMATION"}).type).not.toBe("APPROVE");
});

it.each([
  ["ko", "정부24에서 로그인은 건너뛰고 주민등록등본 발급 서류만 알려줘", ""],
  ["en", "On Gov24 please find the paperwork, without logging in.", "In-person applicants must bring ID and the form, according to Gov24."],
  ["zh", "请在政府24查一下办理住民登记所需材料，不要登录。", "政府24资料显示，现场申请需携带身份证和申请表。"],
  ["ja", "政府24で住民登録謄本の書類を調べてください。ログインは不要です。", "政府24によると、窓口では身分証と申請書を持参します。"],
] as const)("test_normal_turn_uses_native_intake_and_verified_page", async (lang, text, translation) => {
  const {post, session: create} = await service({PRACTICE_MODE: "false"}), {session, id} = await create();
  const model = new FakeLlm(({schemaName, user}) => {
    if (schemaName === "public_service_decision") {
      expect(JSON.parse(user)).toMatchObject({utterance: text, replyLanguage: lang});
      return decision({exclusions: ["login"]});
    }
    if (schemaName === "public_browse_step") {
      const input = z.object({page: z.object({passages: z.array(z.object({id: z.number(), text: z.string()}))}), conversation: z.object({exclusions: z.array(z.string())})}).parse(JSON.parse(user));
      expect(input.conversation.exclusions).toEqual(["login"]); const row = input.page.passages.find(r => r.text === source)!;
      return {action: "answer", target: null, answer: "수수료는 72만원이에요.", claims: [{fact: "documents", passageId: row.id, quote: null}]};
    }
    if (schemaName === "translate_out") return {text: translation};
    throw new Error("Unexpected model call " + schemaName);
  }); withLlm(session, model);
  await pageFor(session).route("https://www.gov.kr/**", r => r.fulfill({contentType: "text/html; charset=utf-8", body: "<title>정부24</title><main><p>" + source + "</p></main>"}));
  const result = z.object({intentType: z.string(), lang: z.string(), speech: z.string(), sources: z.array(z.object({url: z.string()})),
    pendingConfirmation: z.unknown().optional(), actions: z.array(z.object({action: z.object({type: z.string()})}))}).parse(await (await post("/api/turn", {sessionId: id, text})).json());
  expect(result.intentType).toBe("GOAL"); expect(result.lang).toBe(lang); expect(result.sources[0]?.url).toContain("https://www.gov.kr/");
  expect(result.pendingConfirmation).toBeUndefined(); expect(result.speech).not.toContain("72"); expect(result.actions.map(a => a.action.type)).not.toContain("click");
  const names = model.calls.map(c => c.schemaName); expect(names.filter(n => n === "public_service_decision")).toHaveLength(1);
  expect(names).not.toContain("translate_in"); expect(names).not.toContain("intent_plan");
});

it("test_clarification_choice_rejection_and_agency_switch", async () => {
  const {session, page} = await open(); session.setLanguage("en");
  const seen: (string | null)[] = [];
  withLlm(session, new FakeLlm(({schemaName, user}) => {
    if (schemaName === "translate_out") return {text: "I opened the requested page."};
    if (schemaName !== "public_service_decision") return undefined;
    const {selectedChoice} = z.object({selectedChoice: z.string().nullable()}).parse(JSON.parse(user)); seen.push(selectedChoice);
    return selectedChoice !== null ? decision({kind: "open_agency", agency: "한국장학재단", subject: "국가장학금", goal: null, requestedFacts: [], continuation: true}) :
      decision({kind: "clarify", agency: null, subject: null, goal: "공공서비스 기관 찾기", requestedFacts: [], question: "Do you mean Gov24 or the scholarship foundation?", choices: ["Gov24", "Scholarship foundation"]});
  }));
  await page.route("https://www.kosaf.go.kr/**", r => r.fulfill({contentType: "text/html", body: "<main>KOSAF</main>"}));
  const ask = await session.handleTurn("I couldn't catch the agency name.", {fromVoice: true}); expect(ask.semanticAction).toBe("clarify"); expect(ask.actions).toEqual([]);
  expect((await session.handleTurn("yes")).actions).toEqual([]); expect(seen).toHaveLength(1);
  expect((await session.handleTurn("no")).actions).toEqual([]); expect(session.publicTask.question).toBe("");
  await session.handleTurn("Which place was that again?", {fromVoice: true});
  const result = await session.handleTurn("2", {fromVoice: true}); expect(seen.at(-1)).toBe("Scholarship foundation"); expect(result.intentType).toBe("OPEN_SITE");
  expect(session.publicTask.agency).toBe("한국장학재단"); session.cancel(); expect(session.publicTask.question).toBe("");
});

it("test_stop_during_intake_discards_late_decision", async () => {
  const {session} = await open(), started = latch(), release = latch();
  session.deps.llm = new FakeLlm(async () => {started.resolve(); await release.promise; return decision({kind: "open_agency", goal: null, requestedFacts: []});});
  const pending = session.handleTurn("Could you find the relevant public service?");
  try {await started.promise; expect((await session.handleTurn("stop")).state).toBe("STOPPED");}
  finally {release.resolve();}
  const late = await pending; expect(late.state).toBe("STOPPED"); expect(late.actions).toEqual([]); expect(session.publicTask.goal).toBe("");
});
it("test_read_scope_even_on_a_supported_form", async () => {
  const {session} = await open(), ctx = {currentUrl: session.web.profile.origin, approvals: new Set(["x"]), publicLookup: true};
  for (const name of ["로그인", "신청하기", "제출"]) expect(session.web.guard.check({id: "x", type: "click", target: {role: "link", name},
    reason: "test", requiresConfirmation: false, risk: "low"}, ctx).code).toBe("DENIED_TASK_SCOPE");
});
it("test_partial_lookup_keeps_earlier_proof_and_names_the_missing_fact", async () => {
  const {session, page} = await open(), observed: string[][] = [];
  withLlm(session, new FakeLlm(({schemaName, user}) => {
    if (schemaName === "public_service_decision") return decision({requestedFacts: ["documents", "amount"], goal: "주민등록등본 방문 발급 서류와 수수료 확인"});
    if (schemaName !== "public_browse_step") return undefined;
    const {missingFacts} = z.object({missingFacts: z.array(z.string())}).parse(JSON.parse(user)); observed.push(missingFacts);
    return missingFacts.includes("documents") ? {action: "find", target: "수수료", answer: null, claims: [{fact: "documents", quote: source}]} :
      {action: "fail", target: null, answer: "무료라고 생각합니다.", claims: [{fact: "amount", passageId: 999, quote: "무료입니다."}]};
  }));
  await page.route("https://www.gov.kr/**", r => r.fulfill({contentType: "text/html; charset=utf-8", body: "<title>정부24</title><main><p>" + source + "</p></main>"}));
  const result = await session.handleTurn("정부24에서 등본 방문 발급 서류와 수수료를 확인해줘");
  expect(observed).toEqual([["documents", "amount"], ["amount"]]); expect(result.speech).toContain(source); expect(result.speech).toContain("금액 항목은 아직");
  expect(result.speech).not.toContain("무료"); expect(result.sources).toHaveLength(1);
});
it.each([
  ["checked", true, "신분증과 신청서를 가지고 방문하시면 돼요."],
  ["rejected", false, "신분증과 신청서를 가지고 방문하시면 돼요."],
  ["unsupported-number", true, "신분증과 신청서, 수수료 400원을 가지고 방문하시면 돼요."],
  ["partial", true, "신분증과 신청서를 가지고 방문하시면 돼요."],
] as const)("test_public_lookup_speaks_the_plain_answer_only_after_checking_it_against_the_passages (%s)", async (variant, faithful, plain) => {
  const {session, page} = await open();
  const facts = variant === "partial" ? ["documents", "amount"] : ["documents"];
  const model = new FakeLlm({public_service_decision: decision({requestedFacts: facts}), public_answer_check: {faithful},
    public_browse_step: {action: "answer", target: null, answer: plain, claims: [{fact: "documents", passageId: null, quote: source}]}});
  withLlm(session, model);
  await page.route("https://www.gov.kr/**", r => r.fulfill({contentType: "text/html; charset=utf-8", body: "<title>정부24</title><main><p>" + source + "</p></main>"}));
  const result = await session.handleTurn("정부24에서 등본 방문 발급 서류를 알려줘");
  const spoken = variant === "checked" || variant === "partial";
  expect(result.speech).toContain(spoken ? plain : source);
  expect(result.speech.includes(source)).toBe(!spoken);
  if (variant === "partial") expect(result.speech).toContain("금액 항목은 아직 확인하지 못했어요");
  expect(result.sources).toHaveLength(1);
  const check = model.calls.find(c => c.schemaName === "public_answer_check");
  expect(check !== undefined).toBe(variant !== "unsupported-number");
  if (check !== undefined) expect(JSON.parse(check.user)).toMatchObject({records: [source], explanation: plain});
});
it("test_public_lookup_drops_a_checked_answer_once_newer_passages_arrive", async () => {
  const {session, page} = await open(), fee = "발급 수수료는 400원입니다.", early = "신분증과 신청서를 가지고 오시면 돼요.";
  let steps = 0, checks = 0;
  withLlm(session, new FakeLlm(({schemaName}) => {
    if (schemaName === "public_service_decision") return decision({requestedFacts: ["documents", "amount"]});
    if (schemaName === "public_answer_check") return {faithful: checks++ === 0};
    if (schemaName !== "public_browse_step") return undefined;
    return steps++ === 0 ? {action: "answer", target: null, answer: early, claims: [{fact: "documents", passageId: null, quote: source}]}
      : {action: "answer", target: null, answer: "신분증과 신청서, 수수료 400원을 준비하세요.", claims: [{fact: "amount", passageId: null, quote: fee}]};
  }));
  await page.route("https://www.gov.kr/**", r => r.fulfill({contentType: "text/html; charset=utf-8", body: `<title>정부24</title><main><p>${source}</p><p>${fee}</p></main>`}));
  const result = await session.handleTurn("정부24에서 등본 방문 발급 서류와 수수료를 알려줘");
  expect(checks).toBe(2);
  expect(result.speech).not.toContain(early);
  expect(result.speech).toContain(source);
  expect(result.speech).toContain(fee);
});
it("test_catalog_answers_compound_public_lookup_without_a_browser_or_another_model", async () => {
  const {session} = await open(), provider = session.deps.welfare.provider;
  const documents = "신청서와 신분증을 준비합니다.", benefit = "예시 대상에게 월 13만 원을 지급합니다.";
  const url = "https://www.bokjiro.go.kr/";
  vi.spyOn(provider, "findService").mockResolvedValue({servId: "sample", servNm: "기초연금", summary: "검증용 제도", dataOrigin: "official-api",
    documents, benefit, target: "", applyMethod: "", source: {version: "fixture", title: "공공서비스 자료", lastCheckedAt: "2026-11-19", url}});
  const model = new FakeLlm({public_service_decision: decision({source: "welfare", agency: "복지로", subject: "기초연금", goal: "기초연금 서류와 금액", requestedFacts: ["documents", "amount"]})}); withLlm(session, model);
  const result = await session.handleTurn("기초연금을 신청하려면 서류가 뭐고 얼마를 받나요?");
  expect(result.intentType).toBe("POLICY_QUESTION"); expect(result.actions).toEqual([]); expect(result.answerCard?.answer).toBe(documents + " " + benefit);
  expect(result.sources[0]?.url).toBe(url); expect(model.calls.map(c => c.schemaName)).toEqual(["public_service_decision"]);
});
it.each([[false, true], [true, true], [true, false]] as const)("test_fixture_reference_requires_observed_official_evidence", async (research, available) => {
  const {session, page} = await open(), info = "공식 안내에 따르면 신청자는 주소지 주민센터에 방문해 신청합니다.", query = "복지로에서 장애인연금 신청 방법을 알려줘";
  const row = await session.deps.welfare.provider.findService("장애인연금"); expect(row?.dataOrigin).toBe("fixture"); expect(row?.source.url).toMatch(/^https:/u);
  const model = new FakeLlm({public_service_decision: decision({agency: "복지로", subject: "장애인연금", goal: query, requestedFacts: ["procedure"], source: "welfare"}),
    public_browse_step: {action: available ? "answer" : "fail", answer: null, target: null, claims: available ? [{fact: "procedure", quote: info}] : []}});
  withLlm(session, model); session.deps.webLlm = new FakeLlm({public_research_coverage: {coverage: "all", checks: [{request: "장애인연금 신청 방법", quote: info}]}});
  await page.route("https://www.bokjiro.go.kr/**", r => r.fulfill({contentType: "text/html; charset=utf-8", body: "<title>복지로</title><main>" + (available ? info : "검색 결과 없음") + "</main>"}));
  let urls: string[];
  if (research) {
    const [state, result] = await session.researchPublic(query, "ko"); expect(state).toBe(available ? "completed" : "incomplete"); urls = (result.sources ?? []).map(s => s.url);
  } else {
    const result = await session.handleTurn(query); expect(result.actions[0]?.action.type).toBe("navigate"); urls = result.sources.map(s => s.url);
  }
  expect(urls.length > 0).toBe(available); expect(urls.every(url => url.startsWith("https://www.bokjiro.go.kr/"))).toBe(true);
  expect(model.calls.some(c => c.schemaName === "public_browse_step")).toBe(true);
});
it.each([["different-action", "partial"], ["unsupported-quote", "partial"], ["timeout-response", "partial"], ["irrelevant", "incomplete"], ["fully-supported", "completed"]])("test_durable_completion_checks_original_request_and_verbatim_support", async (variant, expected) => {
  const request = "How do I check whether documents are needed, and how do I submit the documents?", status = "장학금 신청현황에서 서류제출 대상 여부를 확인합니다.", upload = "대상자는 서류제출현황에서 증빙 파일을 업로드합니다.";
  const evidence = variant === "fully-supported" ? status + " " + upload : status;
  const review = {coverage: variant === "different-action" ? "some" : variant === "irrelevant" ? "unrelated" : "all",
    checks: [{request: "check whether documents are needed", quote: status}, {request: "submit the documents", quote: variant === "different-action" ? null : upload}]};
  const model = new FakeLlm({public_research_coverage: variant === "timeout-response" ? undefined : review});
  expect(await reviewCompletion(model, request, evidence, new AbortController().signal)).toBe(expected);
  expect(model.calls).toHaveLength(1); expect(JSON.parse(model.calls[0]!.user)).toEqual({question: request, evidence});
});
it("test_browser_launch_recovers_on_retry_and_after_disconnect", async () => {
  const {runtime} = await service(), launch = browser.launchBrowser;
  const launches = vi.spyOn(browser, "launchBrowser").mockRejectedValueOnce(new Error("launch failure")).mockImplementation(launch);
  const sessions = [];
  try {
    await expect(runtime.createSession()).rejects.toThrow("launch failure");
    const [a,b] = await Promise.all([runtime.createSession(), runtime.createSession()]); sessions.push(a,b);
    const first = adapterFor(a).context?.browser(); expect(first).toBeTruthy(); expect(first).toBe(adapterFor(b).context?.browser());
    await first?.close();
    const next = await runtime.createSession(); sessions.push(next); expect(adapterFor(next).context?.browser()).not.toBe(first); expect(launches).toHaveBeenCalledTimes(3);
  } finally { launches.mockRestore(); for (const session of sessions) await session.close(); }
});

it("includes a completed agency lookup once after redacting a supplied URL in dialogue", async () => {
  const { session } = await open();
  const origin = "https://www.kosaf.go.kr", marker = "synthetic_referral";
  const request = `한국장학재단 안내 ${origin}/notice?ref=${marker} 에서 국가장학금 신청처를 알려줘`;
  const reply = "국가장학금은 가람관에 신청합니다.";
  const url = origin + "/application";
  session.deps.browsePublicSources = async () => ({state: "BROWSING", semanticAction: "web-answer", speech: reply, reviewQuotes: [reply],
    reviewQuoteSources: {[reply]: [url]}, sources: [{url, title: "합성 자료", lastCheckedAt: "2026-11-23"}]});
  const model = new FakeLlm({ public_service_decision: decision({ agency: "한국장학재단", subject: "국가장학금",
    goal: "국가장학금 신청처 확인", requestedFacts: ["procedure"], searchMode: "quiet" }) });
  withLlm(session, model);
  expect((await session.handleTurn(request)).speech).toBe(reply);
  expect(session.recentVoiceDialogue().at(-2)?.text).toContain(origin);
  expect(JSON.stringify(session.recentVoiceDialogue())).not.toContain(marker);
  await session.handleTurn("거기서 제출할 서류도 알려줘", { fromVoice: true });
  const calls = model.calls.filter(call => call.schemaName === "public_service_decision");
  expect(calls).toHaveLength(2);
  const user = calls[1]!.user;
  expect(user).not.toContain(marker);
  expect(JSON.parse(user)).toMatchObject({ task: { agency: "한국장학재단" }, recent: [],
    dialogue: [{ user: `한국장학재단 안내 ${origin} 에서 국가장학금 신청처를 알려줘`, assistant: reply }] });
});

const delegation = {kind: "delegate_research", goal: "기초연금 신청 서류", requestedFacts: [], exclusions: [], continuation: false, choices: []};

it.each([["바로 맡기는 길", "false"], ["승인을 받아 맡기는 길", "true"]] as const)("%s에서 맡긴 조사의 번호를 세션이 기억하고 맡겼다고만 알린다", async (_name, confirmation) => {
  const {app, runtime, session: create} = await service({REQUIRE_ACTION_CONFIRMATION: confirmation}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  runtime.services.moderation = undefined;
  const {session} = await create();
  withLlm(session, new FakeLlm({public_service_decision: delegation}));
  expect(session.saved.lastSaved).toBeUndefined();
  let reply = await session.handleTurn("기초연금 서류는 배경에서 조사해 줘", {fromVoice: true});
  if (confirmation === "true") {
    expect(reply.pendingConfirmation?.kind).toBe("public-research");
    expect(session.saved.lastSaved).toBeUndefined();
    reply = await session.confirm(true, reply.pendingConfirmation?.actionId);
  }
  const jobs = await (await app.workflows.store()).jobs();
  expect(jobs.map(job => job.prompt)).toEqual(["기초연금 신청 서류"]);
  expect(session.saved.lastSaved).toBe(jobs[0]?.id);
  expect(reply).toMatchObject({researchDelivery: "queued", speech: "조사를 맡겼어요. 결과가 나오면 알려 드릴게요."});
});

it("맡기지 못한 조사는 마지막으로 맡긴 번호를 바꾸지 않고 개인 기기가 없으면 설정을 안내한다", async () => {
  const {session} = await open();
  withLlm(session, new FakeLlm({public_service_decision: delegation}));
  const ask = async () => {
    const waiting = await session.handleTurn("기초연금 서류는 배경에서 조사해 줘", {fromVoice: true});
    return await session.confirm(true, waiting.pendingConfirmation?.actionId);
  };
  expect((await session.handleTurn("기초연금 서류는 배경에서 조사해 줘")).speech).toBe("자료 조사를 맡기려면 이용 설정에서 개인 기기를 선택해 주세요.");
  const jobs = ["job-1", "job-2"];
  const delegate = vi.fn<ResearchDesk["delegate"]>(async () => {
    const jobId = jobs.shift();
    return jobId === undefined ? undefined : {jobId};
  });
  session.deps.research = {recent: async () => [], delegate, read: async () => undefined};
  expect(await ask()).toMatchObject({researchDelivery: "queued"});
  expect(session.saved.lastSaved).toBe("job-1");
  expect(await ask()).toMatchObject({researchDelivery: "queued"});
  expect(session.saved.lastSaved).toBe("job-2");
  const failed = await ask();
  expect(failed.speech).toBe("조사를 시작하지 못했어요. 개인 기기 설정과 질문을 확인해 주세요.");
  expect(failed.researchDelivery).toBeUndefined();
  expect(session.saved.lastSaved).toBe("job-2");
  expect(delegate).toHaveBeenCalledTimes(3);
});

const unusedFields = {requestedFacts: [], exclusions: [], continuation: false, choices: []};
const readSaved = (jobs: string[]) => ({public_service_decision: {kind: "saved_research", research: {action: "read", jobs, answer: null}, ...unusedFields}});
const savedJob = (id: string, request: string, phase: JobPhase): SavedJob => ({id, request, language: "ko", phase, savedOn: "2026-11-25"});
const ASKED = "아까 맡긴 거 어떻게 됐어?";
function deskOf(jobs: SavedJob[]) {
  const recent = vi.fn<ResearchDesk["recent"]>(async limit => jobs.slice(0, limit));
  const read = vi.fn<ResearchDesk["read"]>(async jobId => ({
    jobId, speech: `‘${jobs.find(job => job.id === jobId)?.request}’ 조사 결과예요. 신분증을 준비하세요.`, lang: "ko", sources: [], receipt: {token: "receipt-" + jobId},
  }));
  return {recent, read, delegate: vi.fn<ResearchDesk["delegate"]>(async () => undefined)};
}
const plannerPayloads = (model: FakeLlm) => model.calls.filter(call => call.schemaName === "public_service_decision")
  .map(call => z.record(z.string(), z.unknown()).parse(JSON.parse(call.user)));

it("제 말로 맡긴 조사를 물으면 플래너가 고른 조사를 읽어 주고 신청 기록 명령으로 가지 않는다", async () => {
  const {session} = await open();
  const desk = deskOf([savedJob("job-1", "아동수당 신청 방법", {kind: "working"}), savedJob("job-2", "기초연금 신청 서류", {kind: "ready"})]);
  session.deps.research = desk;
  const records = vi.spyOn(session.personalDialogue, "run");
  const model = new FakeLlm(readSaved(["j2"]));
  withLlm(session, model);
  const reply = await session.handleTurn(ASKED);
  expect(reply).toMatchObject({intentType: "SAVED_RESEARCH", speech: "‘기초연금 신청 서류’ 조사 결과예요. 신분증을 준비하세요.",
    savedResearch: {jobId: "job-2", token: "receipt-job-2", reading: true}});
  expect(desk.read.mock.calls.map(([jobId]) => jobId)).toEqual(["job-2"]);
  expect(records).not.toHaveBeenCalled();
  expect(plannerPayloads(model)).toMatchObject([{utterance: ASKED, savedJobs: [
    {ref: "j1", request: "아동수당 신청 방법", state: "working", savedOn: "2026-11-25"},
    {ref: "j2", request: "기초연금 신청 서류", state: "ready", savedOn: "2026-11-25"},
  ]}]);
});

it("다른 언어로 맡긴 조사는 세션 언어로 옮기지 않고 그 조사의 언어로 그대로 읽는다", async () => {
  const {session} = await open();
  const english = "Results for “Basic pension papers”. Bring your ID.";
  const desk = deskOf([{...savedJob("job-1", "Basic pension papers", {kind: "ready"}), language: "en"}]);
  desk.read.mockImplementation(async jobId => ({jobId, speech: english, lang: "en", sources: [], receipt: {token: "receipt-" + jobId}}));
  session.deps.research = desk;
  session.setLanguage("ja");
  const model = new FakeLlm(readSaved(["j1"]));
  withLlm(session, model);
  const reply = await session.handleTurn("頼んだ調査はどうなりましたか");
  expect(reply).toMatchObject({lang: "en", speech: english, savedResearch: {jobId: "job-1", reading: true}});
  expect(model.calls.map(call => call.schemaName)).not.toContain("translate_out");
  expect(session.lang).toBe("ja");
});

it("같은 말에 플래너가 신청 기록이라고 하면 전처럼 신청 기록을 알려 주고 조사는 읽지 않는다", async () => {
  const {session} = await open();
  const desk = deskOf([savedJob("job-1", "기초연금 신청 서류", {kind: "ready"})]);
  session.deps.research = desk;
  const records = vi.spyOn(session.personalDialogue, "run");
  withLlm(session, new FakeLlm({public_service_decision: {kind: "existing", ...unusedFields}}));
  const reply = await session.handleTurn(ASKED);
  expect(reply.intentType).toBe("PERSONAL_APP_STATUS");
  expect(reply.speech).toContain("기록된 신청이 없어요.");
  expect(records.mock.calls.map(([command]) => command.kind)).toEqual(["app-status"]);
  expect(reply.savedResearch).toBeUndefined();
  expect(desk.read).not.toHaveBeenCalled();
});

it("읽을 수 있는 조사가 여럿인데 하나를 짚지 않았으면 요청을 불러 주며 묻고 아무것도 읽지 않는다", async () => {
  const {session} = await open();
  const desk = deskOf([
    savedJob("job-1", "아동수당 신청 방법", {kind: "ready"}), savedJob("job-2", "조사 중인 것", {kind: "working"}),
    savedJob("job-3", "기초연금 신청 서류", {kind: "asking", revision: 1}),
  ]);
  session.deps.research = desk;
  withLlm(session, new FakeLlm(readSaved([])));
  const reply = await session.handleTurn(ASKED);
  expect(reply.speech).toBe("맡긴 조사가 여러 개예요. ‘아동수당 신청 방법’, ‘기초연금 신청 서류’ 중 어떤 것을 읽어 드릴까요?");
  expect(reply.savedResearch).toBeUndefined();
  expect(desk.read).not.toHaveBeenCalled();
});

it("읽을 수 있는 조사가 넷이면 최근 세 건만 불러 주고, 플래너가 둘을 짚으면 그 둘만 묻는다", async () => {
  const {session} = await open();
  const jobs = ["가", "나", "다", "라"].map((request, i) => savedJob(`job-${i + 1}`, request, {kind: "ready"}));
  session.deps.research = deskOf(jobs);
  withLlm(session, new FakeLlm(readSaved([])));
  expect((await session.handleTurn(ASKED)).speech).toBe("맡긴 조사가 여러 개예요. ‘가’, ‘나’, ‘다’ 중 어떤 것을 읽어 드릴까요?");
  withLlm(session, new FakeLlm(readSaved(["j2", "j4"])));
  expect((await session.handleTurn(ASKED)).speech).toBe("맡긴 조사가 여러 개예요. ‘나’, ‘라’ 중 어떤 것을 읽어 드릴까요?");
});

it.each([
  ["짚은 조사가 아직 조사 중이면 조사하고 있다고", ["j1"], "아직 조사하고 있어요. 끝나면 알려 드릴게요."],
  ["짚은 조사가 끝났지만 읽을 것이 없으면 결과가 없다고", ["j2"], "아직 확인할 조사 결과가 없어요."],
] as const)("%s 알리고 다른 조사를 대신 읽지 않는다", async (_name, jobs, speech) => {
  const {session} = await open();
  const desk = deskOf([savedJob("job-1", "아동수당 신청 방법", {kind: "working"}), savedJob("job-2", "중단한 조사", {kind: "ended"}),
    savedJob("job-3", "기초연금 신청 서류", {kind: "ready"})]);
  session.deps.research = desk;
  withLlm(session, new FakeLlm(readSaved([...jobs])));
  const reply = await session.handleTurn(ASKED);
  expect(reply.speech).toBe(speech);
  expect(reply.savedResearch).toBeUndefined();
  expect(desk.read).not.toHaveBeenCalled();
});

it("공용 기기에서 모델이 저장한 조사를 골라도 저장소를 열지 않고 개인 기기 안내만 한다", async () => {
  const {app, runtime, session: create} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "shared"}));
  const {session} = await create();
  expect(session.deps.research).toBeUndefined();
  const store = vi.spyOn(app.workflows, "store");
  const records = vi.spyOn(session.personalDialogue, "run");
  const model = new FakeLlm(readSaved([]));
  withLlm(session, model);
  const reply = await session.handleTurn(ASKED);
  expect(reply).toMatchObject({intentType: "CLARIFY", speech: "자료 조사를 맡기려면 이용 설정에서 개인 기기를 선택해 주세요."});
  expect(reply.savedResearch).toBeUndefined();
  expect(plannerPayloads(model).map(payload => Object.keys(payload).includes("savedJobs"))).toEqual([false]);
  expect(store).not.toHaveBeenCalled();
  expect(records).not.toHaveBeenCalled();
});

it("모델이 목록에 없는 조사를 가리키면 신청 기록이나 다른 명령으로 넘기지 않고 어느 조사인지 되묻는다", async () => {
  const {session} = await open();
  const desk = deskOf([savedJob("job-1", "기초연금 신청 서류", {kind: "ready"})]);
  session.deps.research = desk;
  const records = vi.spyOn(session.personalDialogue, "run");
  const model = new FakeLlm(readSaved(["j2"]));
  withLlm(session, model);
  const reply = await session.handleTurn(ASKED);
  expect(reply).toMatchObject({intentType: "CLARIFY", speech: "어느 조사를 말씀하시는지 잘 모르겠어요. 맡기신 조사의 주제를 말씀해 주세요."});
  expect(reply.savedResearch).toBeUndefined();
  expect(desk.read).not.toHaveBeenCalled();
  expect(records).not.toHaveBeenCalled();
  expect(model.calls.map(call => call.schemaName)).toEqual(["public_service_decision"]);
});

it("외국어로 말해도 플래너에 맡겨 둔 조사 목록이 가고, 저장한 조사 작업의 플래너에는 가지 않는다", async () => {
  const {session} = await open();
  const desk = deskOf([savedJob("job-1", "기초연금 신청 서류", {kind: "ready"})]);
  session.deps.research = desk;
  session.setLanguage("en");
  const model = new FakeLlm({public_service_decision: {kind: "conversation", reply: "Sure.", ...unusedFields}});
  withLlm(session, model);
  expect((await session.handleTurn("How did the research I asked for turn out?")).speech).toBe("Sure.");
  expect(plannerPayloads(model)).toMatchObject([{replyLanguage: "en", savedJobs: [{ref: "j1", request: "기초연금 신청 서류", state: "ready"}]}]);

  const background = new FakeLlm({public_service_decision: {kind: "clarify", question: "어느 지역인가요?", goal: "기초연금 신청 서류", ...unusedFields}});
  withLlm(session, background);
  desk.recent.mockClear();
  await session.researchPublic("기초연금 신청 서류를 알려줘", "ko");
  const [payload] = plannerPayloads(background);
  expect(payload).toBeDefined();
  expect(Object.keys(payload ?? {})).not.toContain("savedJobs");
  expect(desk.recent).not.toHaveBeenCalled();
});

it("조사 목록을 읽지 못해도 조사와 상관없는 요청은 그대로 답한다", async () => {
  const {session} = await open();
  session.deps.research = {...deskOf([]), recent: async () => { throw new Error("저장소를 열 수 없음"); }};
  const model = new FakeLlm({public_service_decision: {kind: "conversation", reply: "안녕하세요.", ...unusedFields}});
  withLlm(session, model);
  expect((await session.handleTurn("안녕")).speech).toBe("안녕하세요.");
  expect(Object.keys(plannerPayloads(model)[0] ?? {})).not.toContain("savedJobs");
});

it("조사 목록을 읽지 못하면 플래너에 목록을 보내지 않고, 모델이 저장한 조사를 골라도 읽지 않고 어느 조사인지 되묻는다", async () => {
  const {session} = await open();
  const desk = {...deskOf([]), recent: async () => { throw new Error("저장소를 열 수 없음"); }};
  session.deps.research = desk;
  const model = new FakeLlm(readSaved([]));
  withLlm(session, model);
  const reply = await session.handleTurn(ASKED);
  expect(reply).toMatchObject({intentType: "CLARIFY", speech: "어느 조사를 말씀하시는지 잘 모르겠어요. 맡기신 조사의 주제를 말씀해 주세요."});
  expect(Object.keys(plannerPayloads(model)[0] ?? {})).not.toContain("savedJobs");
  expect(desk.read).not.toHaveBeenCalled();
});
