import { expect, it, vi } from "vitest";
import { ACTION_TYPES, type Action, type Observation } from "../../src/core/actions.ts";
import { ExecContext, WebExecutionAgent, type WebAdapter } from "../../src/agents/web/agent.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { PolicyGuard, type InspectionBinding, type InspectionControl, type PolicyContext } from "../../src/safety/guard.ts";

const url = "https://residents.example/dashboard?tab=current";
const config = {
  allowedOrigins: [], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [], secretFieldIds: ["secret"],
  maxActionsPerTurn: 12, readOnlyWeb: true,
};
const guard = new PolicyGuard(config);
const personal = { currentUrl: url, browsingScope: "personal-inspection" } as const;
const action: Action = { id: "a1", type: "click", target: { ref: "r1", role: "link", name: "열기" },
  reason: "test", risk: "low", requiresConfirmation: false };
const navigate = (next: string): Action => ({ ...action, type: "navigate", target: undefined, url: next });
const controlProof = (control: InspectionControl): InspectionBinding => ({ kind: "control", url, ref: "r1", control });
const ambiguous = controlProof({ kind: "ambiguous", href: "https://residents.example/status", signature: "script" });

it("requires browser evidence even for links and binds approval to the inspected control", () => {
  expect(guard.check(action, personal).code).toBe("DENIED_INSPECTION_BINDING");
  const context: PolicyContext = { ...personal, inspection: ambiguous, approvals: new Set([action.id]) };
  expect(guard.check(action, context).code).toBe("NEEDS_CONFIRMATION");
  expect(guard.check(action, { ...context, inspectionApproved: true }).code).toBe("APPROVED");
  expect(guard.check(action, { ...context, currentUrl: url.replace("current", "other"), inspectionApproved: true }).allowed).toBe(false);
  const navigation = { ...context, inspection: controlProof({ kind: "navigation", href: "https://residents.example/status", signature: "href" }) };
  expect(guard.check(action, navigation).allowed).toBe(true);
  const login = { ...action, target: { ...action.target, name: "로그인" } };
  expect(guard.check(login, navigation).code).toBe("NEEDS_CONFIRMATION");
  expect(guard.check(login, { ...navigation, inspectionApproved: true }).code).toBe("APPROVED");
});

it("rejects submission evidence, writes and fabricated direct URLs without inviting approval", () => {
  const approved = { ...personal, inspectionApproved: true };
  expect(guard.check(action, { ...approved, inspection: controlProof({ kind: "blocked", signature: "submit" }) }).code).toBe("DENIED_READ_ONLY");
  expect(guard.check({ ...action, target: { ...action.target, name: "결제" } }, { ...approved, inspection: ambiguous }).code).toBe("DENIED_READ_ONLY");
  expect(guard.check({ ...action, type: "fill", target: { fieldId: "secret" }, value: "text" }, approved).code).toBe("DENIED_SECRET");
  expect(guard.check({ ...action, type: "select" }, approved).code).toBe("DENIED_TASK_SCOPE");
  expect(guard.check({ ...action, type: "capture", target: undefined }, approved).code).toBe("DENIED_TASK_SCOPE");
  expect(guard.check(navigate("https://elsewhere.example/"), personal).allowed).toBe(false);
  for (const next of [
    "https://residents.example/submit.do", "https://residents.example/%73ubmit/123", "https://residents.example/?action=delete",
    "https://residents.example/?_method=PATCH", "https://person:secret@residents.example/", "https://residents.example/?otp=1234",
  ]) {
    const ctx = { ...personal, inspection: { kind: "start", url: next } } as const;
    expect(guard.check(navigate(next), ctx).allowed, next).toBe(false);
  }
  for (const path of ["/dashboard?tab=current", "/payments/payment-history", "/status-update/details", "/checkout/help"]) {
    const next = "https://residents.example" + path;
    expect(guard.check(navigate(next), { ...personal, inspection: { kind: "start", url: next } }).allowed, next).toBe(true);
  }
});

it("keeps public and background scope from using personal approvals", () => {
  const ctx = { ...personal, inspectionApproved: true, inspection: ambiguous };
  expect(guard.check(action, { ...ctx, publicLookup: true }).code).toBe("DENIED_TASK_SCOPE");
  expect(new PolicyGuard({ ...config, publicLookupOnly: true }).check(action, ctx).code).toBe("DENIED_TASK_SCOPE");
});

it("allows a short local inspection search only with exact safe form evidence", () => {
  const destination = "https://residents.example/search";
  const proof = { kind: "search", url, fieldId: "q", parameter: "q", signature: "form", destination } as const;
  const search: Action = { ...action, url: destination, type: "press", target: { fieldId: "q", role: "searchbox" }, value: "배송 안내" };
  expect(guard.check(search, personal).allowed).toBe(false);
  expect(guard.check(search, { ...personal, inspection: proof }).allowed).toBe(true);
  for (const value of ["900101-1234567", "alice@example.com", "010-1234-5678"]) {
    expect(guard.check({ ...search, value }, { ...personal, inspection: proof }).allowed, value).toBe(false);
  }
  const external = "https://elsewhere.example/search";
  expect(guard.check({ ...search, url: external }, { ...personal, inspection: { ...proof, destination: external } }).allowed).toBe(false);
  expect(guard.check(search, { ...personal, inspection: { ...proof, parameter: "action" } }).allowed).toBe(false);
});

const item = { ref: "r1", role: "link", name: "열기", region: "main", disabled: false } as const;
function setup() {
  let inspection: InspectionControl = { kind: "ambiguous", href: "https://residents.example/status", signature: "script" };
  const observation: Observation = { url, platform: "pc", fields: [], title: "test", errors: [], dialogs: [], capturedAt: "",
    outline: { mainText: "현재 상태", headings: [], notices: [], steps: [], buttons: [], links: [], items: [item] } };
  const execute = vi.fn<WebAdapter["execute"]>(async a => ({ actionId: a.id, ok: false, verified: false, errorCode: "TIMEOUT", latencyMs: 0 }));
  const web = new WebExecutionAgent({
    observe: async () => observation, execute, async close() {},
    async controlWindow() { return { url, items: [{ ...item, inspection }], more: false }; },
  }, guard, createMockWelfareProfile("http://localhost:5174"));
  const ctx = new ExecContext({ signal: new AbortController().signal, isStopped: () => false, trace() {}, ...personal });
  return { execute, web, ctx, replaceInspection: (next: InspectionControl) => { inspection = next; } };
}

it("invalidates an approved ambiguous link if its live capability changes", async () => {
  const { web, ctx, execute, replaceInspection } = setup();
  const asked = await web.followLink("열기", ctx);
  expect(asked.status).toBe("needs-approval");
  expect(execute).not.toHaveBeenCalled();
  replaceInspection({ kind: "ambiguous", href: "https://residents.example/profile", signature: "different-handler" });
  const pending = asked.pending!;
  const result = await ctx.granted([pending.id], () => web.clickApproved(pending, ctx));
  expect(result.actions[0]?.policy.code).toBe("DENIED_INSPECTION_CHANGED");
  expect(execute).not.toHaveBeenCalled();
});

it("never retries a timed-out approved inspection action", async () => {
  const { web, ctx, execute } = setup();
  const pending = (await web.followLink("열기", ctx)).pending!;
  const result = await ctx.granted([pending.id], () => web.run(pending, ctx, []));
  expect(result?.errorCode).toBe("TIMEOUT");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await ctx.granted([pending.id], () => web.run(pending, ctx, []))).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(1);
});
