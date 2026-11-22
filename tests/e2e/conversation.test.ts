import { afterAll, afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createMockWelfareProfile, fieldVocabulary } from "../../src/agents/web/profile.ts";
import { INTENTS } from "../../src/core/intents.ts";
import type { TurnResult } from "../../src/core/turn.ts";
import { HELP_POINTER } from "../../src/orchestrator/replies.ts";
import { ALLOWED_WITHOUT_CONSENT } from "../../src/safety/gates.ts";
import { INTENT_JSON_SCHEMA } from "../../src/understanding/llm_planner.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { FakeLlm, fieldValue, PORTAL, withLlm } from "../helpers.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
afterEach(runtime.closeSessions);
afterAll(runtime.close);
async function newSession() { return (await runtime.createBrowserSession()).session; }

it("모델이 데스크톱에서만 마스코트 보기·닫기를 요청하고 실제 결과를 읽는다", async () => {
  const session = await newSession();
  const applied: boolean[] = [];
  session.deps.setAvatarVisible = async value => { applied.push(value); return true; };
  for (const [type, request, speech] of [
    ["HIDE_AVATAR", "곁에 있는 캐릭터가 잠깐 안 보이면 좋겠어", "마스코트를 닫았어요."],
    ["SHOW_AVATAR", "아까 곁에 있던 친구 다시 데려와", "마스코트를 다시 열었어요."],
  ] as const) {
    const llm = new FakeLlm({ intent_plan: { steps: [{type}] } });
    withLlm(session, llm);
    expect((await session.handleTurn(request)).speech).toContain(speech);
    expect(JSON.stringify(llm.calls.find(call => call.schemaName === "intent_plan")?.schema)).toContain(type);
  }
  expect(applied).toEqual([false, true]);
  session.deps.setAvatarVisible = undefined;
  const unavailable = new FakeLlm({intent_plan: {steps: [{type: "SHOW_AVATAR"}]}});
  withLlm(session, unavailable);
  await session.handleTurn("곁에 있던 친구 데려와");
  expect(JSON.stringify(unavailable.calls.find(call => call.schemaName === "intent_plan")?.schema)).not.toContain("SHOW_AVATAR");
});
const rules = new RuleBasedIntentProvider(fieldVocabulary(createMockWelfareProfile("http://localhost:5174")));
const exampleTypes = new Map(INTENTS.flatMap(i => i.examples.map(example => [example.text, i.type] as const)));
/** Python conftest의 flat: 계획 스키마의 모든 칸을 null로 두고 준 칸만 채운다. */
function flat(type: string, fields: Record<string, unknown> = {}) {
  return { ...Object.fromEntries(Object.keys(INTENT_JSON_SCHEMA.schema.properties).map(key => [key, null])), type, ...fields };
}
function chatUtterances(model: FakeLlm) {
  return model.calls.filter(call => call.schemaName === "chat_route")
    .map(call => z.object({ utterance: z.string() }).parse(JSON.parse(call.user)).utterance);
}
function quotes(result: TurnResult) { return [...result.speech.matchAll(/'([^']+)'/gu)].map(match => match[1]!); }
function spoken(result: TurnResult) { return quotes(result).slice(0, -1); }
function assertEachUnderstood(result: TurnResult) {
  const utterances = spoken(result);
  expect(utterances.length).toBeGreaterThan(0);
  for (const utterance of utterances) expect(rules.parseSync(utterance, { state: result.state }).type, utterance).toBe(exampleTypes.get(utterance));
  expect(rules.parseSync(quotes(result).at(-1)!, { state: result.state }).type).toBe("WHAT_CAN_I_SAY");
}

it("test_open_fill_next_in_one_sentence", async () => {
  const session = await newSession();
  const result = await session.handleTurn("장애인연금 신청 도와줘 그리고 이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10, 다음으로 넘어가줘");
  expect(result.intentType).toMatch(/^PLAN\(START_APPLICATION>FILL>NEXT\)$/u);
  expect(fieldValue(result, "applicantName")).toBe("김하늘");
  expect(fieldValue(result, "address")).toBe("부산광역시 예시구 예시로 10");
  expect(result.observation?.step?.index).toBe(2);
  expect(result.speech).toMatch(/^모의 신청서를 열었어요\. 성명에 "김하늘" 넣었어요\./u);
});

it("test_plan_stops_on_clarification", async () => {
  const session = await newSession();
  await session.handleTurn("장애인연금 신청 도와줘");
  const result = await session.handleTurn("주소는 부산, 다음으로 넘어가줘");
  expect(result.state).toBe("NEEDS_CLARIFICATION");
  expect(result.speech).toContain("나머지 1가지 요청은");
  expect(result.observation?.step?.index).toBe(1);
});

it("test_llm_plan_when_rules_cannot_split", async () => {
  const session = await newSession();
  withLlm(session, new FakeLlm({
    intent_plan: {
      steps: [
        {
          type: "FILL",
          fills: [{ fieldMention: "이름", value: "김하늘" }],
          fieldMention: null,
          topic: null,
          text: null,
        },
        {
          type: "FILL",
          fills: [{ fieldMention: "주소", value: "부산광역시 예시구 예시로 10" }],
          fieldMention: null,
          topic: null,
          text: null,
        },
      ],
    },
  }));
  await session.handleTurn("장애인연금 신청 도와줘");
  const result = await session.handleTurn("부산광역시 예시구 예시로 10에 사는 김하늘이에요");
  expect(fieldValue(result, "applicantName")).toBe("김하늘");
  expect(fieldValue(result, "address")).toBe("부산광역시 예시구 예시로 10");
});

it("test_rephrase_without_llm", async () => {
  const session = await newSession();
  const first = await session.handleTurn("장애인연금 신청 도와줘");
  const result = await session.handleTurn("무슨 말이야? 쉽게 말해줘");
  expect(result.semanticAction).toBe("rephrase");
  expect(result.speech).toContain(first.speech.slice(0, 20));
});

it("test_rephrase_with_llm", async () => {
  const session = await newSession();
  withLlm(session, new FakeLlm({ simple: { text: "연습용 신청서를 열었어요. 이름부터 말해 주세요." } }));
  await session.handleTurn("장애인연금 신청 도와줘");
  const result = await session.handleTurn("이해가 안 돼");
  expect(result.speech).toContain("연습용 신청서를 열었어요. 이름부터 말해 주세요.");
});

it("test_rephrase_that_changes_a_number_repeats_the_original", async () => {
  const session = await newSession();
  withLlm(session, new FakeLlm({ chat_route: { route: "general", reply: "1년은 보통 365일이에요.", searchQuery: null }, simple: { text: "1년은 366일이에요." } }));
  await session.handleTurn("1년은 며칠이야");
  const result = await session.handleTurn("쉽게 말해줘");
  expect(result.semanticAction).toBe("rephrase");
  expect(result.speech).not.toContain("366");
  expect(result.speech).toContain("천천히 다시 말씀드릴게요. 1년은 보통 365일이에요.");
  expect(result.trace.some(entry => entry.agent === "answer-verifier" && (entry.note ?? "").includes("366"))).toBe(true);
});

it("test_general_question_then_resume", async () => {
  const session = await newSession();
  withLlm(session, new FakeLlm({ chat_route: { route: "general", reply: "1년은 보통 365일이에요.", searchQuery: null } }));
  await session.handleTurn("장애인연금 신청 도와줘");
  const result = await session.handleTurn("1년은 며칠이야");
  expect(result.semanticAction).toBe("chat");
  expect(result.speech).toContain("1년은 보통 365일이에요. 이어서 성명을 말씀해 주세요");
  expect(result.actions).toEqual([]);
});

it("test_realtime_question_searches_and_grounds", async () => {
  const session = await newSession();
  withLlm(session, new FakeLlm({
    chat_route: { route: "web_search", reply: "", keywords: ["오늘", "날씨"] },
    web_answer: { found: true, answer: "첫 검색 결과는 오늘 날씨 신청 방법이에요.", evidence: ["오늘 날씨 신청 방법"] },
  }));
  const result = await session.handleTurn("오늘 날씨 어때");
  expect(result.semanticAction).toBe("web-answer");
  expect(result.speech).toContain("'오늘 날씨'를 검색해 봤어요. 첫 검색 결과는 오늘 날씨 신청 방법이에요.");
  expect(result.accessMode).toBe("read-only");
  expect(result.actions[0]?.policy.code).toBe("ALLOWED_READ_ONLY");
});

it("test_verifier_blocks_ungrounded_search_answer", async () => {
  const session = await newSession();
  withLlm(session, new FakeLlm({
    chat_route: { route: "web_search", reply: "", keywords: ["오늘", "날씨"] },
    web_answer: { found: true, answer: "오늘은 맑고 기온은 23도예요.", evidence: ["맑음 23도"] },
  }));
  const result = await session.handleTurn("오늘 날씨 어때");
  expect(result.speech).toContain("확실한 답을 확인하지 못했어요");
  expect(result.speech).not.toContain("23도");
  expect(result.trace.some(entry => entry.agent === "answer-verifier" && (entry.note ?? "").includes("근거 부족"))).toBe(true);
});

it("test_welfare_question_not_in_official_data", async () => {
  const session = await newSession();
  withLlm(session, new FakeLlm({
    chat_route: { route: "welfare", reply: "", searchQuery: null },
    grounded_answer: { answerable: false, answer: "", usedChunkIds: [] },
    general_answer: { known: true, answer: "보통 매달 정해진 날에 계좌로 들어와요." },
  }));
  await session.handleTurn("장애인연금 신청 도와줘");
  const result = await session.handleTurn("근데 이 신청하면 언제 돈이 지급돼?");
  expect(result.speech).toContain("공식 자료에는 그 내용이 없어요");
  expect(result.answerCard?.grounded).toBe(false);
  expect(result.speech).not.toContain("보통 매달 정해진 날에 계좌로 들어와요");
  expect(result.speech).toContain("129");
});

it.each([["열어줘", "어느 사이트를 열까요"], ["검색해줘", "무엇을 검색할까요"], ["그거 해줘", "무엇을 할까요"], ["알려줘", "무엇을 알려드릴까요"]])("test_vague_requests_ask_back", async (text, ask) => {
  const session = await newSession();
  const result = await session.handleTurn(text);
  expect(result.semanticAction).toBe("clarify");
  expect(result.speech).toContain(ask);
  expect(result.actions).toEqual([]);
});

it("test_apply_without_service_name_asks", async () => {
  const session = await newSession();
  const result = await session.handleTurn("신청 도와줘");
  expect(result.semanticAction).toBe("clarify");
  expect(result.page).not.toBe("mock-welfare");
});

it("test_welfare_question_without_context_asks_service", async () => {
  const session = await newSession();
  const result = await session.handleTurn("얼마 받을 수 있어?");
  expect(result.speech).toContain("어떤 제도에 대해 궁금하신가요");
  expect(result.speech).not.toContain("장애인연금");
});

it("test_fillers_not_entered_as_name", async () => {
  const session = await newSession();
  await session.handleTurn("장애인연금 신청 도와줘");
  for (const entry of ["음 그냥 좀 도와줄래", "근데 이 신청하면 언제 돈이 지급돼"]) {
    const result = await session.handleTurn(entry);
    expect(result.actions.filter(action => action.action.type === "fill" && action.result?.ok === true)).toEqual([]);
  }
  expect((await session.handleTurn("김하늘")).field).toBe("applicantName");
});

it("test_other_service_context_does_not_open_disability_form", async () => {
  const session = await newSession();
  await session.handleTurn("장애인연금 지원대상 알려줘");
  session.grounded = { servNm: "기초연금", sources: [] };
  const result = await session.handleTurn("신청 도와줘");
  expect(result.semanticAction).toBe("clarify");
  expect(result.speech).toContain("기초연금 연습 신청서는 아직 없어요");
  expect(result.page).not.toBe("mock-welfare");
});

it("test_discover_flow", async () => {
  const session = await newSession();
  const r1 = await session.handleTurn("나한테 맞는 복지 찾아줘");
  expect(r1.speech).toContain("나이");
  expect(r1.speech).toContain("저장하지 않아요");
  await session.handleTurn("일흔 살이에요");
  await session.handleTurn("아니요");
  await session.handleTurn("잘 모르겠어요");
  const r5 = await session.handleTurn("건너뛸게요");
  expect(r5.semanticAction).toBe("discover");
  expect(r5.speech).toMatch(/1번 .+2번 .+3번/u);
  expect(r5.speech).toContain("기관이 판단");
  const pc = await session.handleTurn("1번 자격 확인해줘");
  expect(pc.semanticAction).toBe("precheck");
  expect(pc.speech).toMatch(/최종 자격은 기관이 판단|선정기준을 공식 자료에서 가져오지 못했/u);
  const more = await session.handleTurn("더 알려줘");
  expect(more.speech).toContain("4번");
});

it("test_discover_interrupted_by_other_command", async () => {
  const session = await newSession();
  await session.handleTurn("받을 수 있는 복지 찾아줘");
  const result = await session.handleTurn("도움말");
  expect(result.semanticAction).not.toBe("discover");
});

it("test_no_consecutive_clarify", async () => {
  const session = await newSession();
  const enums: string[][] = [];
  session.deps.llm = new FakeLlm(({ schemaName, schema, system }) => {
    if (schemaName !== "chat_route") return undefined;
    const route = z.object({ properties: z.object({ route: z.object({ enum: z.array(z.string()) }) }) }).parse(schema);
    enums.push(route.properties.route.enum);
    const described = [...system.matchAll(/^- ([a-z_]+):/gmu)].map(match => match[1]);
    for (const name of described) expect(route.properties.route.enum).toContain(name);
    return enums.length === 1 ? { route: "clarify", reply: "(1) 이것 (2) 저것 중 무엇인가요?", searchQuery: null, language: null }
      : { route: "general", reply: "1번으로 할게요.", searchQuery: null, language: null };
  });
  expect((await session.handleTurn("사과 하나 줄래요")).semanticAction).toBe("clarify");
  const result = await session.handleTurn("1번.");
  expect(enums[0]).toContain("clarify");
  expect(enums.at(-1)).not.toContain("clarify");
  expect(result.speech).toBe("1번으로 할게요.");
});

it("test_llm_language_route", async () => {
  const session = await newSession();
  withLlm(session, new FakeLlm({ chat_route: { route: "language", reply: "", searchQuery: null, language: "en" } }));
  const result = await session.handleTurn("잉글리쉬로 좀 부탁해요");
  expect(result.lang).toBe("en");
  expect(result.semanticAction).toBe("set-language");
});

it("test_brief_screen_vs_detailed", async () => {
  const session = await newSession();
  withLlm(session, new FakeLlm({ screen_text_decision: {
    decision: "answer", answer: "복지 소식을 전하는 시험용 포털이에요. 장애인연금 기준액 조정과 신청 방법을 안내해요.",
    evidence: ["올해 장애인연금 기초급여 기준액이 조정되었습니다.", "신청은 주소지 행정복지센터나 온라인으로 할 수 있습니다."],
  } }));
  await session.handleTurn(PORTAL + " 열어줘");
  const result = await session.handleTurn("화면 설명해줘");
  expect(result.speech).toContain("'[테스트] 외부 포털");
  expect(result.speech).toContain("장애인연금 기준액 조정과 신청 방법을 안내해요");
  expect(result.speech).not.toContain("누를 수 있는 버튼");
  expect(result.speech).not.toContain("링크:");
  const full = await session.handleTurn("화면 자세히 설명해줘");
  expect(full.speech).toContain("화면 전체를 위에서부터 설명합니다");
});

it("test_summary_with_unknown_number_dropped", async () => {
  const session = await newSession();
  withLlm(session, new FakeLlm({ screen_text_decision: {
    decision: "answer", answer: "기준액이 50만 원으로 올랐어요.", evidence: ["올해 장애인연금 기초급여 기준액이 조정되었습니다."],
  } }));
  await session.handleTurn(PORTAL + " 열어줘");
  const result = await session.handleTurn("화면 설명해줘");
  expect(result.speech).not.toContain("50만");
  expect(result.speech).toContain("내용은 \"");
});

it("test_real_site_login_moves_explains_asks_then_clicks", async () => {
  const { session, page } = await runtime.createBrowserSession();
  await session.handleTurn(PORTAL + " 열어줘");
  const ask = await session.handleTurn("로그인하고 싶어");
  expect(ask.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  for (const phrase of ["'로그인하고 싶어'라고 하셔서", "이동했어요", "'눌러'"]) expect(ask.speech).toContain(phrase);
  expect(ask.actions.map(a => a.action.type)).toEqual(["focus"]);
  expect(ask.observation?.url).not.toContain("/login.html");
  const opened = await session.handleTurn("눌러");
  expect(opened.state).toBe("AUTH_HANDOFF");
  expect(opened.observation?.url).toContain("/login.html");
  for (const phrase of ["비밀번호", "직접", "다 입력했어"]) expect(opened.speech).toContain(phrase);
  expect(opened.actions.some(a => a.action.type === "focus" && a.action.target?.fieldId === "loginId" && a.result?.ok === true)).toBe(true);
  const empty = await session.handleTurn("다 입력했어");
  expect(empty.state).toBe("AUTH_HANDOFF");
  expect(empty.actions).toEqual([]);
  await page.locator("#loginId").fill("synthetic-id");
  await page.locator("#loginPassword").fill("synthetic-test-password");
  const submit = await session.handleTurn("네, 다 입력했어요.");
  expect(submit.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(submit.speech).toContain("'모의 로그인'");
  const keeping = await session.handleTurn("취소하지 마세요");
  expect(keeping.pendingConfirmation?.actionId).toBe(submit.pendingConfirmation?.actionId);
  expect(keeping.authHandoff?.status).toBe("waiting");
  expect(keeping.actions).toEqual([]);
  const done = await session.handleTurn("눌러");
  const click = done.actions.filter(a => a.action.type === "click").at(-1);
  expect(click?.policy.code).toBe("APPROVED");
  expect(click?.result?.ok).toBe(true);
  expect([ask, opened, submit, done].flatMap(r => r.actions).filter(a => ["fill", "select", "check"].includes(a.action.type))).toEqual([]);
});

it("test_real_site_login_rejected_clicks_nothing", async () => {
  const session = await newSession();
  await session.handleTurn(PORTAL + " 열어줘");
  await session.handleTurn("로그인 화면 열어줘");
  const result = await session.handleTurn("거절");
  expect(result.speech).toContain("누르지 않았어요");
  expect(result.observation?.url).not.toContain("/login.html");
});

it("test_auth_done_stays_while_login_page_unchanged", async () => {
  const session = await newSession();
  const handed = await session.handleTurn("로그인하고 싶어");
  expect(handed.state).toBe("AUTH_HANDOFF");
  expect(handed.observation?.url).toContain("/login.html");
  expect(handed.actions.some(action => action.action.type === "focus" && action.action.target?.fieldId === "loginId" && action.result?.ok === true)).toBe(true);
  const still = await session.handleTurn("다 했어");
  expect(still.intentType).toBe("AUTH_DONE");
  expect(still.state).toBe("AUTH_HANDOFF");
  expect(still.observation?.url).toContain("/login.html");
  expect(still.speech).toContain("아직");
  expect(still.speech.includes("로그인") || still.speech.includes("인증")).toBe(true);
});

it("test_auth_negation_keeps_the_original_handoff", async () => {
  const session = await newSession();
  const handed = await session.handleTurn("로그인하고 싶어");
  const handoffId = handed.authHandoff?.id;
  expect(handoffId).toBeDefined();
  for (const phrase of ["I'm not done yet", "인증 취소하지 마세요", "Please don't cancel", "cancel?", "취소?"]) {
    const reply = await session.handleTurn(phrase);
    expect([reply.state, reply.authHandoff?.id, reply.authHandoff?.status]).toEqual(["AUTH_HANDOFF", handoffId, "waiting"]);
    expect(reply.intentType).not.toBe("AUTH_DONE");
    expect(reply.actions).toEqual([]);
  }
  const cancelled = await session.handleTurn("인증 취소");
  expect(cancelled.authHandoff?.status).toBe("cancelled");
});

it("test_auth_done_speaks_title_and_resumes_pending_form", async () => {
  const { session, page } = await runtime.createBrowserSession();
  const opened = await session.handleTurn("장애인연금 신청 도와줘");
  expect(opened.state).toBe("APPLICATION_OPEN");
  const handed = await session.handleTurn("로그인하고 싶어");
  expect(handed.state).toBe("AUTH_HANDOFF");
  expect(handed.observation?.url).toContain("/login.html");
  expect(session.dialogue.authResume).toEqual({ kind: "form" });
  const still = await session.handleTurn("다 했어");
  expect(still.state).toBe("AUTH_HANDOFF");
  expect(session.dialogue.authResume).toEqual({ kind: "form" });
  expect(still.speech).toContain("아직");
  await page.goto("http://localhost:5174/apply.html", { waitUntil: "domcontentloaded" });
  const done = await session.handleTurn("인증 끝났어");
  expect(done.intentType).toBe("AUTH_DONE");
  expect(done.state).toBe("APPLICATION_OPEN");
  expect(done.speech).toContain("화면으로 바뀌었어요");
  expect(done.speech.includes("모의") || done.speech.includes("신청")).toBe(true);
  expect(session.dialogue.authResume).toBeUndefined();
  expect(session.dialogue.awaiting).toBe("applicantName");
});

it("test_main_screen_opens_site_home", async () => {
  const session = await newSession();
  await session.handleTurn("127.0.0.1:5174/external2.html 열어줘");
  const result = await session.handleTurn("메인 화면 눌러줘");
  expect(result.observation?.url).toBe("http://127.0.0.1:5174/");
});

it("test_custom_named_link_is_follow_link", async () => {
  const session = await newSession();
  await session.handleTurn(PORTAL + " 열어줘");
  const result = await session.handleTurn("맞춤형 급여 안내 눌러줘");
  expect(result.intentType).toBe("FOLLOW_LINK");
});

it("test_short_replies_not_values", async () => {
  const session = await newSession();
  const opened = await session.handleTurn("장애인연금 신청 도와줘");
  expect(opened.speech).toContain("성명을 말씀해 주세요");
  const ok = await session.handleTurn("알았어");
  expect(ok.speech).toContain("성명을 말씀해 주세요");
  expect(fieldValue(ok, "applicantName")).toBe("");
  const no = await session.handleTurn("아니");
  expect(no.speech).toContain("비워 둘게요");
  expect(fieldValue(no, "applicantName")).toBe("");
  const name = await session.handleTurn("알았고 이름은 김하늘");
  expect(fieldValue(name, "applicantName")).toBe("김하늘");
});

it("test_called_by_name", async () => {
  const session = await newSession();
  const opened = await session.handleTurn("청음아, 장애인연금 신청 도와줘");
  expect(opened.speech).toContain("성명을 말씀해 주세요");
  const called = await session.handleTurn("청음아");
  expect(called.speech).toBe("네, 말씀하세요.");
  expect(fieldValue(called, "applicantName")).toBe("");
  const name = await session.handleTurn("청음아 이름은 김하늘");
  expect(fieldValue(name, "applicantName")).toBe("김하늘");
  const stopped = await session.handleTurn("청음아 멈춰");
  expect(stopped.state).toBe("STOPPED");
});

it("test_multiple_questions", async () => {
  const session = await newSession();
  const questions = ["1년은 며칠이야?", "하루는 몇 시간이야?"];
  const model = new FakeLlm({
    intent_plan: { steps: questions.map(question => flat("UNKNOWN", { text: question })) },
    chat_route: { route: "general", reply: "답이에요.", searchQuery: null, language: null },
  });
  withLlm(session, model);
  const result = await session.handleTurn("1년은 며칠이고 하루는 몇 시간이야?");
  expect(result.intentType).toBe("PLAN(UNKNOWN>UNKNOWN)");
  expect(result.speech).toBe("1. 답이에요. 2. 답이에요.");
  expect(chatUtterances(model)).toEqual(questions);
});

it.each([false, true])("test_planned_subquestion_is_not_a_numbered_click", async includesPlaceholder => {
  const { session, page } = await runtime.createBrowserSession();
  await session.handleTurn(PORTAL + " 열어줘");
  await session.handleTurn("링크 목록 알려줘");
  const before = page.url();
  const request = "첫 항목의 뜻과 운영자가 궁금해요";
  const model = new FakeLlm({
    intent_plan: { steps: [flat("UNKNOWN", { text: "1번은 무슨 뜻인가요?" }), flat("UNKNOWN", { text: includesPlaceholder ? request : "누가 운영하나요?" })] },
    chat_route: { route: "general", reply: "설명이에요." },
  });
  withLlm(session, model);
  const answer = await session.handleTurn(request);
  expect(answer.actions).toEqual([]);
  expect(page.url()).toBe(before);
  expect(answer.speech).toBe(includesPlaceholder ? "설명이에요." : "1. 설명이에요. 2. 설명이에요.");
  expect(chatUtterances(model)[0]).toBe("1번은 무슨 뜻인가요?");
});

it("test_real_site_mode", async () => {
  const session = await newSession();
  session.deps.practiceMode = false;
  const real = await session.handleTurn("장애인연금 신청 도와줘");
  expect(real.observation).not.toHaveProperty("step");
  expect(real.semanticAction).toBe("agent-handoff");
  const practice = await session.handleTurn("장애인연금 연습 신청 도와줘");
  expect(practice.observation?.step?.index).toBe(1);
});

type PlannedType = "READ_MAIN" | "LIST_LINKS" | "SEARCH" | "FOLLOW_LINK" | "REPHRASE" | "SERVICE_DETAIL";
const planned: Record<PlannedType, [string, { topic?: string; more?: boolean }][]> = {
  READ_MAIN: [["이 페이지 내용 좀 들려줄래", { more: false }], ["기사 마저 읽어", { more: true }],
    ["본문 읽어줘", { more: false }], ["그 다음 내용은?", { more: true }]],
  LIST_LINKS: [["여기 누를 수 있는 거 뭐 있어", { more: false }], ["어떤 메뉴가 있어", { more: false }], ["링크 목록 알려줘", { more: false }]],
  SEARCH: [["기초연금으로 검색해 볼래", { topic: "기초연금" }], ["검색창에 기초연금 쳐줘", { topic: "기초연금" }], ["기초연금 검색해줘", { topic: "기초연금" }]],
  FOLLOW_LINK: [["공지사항으로 가자", { topic: "공지사항" }], ["공지사항 들어가 볼래", { topic: "공지사항" }], ["공지사항 눌러줘", { topic: "공지사항" }]],
  REPHRASE: [["무슨 소리야", {}], ["좀 더 쉽게", {}], ["쉽게 말해줘", {}]],
  SERVICE_DETAIL: [["첫 번째 거 자세히 알려줘", { topic: "1번" }], ["두 번째 제도 설명해줘", { topic: "2번" }], ["2번 자세히 알려줘", { topic: "2번" }]],
};

it.each(Object.keys(planned) as PlannedType[])("test_planner_understands_what_rules_miss", async (want) => {
  const session = await newSession();
  await session.handleTurn(PORTAL + " 열어줘");
  const replies = new Map(planned[want].map(([utterance, slots]) => [utterance,
    { ...Object.fromEntries(INTENT_JSON_SCHEMA.schema.required.map(k => [k, null])), type: want, ...slots }]));
  withLlm(session, new FakeLlm(({ schemaName, user }) => schemaName === "intent_plan"
    ? { steps: [replies.get(z.object({ utterance: z.string() }).parse(JSON.parse(user)).utterance)] } : undefined));
  for (const utterance of replies.keys()) expect((await session.handleTurn(utterance)).intentType, utterance).toBe(want);
});

it("test_help_on_form_starts_with_form_examples", async () => {
  const session = await newSession();
  await session.handleTurn("장애인연금 신청 도와줘");
  const first = await session.handleTurn("뭐라고 말하면 돼?");
  expect(first.intentType).toBe("WHAT_CAN_I_SAY");
  expect(first.semanticAction).toBe("help-list");
  expect(first.state).toBe("APPLICATION_OPEN");
  expect(first.speech.startsWith("이렇게 말해 보세요. 신청서: ")).toBe(true);
  expect(first.actions).toEqual([]);
  assertEachUnderstood(first);
  const more = await session.handleTurn("다른 말도 알려줘");
  expect(more.speech.startsWith("이어서 알려 드릴게요. 신청서: ")).toBe(true);
  assertEachUnderstood(more);
  expect(spoken(first).filter(text => spoken(more).includes(text))).toEqual([]);
  expect(spoken(await session.handleTurn("도움말"))).toEqual(spoken(first));
});

it("test_help_on_web_page_starts_with_web_reading", async () => {
  const session = await newSession();
  await session.handleTurn(PORTAL + " 열어줘");
  const result = await session.handleTurn("뭘 할 수 있어?");
  expect(result.speech.startsWith("이렇게 말해 보세요. 웹 읽기: ")).toBe(true);
  assertEachUnderstood(result);
});

it("test_help_until_nothing_left", async () => {
  const session = await newSession();
  let result = await session.handleTurn("도움말");
  const heard = new Set(spoken(result));
  while (result.speech.includes("다른 말도 알려줘")) {
    result = await session.handleTurn("다른 말도 알려줘");
    for (const text of spoken(result)) {
      expect(heard.has(text), text).toBe(false);
      heard.add(text);
    }
  }
  expect(heard).toEqual(new Set(INTENTS.filter(i => i.help !== undefined).map(i => i.examples[0].text)));
  expect((await session.handleTurn("다른 말도 알려줘")).speech).toContain("더 알려 드릴 말은 없어요");
});

it("test_help_before_consent", async () => {
  const { session } = await runtime.createBrowserSession({ requireConsent: true });
  const result = await session.handleTurn("뭐라고 말하면 돼?");
  expect(result.semanticAction).toBe("help-list");
  expect(result.speech).toContain("동의하시면");
  assertEachUnderstood(result);
  for (const text of spoken(result)) expect(ALLOWED_WITHOUT_CONSENT.has(exampleTypes.get(text)!)).toBe(true);
});

it("test_help_while_stopped_gets_stop_reply", async () => {
  const session = await newSession();
  await session.handleTurn("멈춰");
  const result = await session.handleTurn("뭐라고 말하면 돼?");
  expect(result.state).toBe("STOPPED");
  expect(result.speech).toContain("중단 상태");
  expect(result.semanticAction).not.toBe("help-list");
});

it("test_not_understood_points_to_help", async () => {
  const session = await newSession();
  const result = await session.handleTurn("블라블라");
  expect(result.speech.endsWith(HELP_POINTER)).toBe(true);
});

it("test_captcha_handoff_blocks_automation_and_checks_expected_screen", async () => {
  const { session, page } = await runtime.createBrowserSession();
  await session.handleTurn(PORTAL + " 열어줘");
  const url = "http://127.0.0.1:5174/pilot-captcha.html";
  await page.route(url, route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: "<title>사람 확인</title><h1>보안문자 확인</h1><label>보안문자 <input></label>",
  }));
  const opened = await session.handleTurn(url + " 열어줘");
  const handoff = opened.authHandoff;
  expect(handoff?.kind).toBe("captcha");
  expect(handoff?.status).toBe("waiting");
  for (const command of ["이름 칸에 김하늘 입력해줘", "화면 사진으로 설명해줘", "신청해줘"]) {
    const blocked = await session.handleTurn(command);
    expect(blocked.authHandoff?.id).toBe(handoff?.id);
    expect(blocked.actions).toEqual([]);
  }
  await page.goto("http://127.0.0.1:5174/external2.html");
  expect((await session.handleTurn("다 했어")).authHandoff?.status).toBe("waiting");
  await page.goto("http://" + PORTAL);
  expect((await session.handleTurn("다 했어")).authHandoff?.status).toBe("completed");
});

it("test_handoff_expiry_cancellation_and_browser_loss", async () => {
  let now = 0;
  const expiring = await newSession();
  expiring.deps.clock = () => now;
  const first = await expiring.handleTurn("로그인하고 싶어");
  now = 600;
  const expired = await expiring.handleTurn("다 했어");
  expect(expired.authHandoff?.id).toBe(first.authHandoff?.id);
  expect(expired.authHandoff?.status).toBe("expired");
  expect(expired.actions).toEqual([]);
  const cancelling = await newSession();
  expect((await cancelling.handleTurn("로그인하고 싶어")).authHandoff?.status).toBe("waiting");
  expect((await cancelling.handleTurn("인증 취소")).authHandoff?.status).toBe("cancelled");
  const { session: losing, page } = await runtime.createBrowserSession();
  expect((await losing.handleTurn("로그인하고 싶어")).authHandoff?.status).toBe("waiting");
  await page.close();
  expect((await losing.handleTurn("다 했어")).authHandoff?.status).toBe("interrupted");
});

it("test_genuine_access_block_gives_official_alternative", async () => {
  const { session, page } = await runtime.createBrowserSession();
  const url = "http://127.0.0.1:5174/pilot-access-block.html";
  await page.route(url, route => route.fulfill({ contentType: "text/html", body: "<title>Access denied</title><h1>Access denied</h1>" }));
  const blocked = await session.handleTurn(url + " 열어줘");
  expect(blocked.speech).toContain("129");
  expect(blocked.speech).toContain("공식 문의");
  expect(blocked.state).not.toBe("AUTH_HANDOFF");
});
