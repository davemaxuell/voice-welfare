import { expect, it, vi } from "vitest";
import { ExecContext, WebExecutionAgent, type ControlWindow, type WebAdapter } from "../../src/agents/web/agent.ts";
import { createMockWelfareProfile, fieldVocabulary } from "../../src/agents/web/profile.ts";
import { spokenPlanNames } from "../../src/agents/web/skills/known_plan.ts";
import { WelfareInformationAgent } from "../../src/agents/welfare/agent.ts";
import { FixtureWelfareDataProvider } from "../../src/agents/welfare/data/index.ts";
import { ACTION_TYPES, type Action } from "../../src/core/actions.ts";
import { bindPlanClick, boundPlanClick, revokePlanClick, type PlanStep } from "../../src/core/plan.ts";
import { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { PolicyGuard, type PolicyContext } from "../../src/safety/guard.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { page } from "./fake-browser.ts";

const url = "https://info.example.go.kr/menu";
const labels = ["글자 크기 변경", "정렬 수정", "보기 취소"];
function scenario(limit = 12) {
  let now = 0;
  const clicks: string[] = [];
  const items = labels.map((name, i) => ({ name, role: "button" as const, ref: "r" + i, disabled: false, region: "main" as const }));
  const view = page(url, "화면 표시");
  view.outline!.items = items;
  const profile = createMockWelfareProfile("https://practice.example.go.kr");
  const guard = new PolicyGuard({ allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [], secretFieldIds: [],
    maxActionsPerTurn: limit, readOnlyWeb: true });
  const adapter: WebAdapter = {
    async observe() { return view; },
    async controlWindow(name): Promise<ControlWindow> {
      return { url, more: false, items: items.filter(i => i.name === name).map(i => ({ ...i, planSignature: i.ref })) };
    },
    async execute(action, _signal, _inspection, grants) {
      expect(grants?.plan && boundPlanClick(grants.plan, action, url)).toBe(true);
      clicks.push(action.target!.name!);
      return { actionId: action.id, ok: true, verified: true, latencyMs: 0 };
    },
    async close() {},
  };
  const web = new WebExecutionAgent(adapter, guard, profile);
  const s = new SessionOrchestrator({ web, welfare: new WelfareInformationAgent(FixtureWelfareDataProvider.fromFile()), clock: () => now,
    publicPlanning: false, intentProvider: new RuleBasedIntentProvider(fieldVocabulary(profile)) });
  s.dialogue.commit("BROWSING");
  const ctx = new ExecContext({ signal: new AbortController().signal, isStopped: () => false, trace() {} });
  const run = (async () => {
    await web.observe(ctx);
    const asked = await s.handleTurn(items.map(i => i.name + " 버튼 눌러줘").join(", "), { fromVoice: true });
    expect(asked.pendingConfirmation?.kind).toBe("plan");
    expect(asked.speech).toBe(asked.pendingConfirmation?.description);
    return () => s.handleTurn("네", { fromVoice: true, approvalId: asked.pendingConfirmation!.actionId });
  });
  vi.spyOn(web, "clickApproved").mockImplementation(async (action, execution, grants) => {
    expect([...execution.approvals]).toEqual([action.id]);
    const actions: Parameters<typeof web.run>[2] = [];
    await web.run(action, execution, actions, undefined, undefined, grants);
    return { status: "ok", actions, view: web.currentView, effect: "changed", readValue: action.target?.name };
  });
  return { s, guard, clicks, items, run, advance: (seconds: number) => { now += seconds; } };
}

it("규칙이 직접 읽은 여러 절만 쓰고, 클릭 뒤에 다른 부탁이 붙은 절을 거부한다", () => {
  expect(spokenPlanNames(["글자 크기 변경 버튼 눌러줘", "정렬 수정을 클릭해 주세요"])).toEqual(labels.slice(0, 2));
  expect(spokenPlanNames(["글자 크기 변경 눌러줘", "정렬 수정 눌러주고 결제해"])).toBeUndefined();
});

it("정확한 세 이름에 대한 한 번의 동의만 조작마다 적용하고 마지막에 버린다", async () => {
  const { s, clicks, run } = scenario();
  const yes = await run();
  const result = await yes();
  expect(result.actions.map(a => a.policy.code)).toEqual(["APPROVED", "APPROVED", "APPROVED"]);
  expect(clicks).toEqual(labels);
  expect(s.dialogue.approval).toBeUndefined();
  expect((await yes()).actions).toEqual([]);
});

it("짧게 듣더라도 긴 순서와 마지막 승인·거절 안내까지 모두 읽는다", async () => {
  const { s, items, run } = scenario();
  s.personal.saveSpeech({ length: "short" });
  items[2]!.name = "이 화면에서 읽고 있는 글의 보기 설정 변경 취소";
  await run();
  const description = s.dialogue.confirmation!.description!;
  expect(description.length).toBeGreaterThan(100);
  expect(description).toContain(`3번, “${items[2]!.name}” 버튼`);
  expect(description).toMatch(/'네'.*'거절'이라고 말씀해 주세요\.$/u);
});

it("만료 또는 멈춤 뒤 늦게 온 예전 승인은 첫 단계도 누르지 않는다", async () => {
  for (const reason of ["만료", "멈춤"]) {
    const { s, clicks, run, advance } = scenario();
    const yes = await run();
    if (reason === "만료") advance(120);
    else s.cancel();
    expect((await yes()).actions).toEqual([]);
    expect(clicks).toEqual([]);
    expect(s.dialogue.approval).toBeUndefined();
  }
});

it("한도까지 실행한 뒤 남은 순서를 버린다", async () => {
  const { s, clicks, run } = scenario(1);
  const yes = await run();
  expect((await yes()).speech).toContain("횟수");
  expect(clicks).toEqual(labels.slice(0, 1));
  expect(s.dialogue.approval).toBeUndefined();
});

it("동의 뒤 대상 이름 변경, 실행 중 만료와 멈춤도 다음 누르기 전에 검사한다", async () => {
  for (const reason of ["만료", "이름", "멈춤"]) {
    const { s, clicks, items, run, advance } = scenario();
    const yes = await run();
    const execute = s.web.adapter.execute.bind(s.web.adapter);
    vi.spyOn(s.web.adapter, "execute").mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (reason === "만료") advance(120);
      else if (reason === "이름") items[1]!.name = "제출";
      else s.cancel();
      return result;
    });
    await yes();
    expect(clicks).toEqual(labels.slice(0, 1));
    expect(s.dialogue.approval).toBeUndefined();
  }
});

it("계획 증명은 새로 읽은 한 조작에만 쓰고 위험·조회·개인 화면·막힌 동작은 낮출 수 없다", () => {
  const { guard } = scenario();
  const step: PlanStep = { page: url, kind: "click", role: "button", name: labels[0]! };
  const action: Action = { id: "단계", type: "click", target: { ref: "r1", role: step.role, name: step.name },
    risk: "low", requiresConfirmation: false, reason: "사용자가 확인한 버튼 누르기" };
  const mint = (s: PlanStep) => bindPlanClick(s, action.id, "r1", url, "서명", () => true);
  const plan = mint(step);
  const ctx: PolicyContext = { plan, currentUrl: url, approvals: new Set([action.id]) };
  expect(guard.check(action, ctx)).toMatchObject({ allowed: true, code: "APPROVED" });
  for (const changed of [{ plan: { ...plan } }, { currentUrl: url + "/다름" }, { publicLookup: true }, { browsingScope: "personal-inspection" as const },
    { approvals: new Set<string>() }, { stopped: true }, { actionsThisTurn: 12 }]) expect(guard.check(action, { ...ctx, ...changed }).allowed).toBe(false);
  for (const change of [{ id: "다른 조작" }, { type: "fill" }, { requiresConfirmation: true }, { risk: "sensitive" }]) {
    expect(guard.check({ ...action, ...change }, ctx).allowed).toBe(false);
  }
  for (const role of ["button", "link"]) {
    for (const name of ["확인", "로그인", "신청", "결제", "제출", "삭제"]) {
      expect(guard.check({ ...action, target: { ...action.target, role, name } }, { ...ctx, plan: mint({ ...step, role, name }) }).allowed).toBe(false);
    }
  }
  revokePlanClick(plan);
  expect(guard.check(action, ctx).allowed).toBe(false);
});
