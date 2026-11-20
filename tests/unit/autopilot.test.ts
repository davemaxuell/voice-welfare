import { expect, it } from "vitest";
import { ACTION_TYPES, type Observation } from "../../src/core/actions.ts";
import { type LlmRequest, type StructuredLlm } from "../../src/core/llm.ts";
import { Progress } from "../../src/core/progress.ts";
import { ExecContext, WebExecutionAgent } from "../../src/agents/web/agent.ts";
import { Autopilot, historyLine, isKoreanText, pageForLlm, type AutopilotOptions } from "../../src/agents/web/autopilot.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { stepSentence } from "../../src/agents/web/skills/browse.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { REDACTED } from "../../src/safety/privacy.ts";

const rrn = "900101-1234567";
const obs: Observation = {
  platform: "pc", url: "https://example.kr/?q=" + rrn, title: "화면 " + rrn, fields: [], errors: [], dialogs: [], capturedAt: "",
  outline: { headings: [], notices: [], steps: [], buttons: [], links: ["안내 " + rrn], mainLinks: ["안내 " + rrn],
    mainText: `신청 안내. 주민번호 ${rrn}. 문의는 129입니다.` },
};
function pilot(generate: (request: LlmRequest) => Promise<unknown>, options: Partial<AutopilotOptions> = {}) {
  const profile = createMockWelfareProfile("http://localhost:5174");
  const guard = new PolicyGuard({ allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [],
    secretFieldIds: [], maxActionsPerTurn: 12, readOnlyWeb: true });
  const web = new WebExecutionAgent({ observe: async () => obs, async execute() { throw new Error("예상 밖의 조작"); }, async close() {} }, guard, profile);
  return new Autopilot(web, { name: "test", generate }, { searchUrl: q => profile.origin + "?q=" + encodeURIComponent(q), ...options });
}
const context = (signal = new AbortController().signal) => new ExecContext({ signal, isStopped: () => signal.aborted, trace() {} });

it("test_page_for_llm_redacts_resident_number", async () => {
  const page = await pageForLlm(obs);
  expect(page.mainText).not.toContain(rrn);
  expect(page.mainText).toContain(REDACTED);
});

it("test_goal_history_lines_hide_personal_data", () => {
  const line = historyLine({ n: 1, at: 0, action: "open_url", ok: true, note: `'홍길동님 ${rrn} 마이페이지' 열림` });
  expect(line).not.toContain(rrn);
  expect(line).not.toContain("900101");
  expect(line).toContain("마이페이지");
});

it("test_korean_answer_rule_allows_hanja_in_news_titles", () => {
  expect(isKoreanText("오늘 주요 뉴스는 ‘尹 정치인 체포 지시 없었다’와 ‘당정, 수능 부정행위 응시 제한’입니다.")).toBe(true);
  expect(isKoreanText("今天的主要新闻是政府宣布新的福利政策。")).toBe(false);
  expect(isKoreanText("The main news today is about the new welfare policy.")).toBe(false);
});

it("모델에 보내는 목표·주소·링크 이름·단계 기록을 모두 가린다", async () => {
  const inputs: string[] = [];
  const result = await pilot(async request => {
    inputs.push(request.user);
    return inputs.length === 1 ? { action: "find", target: rrn } : { action: "ask_user", answer: "어떤 항목을 찾을까요?" };
  }).run("신청 안내 " + rrn, context());
  expect(result.status).toBe("asked");
  expect(inputs).toHaveLength(2);
  expect(inputs.join("")).not.toContain("900101");
  expect(inputs[1]).toContain(REDACTED);
});

it("잘못된 모델 응답을 한 번 다시 묻고 열 단계에서 멈춘다", async () => {
  let calls = 0;
  const result = await pilot(async () => ++calls === 1 ? {} : { action: "find", target: "항목" + calls }).run("항목 찾아줘", context());
  expect(result.status).toBe("limit");
  expect(calls).toBe(11);
  expect(result.steps).toHaveLength(10);
});

it("test_unknown_action_uses_a_step_and_continues", async () => {
  let calls = 0;
  const asked = await pilot(async () => ++calls <= 2 ? { action: "scroll" } : { action: "ask_user", answer: "어느 사이트에서 찾아볼까요?" }).run("알려줘", context());
  expect(asked).toMatchObject({ status: "asked", speech: "어느 사이트에서 찾아볼까요?", steps: [] });
  expect(calls).toBe(3);

  calls = 0;
  const stuck = await pilot(async () => { calls++; return { action: "scroll" }; }).run("알려줘", context());
  expect(stuck).toMatchObject({ status: "limit", steps: [] });
  expect(calls).toBe(10);
});

it("모델이 응답하지 않아도 시간 예산이 끝나면 기다리기를 멈춘다", async () => {
  // Python 77aad3e: 시간 안에 답하지 않은 결정은 '정하지 못했어요'로 끝난다.
  const result = await pilot(() => new Promise(() => {}), { timeBudgetMs: 30 }).run("알려줘", context());
  expect([result.status, result.speech]).toEqual(["failed", "다음에 무엇을 할지 정하지 못했어요. 조금 더 구체적으로 말씀해 주시겠어요?"]);
});

it("실패한 누름의 진행 알림에는 화면 글이 들어가지 않고 성공했다고 하지 않는다", async () => {
  const secret = "비밀번호는 556677";
  const page: Observation = {
    ...obs, title: "복지로",
    outline: {
      ...obs.outline, mainText: `안내 ${secret}`,
      items: [
        { ref: "a", role: "button", name: "신청", region: "main", disabled: false },
        { ref: "b", role: "button", name: "신청", region: "main", disabled: false },
      ],
    },
  };
  const users: string[] = [];
  const activityLlm: StructuredLlm = {
    name: "utility",
    async generate(request) {
      if (request.schemaName === "activity_line") users.push(String(request.user));
      return { line: "복지로를 열었어요." };
    },
  };
  const profile = createMockWelfareProfile("http://localhost:5174");
  const guard = new PolicyGuard({ allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [],
    secretFieldIds: [], maxActionsPerTurn: 12, readOnlyWeb: true });
  const web = new WebExecutionAgent({ observe: async () => page, async execute() { throw new Error("예상 밖의 조작"); }, async close() {} }, guard, profile);
  const progress = new Progress();
  progress.start();
  let calls = 0;
  const auto = new Autopilot(web, { name: "test", async generate() {
    calls++;
    return calls === 1 ? { action: "click", target: "신청" } : { action: "ask_user", answer: "어느 버튼을 누를까요?" };
  } }, { searchUrl: query => query, progress, activityLlm });
  const result = await auto.run("신청 눌러줘", context(), step => progress.add(stepSentence(step, "", "")));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(result.steps[0]).toMatchObject({ action: "click", ok: false, target: "신청" });
  expect(progress.latest).toBe("'신청'을 누르려고 했어요.");
  expect(users.join("")).not.toContain(secret);
  expect(users.some(user => JSON.parse(user).ok === false && JSON.parse(user).action === "click")).toBe(true);
  expect(progress.snapshot().activity).not.toBe("복지로를 열었어요.");
});

it("보류 중인 모델이 멈춘 뒤 답을 보내도 브라우저 조작은 실행하지 않는다", async () => {
  const controller = new AbortController();
  let release: ((reply: unknown) => void) | undefined;
  let reached = () => {};
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const task = pilot(() => new Promise(r => { release = r; reached(); })).run("열어줘", context(controller.signal));
  await waiting;
  controller.abort();
  release?.({ action: "open_url", target: "https://example.kr" });
  expect((await task).status).toBe("stopped");
});
