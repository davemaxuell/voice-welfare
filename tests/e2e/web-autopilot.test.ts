import type { Browser } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { launchBrowser, PlaywrightExecutionAdapter } from "../../src/agents/web/browser/index.ts";
import { ExecContext, WebExecutionAgent } from "../../src/agents/web/agent.ts";
import { Autopilot, type AutopilotActionType } from "../../src/agents/web/autopilot.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { ACTION_TYPES } from "../../src/core/actions.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";

const portal = "http://127.0.0.1:5174/external.html";
const profile = createMockWelfareProfile("http://localhost:5174");
const guard = new PolicyGuard({
  allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES, allowedFieldIds: profile.fields.map(f => f.fieldId),
  secretFieldIds: ["loginPassword"], safeButtons: [profile.buttons.next, profile.buttons.prev], readOnlyWeb: true,
  readOnlyClicks: "safe", maxActionsPerTurn: 12,
});
let browser: Browser;
let agent: WebExecutionAgent;
beforeAll(async () => { browser = await launchBrowser(process.env.HEADED !== "1"); });
beforeEach(async () => {
  const adapter = new PlaywrightExecutionAdapter({ browser, allowedOrigins: [profile.origin], readOnlyWeb: true });
  await adapter.start();
  agent = new WebExecutionAgent(adapter, guard, profile);
});
afterEach(async () => { await agent?.close(); });
afterAll(async () => { await browser?.close(); }, 60000);

const modelInput = z.object({ page: z.object({
  mainText: z.string(), footer: z.string(), items: z.array(z.object({ name: z.string(), kind: z.string() })),
}).nullable() });
const step = (action: AutopilotActionType, target?: string, answer?: string, evidence?: string[]) =>
  ({ thought: "", action, target, answer, evidence });
const open = step("open_url", portal);
const answer = (text: string, ...evidence: string[]) => step("answer", undefined, text, evidence);
async function run(goal: string, replies: ReturnType<typeof step>[]) {
  const notes: string[] = [];
  const requests: Array<z.infer<typeof modelInput>> = [];
  const ctx = new ExecContext({ signal: new AbortController().signal, isStopped: () => false,
    trace(_phase, _agent, note) { if (note !== undefined) notes.push(note); } });
  const pilot = new Autopilot(agent, { name: "scripted", async generate(req) {
    requests.push(modelInput.parse(JSON.parse(req.user)));
    return replies[Math.min(requests.length - 1, replies.length - 1)];
  } }, { searchUrl: q => portal + "?q=" + encodeURIComponent(q) });
  return { result: await pilot.run("127.0.0.1:5174/external.html에서 " + goal, ctx), requests, notes };
}

it("test_open_click_answer", async () => {
  const said = "두 번째 페이지라는 안내 기사예요.";
  const { result, requests, notes } = await run("장애인연금 안내 기사 내용 알려줘", [open, step("click", "장애인연금 안내"), answer(said, "두 번째 페이지입니다")]);
  expect(result.speech, JSON.stringify({ actions: result.actions, steps: result.steps })).toBe(said);
  expect(result.view?.title).toContain("안내 기사");
  expect(result.actions.map(a => a.policy.code)).toEqual(["ALLOWED_READ_ONLY", "ALLOWED_READ_ONLY"]);
  expect(requests[1]?.page?.items.some(i => i.name === "장애인연금 안내")).toBe(true);
  expect(notes.filter(note => note.startsWith("자율")).length).toBeGreaterThanOrEqual(3);
});

it("test_answers_a_contact_number_from_the_footer", async () => {
  const said = "대표번호는 국번없이 1234예요.";
  const { result, requests } = await run("고객센터 전화번호 찾아줘", [open, answer(said, "대표번호 국번없이 1234")]);
  expect(requests[1]?.page?.footer).toContain("대표번호 국번없이 1234");
  expect(result.speech).toBe(said);
});

it("test_footer_numbers_do_not_back_an_answer_that_quotes_elsewhere", async () => {
  const madeUp = "올해 기초급여 기준액은 1234원으로 조정되었어요.";
  const { result } = await run("기초급여 기준액 알려줘", [open, answer(madeUp, "올해 장애인연금 기초급여 기준액이 조정되었습니다")]);
  expect(result.speech).not.toBe(madeUp);
  expect(result.speech).toContain("확실한 답을 확인하지 못했어요");
});

it("test_uses_search_box", async () => {
  const { result } = await run("기초연금 찾아서 알려줘", [open, step("search", "기초연금"),
    answer("첫 결과는 기초연금 신청 방법이에요.", "기초연금 신청 방법")]);
  expect(result.view?.title).toContain("'기초연금' 검색 결과");
  expect(result.speech).toContain("기초연금 신청 방법");
  expect(result.actions.map(a => a.action.type)).toEqual(["navigate", "fill", "press"]);
});

it("test_policy_guard_blocks_action_button", async () => {
  const { result, notes } = await run("의견 보내는 곳 찾아줘", [open, step("click", "보내기"), step("fail", undefined, "그 버튼은 누를 수 없어요.")]);
  expect(result.actions.filter(a => a.action.target?.name === "보내기" && a.result?.ok === true)).toEqual([]);
  expect(result.view?.title).not.toContain("의견이 전송됨");
  expect(notes.some(note => note.includes("안전 규칙으로 막힘"))).toBe(true);
});

it("test_stops_when_looping", async () => {
  const { result } = await run("끝까지 읽어서 알려줘", [open, step("read_more")]);
  expect(result.speech).toContain("맴돌고 있어서 멈췄어요");
  expect(result.steps.map(s => s.action)).toEqual(["open_url", "read_more", "read_more", "find_links"]);
});

it("test_rejects_answer_without_visit", async () => {
  const said = "포털에는 뉴스·복지·날씨 메뉴가 있어요.";
  const { result, notes } = await run("메뉴 뭐 있는지 알려줘", [answer("메뉴가 없어요."), open, answer(said, "뉴스", "복지 소식")]);
  expect(result.speech).toBe(said);
  expect(notes.some(note => note.includes("사이트를 열어 보지 않고 답함"))).toBe(true);
});

it("test_rewrites_non_korean_answer", async () => {
  const said = "상담은 보건복지상담센터에서 받을 수 있어요.";
  const { result } = await run("상담 어디서 받는지 찾아줘", [open, answer("国民年金服务热线是保健福利咨询中心"), answer(said, "상담은 보건복지상담센터에서 받을 수 있습니다")]);
  expect(result.speech).toBe(said);
});

it("test_few_hanja_allowed", async () => {
  const said = "복지 소식 기사가 있어요. 與 관련 소식은 없어요.";
  const { result } = await run("무슨 글 있는지 알려줘", [open, answer(said, "복지 소식")]);
  expect(result.speech).toBe(said);
});

it("test_verifier_rejects_invented_evidence_and_numbers", async () => {
  const quote = "상담은 보건복지상담센터에서 받을 수 있습니다", said = "상담은 보건복지상담센터에서 받을 수 있어요.";
  const { result, notes } = await run("상담 전화번호 찾아줘", [open, answer("상담 전화는 1355번이에요.", "상담 전화 1355"),
    answer("보건복지상담센터 129에서 상담받을 수 있어요.", quote), answer(said, quote)]);
  expect(result.speech).toBe(said);
  expect(notes.filter(n => n.startsWith("근거 부족"))).toHaveLength(2);
  expect(notes.some(n => n.includes("근거에 없는 숫자: 129"))).toBe(true);
});

it("test_verifier_gives_up_honestly", async () => {
  const { result } = await run("고객센터 번호 찾아줘", [open, answer("고객센터는 1588-0000이에요.")]);
  expect(result.speech).toContain("추측해서 말씀드리지 않을게요");
  expect(result.speech).not.toContain("1588");
  expect(result.steps.filter(s => s.action === "answer" && !s.ok)).toHaveLength(3);
});

it("test_llm_gets_digested_page", async () => {
  const { requests } = await run("무슨 글 있는지 알려줘", [open, answer("복지 소식 기사가 있어요.", "복지 소식")]);
  const page = requests[1]?.page;
  expect(page?.items.filter(i => i.kind === "menu").map(i => i.name)).toEqual(expect.arrayContaining(["뉴스", "복지", "날씨"]));
  expect(page?.items.find(i => i.kind === "link")?.name).toBe("장애인연금 안내");
  expect(page?.items.filter(i => i.name === "자세히 보기")).toHaveLength(1);
  expect(page?.mainText).toContain("복지 소식");
});
