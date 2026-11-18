import { expect, it } from "vitest";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { consentRefusal, gateRefusal } from "../../src/safety/gates.ts";

const origin = "http://localhost:5174";
const guard = new PolicyGuard({
  allowedOrigins: [origin], allowedActionTypes: ["navigate", "click", "fill", "select", "check", "read"],
  allowedFieldIds: ["applicantName", "address"], secretFieldIds: ["loginPassword"], maxActionsPerTurn: 3,
});
const ctx = { currentUrl: origin + "/apply.html" };
const action = {
  id: "a1", type: "fill", target: { label: "성명", fieldId: "applicantName" },
  value: "김하늘", reason: "test", risk: "low", requiresConfirmation: false,
};
it("test_allowed_low_risk_fill", () => {
  expect(guard.check(action, ctx).code).toBe("ALLOWED");
});
it("test_schema_mismatch_denied", () => {
  expect(guard.check({ type: "fill", coords: [10, 20] }, ctx).code).toBe("DENIED_SCHEMA");
  expect(guard.check({ ...action, type: "eval" }, ctx).code).toBe("DENIED_SCHEMA");
});
it("test_origin_outside_allowlist_denied", () => {
  expect(guard.check({ ...action, type: "navigate", url: "https://www.bokjiro.go.kr/", target: undefined, value: undefined }, ctx).code).toBe("DENIED_ORIGIN");
  expect(guard.check(action, { currentUrl: "https://evil.example/" }).code).toBe("DENIED_ORIGIN");
});
it("test_secret_field_and_values_always_denied", () => {
  for (const fieldId of ["loginPassword", "applicantName"]) {
    expect(guard.check({ ...action, target: { label: "비밀번호", fieldId } }, ctx).code).toBe("DENIED_SECRET");
  }
  expect(guard.check({ ...action, value: "900101-1234567" }, ctx).code).toBe("DENIED_SECRET");
});
it("test_unknown_field_denied", () => {
  expect(guard.check({ ...action, target: { label: "기타", fieldId: "other" } }, ctx).code).toBe("DENIED_FIELD");
});
it("test_consequential_needs_prior_approval", () => {
  const submit = { ...action, id: "s1", type: "click", target: { role: "button", name: "모의접수" },
    value: undefined, risk: "consequential", requiresConfirmation: true };
  expect(guard.check(submit, ctx).code).toBe("NEEDS_CONFIRMATION");
  expect(guard.check(submit, { ...ctx, approvals: new Set(["other"]) }).code).toBe("NEEDS_CONFIRMATION");
  expect(guard.check(submit, { ...ctx, approvals: new Set(["s1"]) }).code).toBe("APPROVED");
});
it("test_risky_button_on_supported_site_needs_approval_whatever_the_declared_risk", () => {
  const g = new PolicyGuard({ ...guard.config, allowedActionTypes: ["click"], safeButtons: ["다음", "이전", "닫기", "확인"] });
  const click = (role: string, name: string) => ({ ...action, id: "c1", type: "click", target: { role, name }, value: undefined });
  for (const name of ["모의접수", "모의 로그인"]) expect(g.check(click("button", name), ctx).code).toBe("NEEDS_CONFIRMATION");
  expect(g.check(click("button", "모의접수"), { ...ctx, approvals: new Set(["c1"]) }).code).toBe("APPROVED");
  for (const name of ["다음", "확인"]) expect(g.check(click("button", name), ctx).code).toBe("ALLOWED");
  expect(g.check(click("link", "장애인연금 모의 신청하기"), ctx).code).toBe("ALLOWED");
});
it("test_stopped_and_rate_limit", () => {
  expect(guard.check(action, { ...ctx, stopped: true }).code).toBe("DENIED_STOPPED");
  expect(guard.check(action, { ...ctx, actionsThisTurn: 3 }).code).toBe("DENIED_RATE_LIMIT");
});
it("test_guard_uses_rules_only", () => {
  expect(guard.check({ ...action, value: "사과나무" }, ctx).code).toBe("ALLOWED");
});
it("동의 거절은 멈춤보다 먼저 검사하며 중단 상태에서는 재개로 시작해야 한다", () => {
  expect(gateRefusal(["FILL"], "pending", "STOPPED")?.semanticAction).toBe("consent");
  expect(consentRefusal(["POLICY_QUESTION", "FILL"], "declined")?.speech).toContain("동의하지 않으셔서");
  expect(consentRefusal(["POLICY_QUESTION"], "pending")).toBeUndefined();
  expect(gateRefusal(["POLICY_QUESTION"], "granted", "STOPPED")?.state).toBe("STOPPED");
  expect(gateRefusal(["RESUME", "FILL"], "granted", "STOPPED")).toBeUndefined();
});
