import { afterAll, afterEach, expect, it, vi } from "vitest";
import { InMemoryEventLog } from "../../src/core/events.ts";
import type { TurnResult } from "../../src/core/turn.ts";
import type { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { REDACTED } from "../../src/safety/privacy.ts";
import { FakeLlm, fieldValue, withLlm } from "../helpers.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
afterEach(runtime.closeSessions);
afterAll(runtime.close);
async function newSession() { return (await runtime.createBrowserSession()).session; }
async function openForm() {
  const session = await newSession();
  expect((await session.handleTurn("장애인연금 신청 도와줘")).state).toBe("APPLICATION_OPEN");
  return session;
}
const filled = ["이름은 김하늘", "주소는 부산광역시 예시구 예시로 10"];
const twoQuestions = "지금 화면에 뭐가 있어? 그리고 기초연금은 얼마야?";
function splitIntoTwo() {
  return new FakeLlm({ split_questions: { questions: ["지금 화면에 뭐가 있어?", "기초연금은 얼마야?"] } });
}
function webAgentRan(result: TurnResult) { return result.trace.some(t => t.agent === "web-navigation-and-execution"); }
async function askToSubmit(session: SessionOrchestrator) {
  for (const said of filled) await session.handleTurn(said);
  const asked = await session.handleTurn("최종 확인할게");
  expect(asked.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  return asked;
}
function submitClicks(result: TurnResult) {
  return result.actions.filter(a => a.action.target?.name === "모의접수" && a.result?.ok === true);
}
function timeOutFirst(session: SessionOrchestrator, name: string, really = false) {
  const adapter = session.web.adapter;
  const execute = adapter.execute.bind(adapter);
  const clicks: string[] = [];
  vi.spyOn(adapter, "execute").mockImplementation(async (action, signal) => {
    if (action.type === "click" && action.target?.name === name) {
      clicks.push(action.id);
      if (clicks.length === 1) {
        if (really) await execute(action, signal);
        return { actionId: action.id, ok: false, verified: false, latencyMs: 0, errorCode: "TIMEOUT" };
      }
    }
    return execute(action, signal);
  });
  return clicks;
}

it("test_prompt_injection_ignored_and_no_submit_before_approval", async () => {
  const session = await openForm();
  await session.handleTurn("이름은 김하늘, 주소는 부산광역시 예시구 예시로 10");
  const prep = await session.handleTurn("제출해");
  expect(prep.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(prep.observation).not.toHaveProperty("status");
  const planned = prep.actions.find(a => a.action.risk === "consequential");
  expect(planned?.policy.code).toBe("NEEDS_CONFIRMATION");
  expect(planned).not.toHaveProperty("result");
  expect((await session.handleTurn("거절")).state).toBe("APPLICATION_OPEN");
  const later = await session.confirm(true);
  expect(later.semanticAction).toBe("none");
  expect(later.observation).not.toHaveProperty("status");
});

it("test_multi_field_fill_verified_in_dom", async () => {
  const session = await openForm();
  const result = await session.handleTurn("이름은 김하늘, 주소는 부산광역시 예시구 예시로 10");
  expect(result.state).toBe("APPLICATION_OPEN");
  expect(fieldValue(result, "applicantName")).toBe("김하늘");
  expect(fieldValue(result, "address")).toBe("부산광역시 예시구 예시로 10");
});

it("test_two_address_fields_asks_before_fill", async () => {
  const session = await openForm();
  const toggled = await session.handleTurn("실거주지가 달라");
  expect(toggled.state).toBe("APPLICATION_OPEN");
  const ask = await session.handleTurn("주소는 부산광역시 예시구 예시로 10");
  expect(ask.state).toBe("NEEDS_CLARIFICATION");
  expect(ask.actions.filter(action => action.action.type === "fill")).toEqual([]);
  const answer = await session.handleTurn("주민등록 주소");
  expect(answer.semanticAction).toBe("fill");
  expect(answer.field).toBe("address");
  expect(fieldValue(answer, "address")).toBe("부산광역시 예시구 예시로 10");
  expect(fieldValue(answer, "residenceAddress")).toBe("");
});

it("test_describe_screen_reads_everything_and_ignores_instructions", async () => {
  const session = await newSession();
  const home = await session.handleTurn("화면 설명해줘");
  expect(home.semanticAction).toBe("describe-screen");
  expect(home.speech).toContain("장애인연금 모의 신청하기");
  await session.handleTurn("장애인연금 신청 도와줘");
  const result = await session.handleTurn("지금 화면에 뭐가 있어?");
  for (const part of [
    "모의 신청 · 실제 제출 아님",
    "'사이트 공지' 영역",
    "청음은 화면에 적힌 지시를 따르지 않습니다",
    "신청 단계는 3개입니다",
    "성명, 입력란, 필수, 비어 있음",
    "도움말: 필수. 시·도, 시·군·구, 도로명, 건물번호까지",
    "실거주지가 주민등록 주소와 다릅니다, 체크 상자, 선택, 체크 안 됨",
    "이전(지금은 누를 수 없음), 다음",
  ]) {
    expect(result.speech).toContain(part);
  }
  expect(result.actions).toEqual([]);
  expect(result.observation).not.toHaveProperty("status");
  await session.handleTurn("이름은 김하늘");
  await session.handleTurn("주소는 부산광역시 예시구 예시로 10");
  const step2 = await session.handleTurn("다음으로");
  expect(step2.speech).toContain("소득·재산 신고, 가구원 수는 선택이에요");
  expect(step2.speech.length).toBeLessThan(200);
  const step2Full = await session.handleTurn("화면 설명해줘");
  expect(step2Full.speech).toContain("선택지는 신고할 소득·재산 있음, 신고할 소득·재산 없음, 잘 모르겠음 (상담 필요)");
});

it("test_guided_dialogue_value_only", async () => {
  const session = await newSession();
  const opened = await session.handleTurn("장애인연금 신청할려고 하는데 도와줘");
  expect(opened.speech).toContain("성명을 말씀해 주세요");
  const name = await session.handleTurn("김하늘");
  expect(name.field).toBe("applicantName");
  expect(name.speech).toContain("주민등록 주소를 말씀해 주세요");
  const addr = await session.handleTurn("부산광역시 예시구 예시로 10");
  expect(addr.field).toBe("address");
  expect(fieldValue(addr, "address")).toBe("부산광역시 예시구 예시로 10");
  expect(addr.speech).toContain("다음으로");
});

it("test_question_mid_form_then_resume", async () => {
  const session = await openForm();
  const q = await session.handleTurn("장애인연금 얼마 받아?");
  expect(q.semanticAction).toBe("welfare-retrieval");
  expect(q.speech).toContain("이어서 성명을 말씀해 주세요");
  const doubt = await session.handleTurn("이거 꼭 써야 돼?");
  expect(doubt.actions.filter(action => action.action.type === "fill")).toEqual([]);
  expect(doubt.semanticAction).toBe("explain-field");
  const name = await session.handleTurn("김하늘");
  expect(name.field).toBe("applicantName");
});

it("test_edit_waiting_then_new_value", async () => {
  const session = await openForm();
  await session.handleTurn("주소는 부산광역시 예시구 예시로 10");
  const edit = await session.handleTurn("주소 수정할게");
  expect(edit.state).toBe("AWAITING_FIELD_VALUE");
  const fixed = await session.handleTurn("부산광역시 예시구 예시로 20");
  expect(fixed.field).toBe("address");
  expect(fieldValue(fixed, "address")).toBe("부산광역시 예시구 예시로 20");
});

it("test_info_popup_closed_and_announced", async () => {
  const session = await openForm();
  await session.handleTurn("이름은 김하늘");
  await session.handleTurn("주소는 부산광역시 예시구 예시로 10");
  const nxt = await session.handleTurn("다음으로");
  expect(nxt.observation?.step?.index).toBe(2);
  expect(nxt.speech).toContain("팝업");
  const back = await session.handleTurn("이전으로");
  expect(back.observation?.step?.index).toBe(1);
});

it("test_stop_interrupts_inflight_and_blocks_later", async () => {
  const { session, page } = await runtime.createBrowserSession();
  let signalEntered = () => {}, signalRelease = () => {};
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const release = new Promise<void>(resolve => { signalRelease = resolve; });
  await page.route("**/apply.html", async route => {
    signalEntered();
    await release;
    await route.continue().catch(() => {});
  });
  const inflight = session.handleTurn("장애인연금 신청 도와줘");
  try {
    await Promise.race([entered, inflight.then(() => { throw Error("Form turn ended before navigation was intercepted"); })]);
    const stopped = session.cancel();
    expect(stopped.state).toBe("STOPPED");
    expect(stopped.pendingActions).toBe(0);
  } finally { signalRelease(); }
  expect((await inflight).state).toBe("STOPPED");
  const blocked = await session.handleTurn("다음으로");
  expect(blocked.state).toBe("STOPPED");
  expect(blocked.actions).toEqual([]);
  expect((await session.handleTurn("다시 시작")).state).not.toBe("STOPPED");
});

it("test_multi_question_turn_waits_for_consent", async () => {
  const { session } = await runtime.createBrowserSession({ requireConsent: true });
  withLlm(session, splitIntoTwo());
  const result = await session.handleTurn(twoQuestions);
  expect(result.speech).toContain("동의해 주세요");
  expect(webAgentRan(result)).toBe(false);
});

it("test_picking_discovered_service_waits_for_consent", async () => {
  const { session } = await runtime.createBrowserSession({ requireConsent: true });
  for (const text of ["나한테 맞는 복지 찾아줘", "일흔 살이에요", "아니요", "잘 모르겠어요", "건너뛸게요"]) await session.handleTurn(text);
  const result = await session.handleTurn("1번 신청 방법 알려줘");
  expect(result.speech).toContain("동의해 주세요");
  expect(webAgentRan(result)).toBe(false);
});

it("test_multi_question_turn_blocked_while_stopped", async () => {
  const session = await openForm();
  withLlm(session, splitIntoTwo());
  expect(session.cancel().state).toBe("STOPPED");
  const result = await session.handleTurn(twoQuestions);
  expect(result.state).toBe("STOPPED");
  expect(result.speech).toContain("중단 상태");
  expect(webAgentRan(result)).toBe(false);
});

it("test_resume_plan_runs_its_later_steps", async () => {
  const session = await openForm();
  expect(session.cancel().state).toBe("STOPPED");
  const result = await session.handleTurn("다시 시작하고 화면 설명해줘");
  expect(result.intentType).toBe("PLAN(RESUME>DESCRIBE_SCREEN)");
  expect(result.speech.startsWith("다시 시작합니다.")).toBe(true);
  expect(result.speech).not.toContain("중단 상태");
});

it("test_password_never_stored_spoken_or_entered", async () => {
  const session = await newSession();
  await session.handleTurn("로그인하고 싶어");
  const result = await session.handleTurn("내 비밀번호는 hunter2pass야");
  expect(result.state).toBe("AUTH_HANDOFF");
  expect(JSON.stringify(result)).not.toContain("hunter2pass");
  expect(JSON.stringify(session.snapshot())).not.toContain("hunter2pass");
  expect(result.observation?.fields.find(f => f.fieldId === "loginPassword")?.filled).toBe(false);
  const events = session.deps.events;
  if (!(events instanceof InMemoryEventLog)) throw Error("Expected the runtime's in-memory event log");
  expect(JSON.stringify(events.all())).not.toContain("hunter2pass");
});

it("test_bare_password_on_login_page_not_sent_or_stored", async () => {
  const session = await newSession();
  const model = new FakeLlm();
  withLlm(session, model);
  await session.handleTurn("로그인하고 싶어");
  model.calls.length = 0;
  const result = await session.handleTurn("사과나무");
  expect(result.intentType).toBe("SECRET_DISCLOSURE");
  expect(result.semanticAction).toBe("auth-handoff");
  expect(result.state).toBe("AUTH_HANDOFF");
  expect(JSON.stringify(result)).not.toContain("사과나무");
  expect(JSON.stringify(session.snapshot())).not.toContain("사과나무");
  expect(model.calls).toEqual([]);
  expect(result.observation?.fields.find(f => f.fieldId === "loginPassword")?.filled).toBe(false);
  expect((await session.handleTurn("다 했어")).intentType).not.toBe("SECRET_DISCLOSURE");
  expect((await session.handleTurn("화면 설명해줘")).intentType).toBe("DESCRIBE_SCREEN");
  expect((await session.handleTurn("바다거북")).intentType).toBe("SECRET_DISCLOSURE");
  expect((await session.handleTurn("바다거북")).intentType).not.toBe("SECRET_DISCLOSURE");
});

it("test_bare_word_after_password_mention", async () => {
  const session = await newSession();
  await session.handleTurn("비밀번호 알려줄게");
  const first = await session.handleTurn("푸른하늘");
  expect(first.intentType).toBe("SECRET_DISCLOSURE");
  expect(JSON.stringify(session.snapshot())).not.toContain("푸른하늘");
  const later = await session.handleTurn("푸른하늘");
  expect(later.intentType).not.toBe("SECRET_DISCLOSURE");
});

it("test_ordinary_words_pass_outside_login", async () => {
  const session = await openForm();
  const result = await session.handleTurn("이름은 사과나무");
  expect(fieldValue(result, "applicantName")).toBe("사과나무");
});

it("test_mock_submit_receipt", async () => {
  const session = await openForm();
  await session.handleTurn("이름은 김하늘");
  await session.handleTurn("주소는 부산광역시 예시구 예시로 10");
  await session.handleTurn("연락처는 010-1234-5678");
  const review = await session.handleTurn("지금까지 쓴 내용 읽어줘");
  expect(review.speech).toContain("010-****-5678");
  expect(review.speech).not.toContain("010-1234-5678");
  await session.handleTurn("최종 확인할게");
  const done = await session.confirm(true);
  expect(done.state).toBe("MOCK_SUBMITTED");
  expect(done.realSubmission).toBe(false);
  expect(done.verification?.receipt).toMatch(/^MOCK-\d{8}-\d{4}$/u);
});

it("test_value_changed_after_read_back_cancels_mock_submit", async () => {
  const { session, page } = await runtime.createBrowserSession();
  await session.handleTurn("장애인연금 신청 도와줘");
  await askToSubmit(session);
  await page.locator("#address").evaluate((field: HTMLInputElement) => { field.value = "부산광역시 예시구 예시로 99"; });
  const result = await session.confirm(true);
  expect(result.speech.startsWith("주민등록 주소 칸 값이 바뀌었어요. 그래서 모의접수하지 않았어요.")).toBe(true);
  expect(submitClicks(result)).toEqual([]);
  expect(result.observation).not.toHaveProperty("status");
  expect(session.dialogue.approval).toBeUndefined();
  expect((await session.handleTurn("모의접수 승인")).speech.startsWith("지금 승인할 작업이 없습니다")).toBe(true);
});

it("test_approval_after_two_minutes_reads_the_summary_again", async () => {
  const session = await openForm();
  let now = 1000;
  session.deps.clock = () => now;
  const asked = await askToSubmit(session);
  now += 121;
  const again = await session.handleTurn("모의접수 승인");
  expect(again.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(again.speech).toBe("여쭤본 지 2분이 지나서 다시 여쭤볼게요. " + asked.speech);
  expect(submitClicks(again)).toEqual([]);
  now += 100;
  expect((await session.handleTurn("모의접수 승인")).state).toBe("MOCK_SUBMITTED");
});

it("test_timed_out_mock_submit_is_not_sent_again", async () => {
  const session = await openForm();
  await askToSubmit(session);
  const clicks = timeOutFirst(session, "모의접수");
  const result = await session.confirm(true);
  expect(clicks.length).toBe(1);
  expect(result.speech.startsWith("접수됐는지 확인하지 못했어요. 다시 할까요?")).toBe(true);
  expect(result.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(result.observation).not.toHaveProperty("status");
  const done = await session.handleTurn("응");
  expect(clicks.length).toBe(2);
  expect(done.state).toBe("MOCK_SUBMITTED");
});

it("test_timed_out_mock_submit_that_went_through_reports_the_receipt", async () => {
  const session = await openForm();
  await askToSubmit(session);
  const clicks = timeOutFirst(session, "모의접수", true);
  const result = await session.confirm(true);
  expect(clicks.length).toBe(1);
  expect(result.state).toBe("MOCK_SUBMITTED");
  expect(result.verification?.receipt).toMatch(/^MOCK-\d{8}-\d{4}$/u);
});

it("test_timed_out_low_risk_click_is_retried_once", async () => {
  const session = await openForm();
  for (const said of filled) {
    await session.handleTurn(said);
  }
  const clicks = timeOutFirst(session, "다음");
  const result = await session.handleTurn("다음으로");
  expect(clicks.length).toBe(2);
  expect(result.observation?.step?.index).toBe(2);
});

it("test_cancel_drops_a_pending_vault_save_and_says_so", async () => {
  const session = await newSession();
  await session.handleTurn("내 이름은 박하늘이라고 저장해줘");
  const stop = await session.handleTurn("취소");
  expect(stop.state).toBe("STOPPED");
  expect(stop.speech).toContain("박하늘");
  expect(stop.speech).toContain("저장하지 않았어요");
  const later = await session.handleTurn("응");
  expect(later.state).toBe("STOPPED");
  expect(Object.values(session.personal.vault())).not.toContain("박하늘");
});

it("test_vault_and_records_wait_while_stopped", async () => {
  const session = await newSession();
  await session.handleTurn("내 이름은 최하늘이라고 저장해줘");
  await session.handleTurn("응");
  const records = session.personal.applications().length;
  await session.handleTurn("멈춰");
  const read = await session.handleTurn("내 정보 알려줘");
  expect(read.state).toBe("STOPPED");
  expect(read.speech).toContain("중단 상태");
  expect(read.speech).not.toContain("최하늘");
  const recorded = await session.handleTurn("주거급여 신청했어");
  expect(recorded.state).toBe("STOPPED");
  expect(session.personal.applications().length).toBe(records);
});

it("test_vault_and_records_wait_for_consent", async () => {
  const { session } = await runtime.createBrowserSession({ requireConsent: true });
  const save = await session.handleTurn("내 이름은 김하늘이라고 저장해줘");
  expect(save.speech).toContain("동의해 주세요");
  expect(save.state).toBe("AWAITING_CONSENT");
  await session.handleTurn("응");
  const record = await session.handleTurn("기초연금 신청했어 접수번호는 AB12345");
  expect(record.speech).toContain("동의해 주세요");
  expect(session.personal.vault()).toEqual({});
  expect(session.personal.applications()).toEqual([]);
});

it("test_web_answer_hides_resident_number_from_llm", async () => {
  const session = await newSession();
  const residentNumber = "900101-1234567", quote = "오늘 날씨 신청 방법";
  const open = session.web.openSite.bind(session.web);
  vi.spyOn(session.web, "openSite").mockImplementation(async (url, ctx) => {
    const out = await open(url, ctx);
    if (out.status !== "ok" || out.view?.outline === undefined) return out;
    const outline = out.view.outline;
    let main = outline.mainText ?? "";
    if (!main.includes(quote)) main = quote + "\n" + main;
    return { ...out, view: { ...out.view, outline: { ...outline, mainText: main + "\n주민등록번호 예시 " + residentNumber } } };
  });
  const model = new FakeLlm({ chat_route: { route: "web_search", reply: "", searchQuery: "오늘 날씨" },
    web_answer: { found: true, answer: "첫 검색 결과는 " + quote + "이에요.", evidence: [quote] } });
  withLlm(session, model);
  const result = await session.handleTurn("오늘 날씨 어때");
  expect(result.semanticAction).toBe("web-answer");
  expect(result.speech).toContain(quote);
  const call = model.calls.find(c => c.schemaName === "web_answer");
  expect(call?.user).toContain(REDACTED);
  expect(call?.user).not.toContain(residentNumber);
  expect(call?.user).not.toContain("900101");
});

it("test_vault_values_hidden_in_history", async () => {
  const session = await newSession();
  await session.handleTurn("내 이름은 박하늘이라고 저장해줘");
  await session.handleTurn("응");
  expect((await session.handleTurn("내 정보 알려줘")).speech).toContain("박하늘");
  const replies = session.exportHistory().filter(h => h.role === "assistant");
  expect(replies.some(h => /저장된 정보|이름/u.test(h.text) && h.text.includes(REDACTED))).toBe(true);
  for (const reply of replies) expect(reply.text).not.toContain("박하늘");
});
