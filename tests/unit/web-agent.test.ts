import { expect, it, vi } from "vitest";
import { ACTION_TYPES, type Action, type ActionResult, type Observation } from "../../src/core/actions.ts";
import { actionLabel, ExecContext, WebExecutionAgent, type WebAction, type WebAdapter } from "../../src/agents/web/agent.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";

const profile = createMockWelfareProfile("http://localhost:5174");
const guard = new PolicyGuard({ allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES,
  allowedFieldIds: profile.fields.map(f => f.fieldId), secretFieldIds: ["loginPassword"], maxActionsPerTurn: 12 });
function context(signal = new AbortController().signal) {
  return new ExecContext({ signal, trace() {}, isStopped: () => signal.aborted });
}
function observation(mainText = "신청 안내"): Observation {
  return { url: profile.urls.apply, platform: "pc", fields: [], title: "신청서", errors: [], dialogs: [], capturedAt: "",
    outline: { mainText, headings: [], notices: [], steps: [], buttons: [], links: [] } };
}
const read: Action = { id: "r1", type: "read", reason: "이름 확인", risk: "low", requiresConfirmation: false };
const timeout = (a: Action): ActionResult => ({ actionId: a.id, ok: false, verified: false, errorCode: "TIMEOUT", latencyMs: 1 });

it("test_approval_action_blocked_when_log_fails", async () => {
  const execute = vi.fn(async (action: Action) => timeout(action));
  const web = new WebExecutionAgent({ execute, observe: async () => observation(), async close() {} }, guard, profile,
    { append() { throw new Error("disk full"); } });
  const ctx = context();
  await web.observe(ctx);
  const action = web.buildSubmitAction();
  const log: WebAction[] = [];
  const result = await ctx.granted([action.id], () => web.run(action, ctx, log));
  expect(result?.errorCode).toBe("LOG_FAILED");
  expect(log[0]?.policy.code).toBe("APPROVED");
  expect(execute).not.toHaveBeenCalled();
  expect(ctx.approvals.size).toBe(0);
});

it("test_observe_learns_churn_only_after_idle_gaps", async () => {
  let index = 0;
  const adapter: WebAdapter = { observe: async () => observation(`보조기기 지원\n알림 ${index++}호\n지원 대상은 등록 장애인입니다.`),
    execute: async action => timeout(action), async close() {} };
  const web = new WebExecutionAgent(adapter, guard, profile);
  const times = [0, 500, 1500, 2500];
  web.clock = () => times.shift()!;
  for (let i = 0; i < 3; i++) await web.observe();
  expect(web.churn.volatile()).toEqual({});
  await web.observe();
  expect(web.churn.volatile()).toEqual({ "보조기기 지원": 1 });
});

it("test_action_label_redacts", () => {
  expect(actionLabel({ type: "fill", reason: "검색어 입력: 기초연금" })).toContain("검색");
  expect(actionLabel({ type: "click", target: { name: "900101-1234567" } })).not.toContain("900101");
});

it("재시도는 승인 없는 저위험 시간 초과에 한 번만 한다", async () => {
  const execute = vi.fn(async (action: Action) => timeout(action));
  const web = new WebExecutionAgent({ observe: async () => observation(), execute, async close() {} }, guard, profile);
  const ctx = context();
  await web.observe(ctx);
  const log: WebAction[] = [];
  await web.run(read, ctx, log);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(ctx.counter.actions).toBe(1);
  const approved = web.buildSubmitAction();
  await ctx.granted([approved.id], () => web.run(approved, ctx, log));
  expect(log.at(-1)?.policy.code).toBe("APPROVED");
  expect(execute).toHaveBeenCalledTimes(3);
});

it("중단된 턴은 시간 초과가 나도 재실행하거나 다시 관찰하지 않는다", async () => {
  const controller = new AbortController();
  const ctx = context(controller.signal);
  const observe = vi.fn(async () => observation());
  const execute = vi.fn(async (action: Action, signal?: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    controller.abort();
    return timeout(action);
  });
  const web = new WebExecutionAgent({ observe, execute, async close() {} }, guard, profile);
  await web.observe(ctx);
  await web.run(read, ctx, []);
  await expect(web.observe(ctx)).rejects.toThrow();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1);
});
