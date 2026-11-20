import { expect, it } from "vitest";
import { clickTier, guardPatterns, PolicyGuard, type PolicyConfig } from "../../src/safety/guard.ts";
import { consentRefusal, gateRefusal } from "../../src/safety/gates.ts";
import { codePointSpans } from "./python-spans.ts";

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
it.each(["tab", "scriptlink", "menuitem", "generic"])("test_action_controls_on_supported_site_require_matching_approval", role => {
  const click = { ...action, id: "c2", type: "click", target: { role, name: "모의접수" }, value: undefined };
  expect(guard.check(click, { ...ctx, approvals: new Set(["other"]) }).code).toBe("NEEDS_CONFIRMATION");
  expect(guard.check(click, { ...ctx, approvals: new Set(["c2"]) }).code).toBe("APPROVED");
});
it.each(["tab", "scriptlink"])("test_information_controls_on_supported_site_open_directly", role => {
  expect(guard.check({ ...action, type: "click", target: { role, name: "신청방법" }, value: undefined }, ctx).code).toBe("ALLOWED");
});
it("test_review_budget_respects_policy_ceiling_and_the_default_turn_limit", () => {
  const limited = new PolicyGuard({ ...guard.config, defaultActionsPerTurn: 1 });
  expect(limited.check(action, { ...ctx, actionsThisTurn: 1 }).code).toBe("DENIED_RATE_LIMIT");
  expect(limited.check(action, { ...ctx, actionsThisTurn: 1, actionLimit: 2 }).allowed).toBe(true);
  expect(limited.check(action, { ...ctx, actionsThisTurn: 2, actionLimit: 2 }).code).toBe("DENIED_RATE_LIMIT");
  expect(limited.check(action, { ...ctx, actionsThisTurn: 3, actionLimit: 99 }).code).toBe("DENIED_RATE_LIMIT");
});
it.each([
  ["button", "확인", "ask"], ["button", "자격 확인", "ask"], ["button", "검색 조건 변경", "ask"],
  ["button", "모의계산 확인", "ask"], ["button", "신청방법", "ask"], ["button", "취소", "ask"],
  ["button", "온라인 신청", "hard"], ["menuitem", "복지서비스 신청", "hard"], ["button", "보내기", "hard"],
  ["button", "회원가입", "hard"], ["button", "신청 취소", "hard"], ["button", "", "hard"],
  ["button", "더보기", "free"], ["button", "닫기", "free"], ["button", "검색하기", "free"],
  ["tab", "검색하기", "ask"], ["tab", "신청방법", "free"], ["link", "신청하기", "free"],
  ["generic", "서비스 내용", "ask"],
] as const)("test_click_tier", (role, name, tier) => {
  expect(clickTier(role, name)).toBe(tier);
});
// 기대값은 77aad3e의 Python safety/guard.py로 계산했다.
it("역할과 이름으로 누를 등급과 거부할 동작 이름을 Python과 같이 고른다", () => {
  for (const [role, name, tier] of [
    [undefined, "확인", "ask"], [undefined, "", "hard"], ["link", "", "free"], ["button", "  ", "hard"], ["tab", "신청하기", "hard"],
    ["scriptlink", "신청 안내", "free"], ["menuitem", "로그아웃", "hard"], ["button", "Log in", "free"], ["button", "SİGN UP", "hard"],
    ["generic", "로그인", "ask"], ["checkbox", "동의", "hard"], ["button", "결제 내역", "hard"], ["tab", "결제 내역", "hard"],
  ] as const) expect(clickTier(role, name), name).toBe(tier);
  for (const [text, spans] of [
    ["온라인 신청", [[4, 6]]], ["SUBMİT", [[0, 6]]], ["sign-up", [[0, 7]]], ["Sign  Out", [[0, 9]]], ["log - out", [[0, 9]]],
    ["login", []], ["회원가입", [[2, 4]]], ["신청방법", [[0, 2]]], ["", []], ["１２３ 등록", [[4, 6]]], ["ſend", [[0, 4]]],
  ] as const) expect(codePointSpans(guardPatterns.hardAction, text), text).toEqual(spans);
});
it("test_read_only_ask_tier_needs_then_takes_approval", () => {
  const safe = new PolicyGuard({ allowedOrigins: [], allowedActionTypes: ["click"], allowedFieldIds: [], secretFieldIds: [], maxActionsPerTurn: 3, readOnlyWeb: true });
  const click = { ...action, type: "click", target: { role: "button", name: "확인" }, value: undefined };
  expect(safe.check(click, { ...ctx, approvals: new Set(["other"]) }).code).toBe("NEEDS_CONFIRMATION");
  expect(safe.check(click, { ...ctx, approvals: new Set([click.id]) }).code).toBe("APPROVED");
  for (const name of ["온라인 신청", "로그인 후 결제"]) {
    expect(safe.check({ ...click, target: { role: "button", name } }, { ...ctx, approvals: new Set([click.id]) }).code).toBe("DENIED_READ_ONLY");
  }
});
it.each([true, false])("test_approval_cannot_expand_public_lookup_scope", background => {
  const config: PolicyConfig = { allowedOrigins: [], allowedActionTypes: ["click"], allowedFieldIds: [], secretFieldIds: [], maxActionsPerTurn: 3, readOnlyWeb: true, publicLookupOnly: background };
  const click = { ...action, type: "click", target: { role: "button", name: "신청방법" }, value: undefined };
  const policy = new PolicyGuard(config).check(click, { ...ctx, publicLookup: !background, approvals: new Set([click.id]) });
  expect(policy.allowed).toBe(false);
  expect(policy.code).not.toBe("NEEDS_CONFIRMATION");
});
it.each(["button", "link", "tab", "scriptlink", "menuitem", "generic"].flatMap(role => (["safe", "any"] as const).map(mode => [role, mode] as const)))(
  "test_read_only_login_needs_approval_for_each_control", (role, mode) => {
    const readOnlyGuard = new PolicyGuard({ ...guard.config, allowedActionTypes: ["click"], readOnlyWeb: true, readOnlyClicks: mode });
    const click = { ...action, type: "click", target: { role, name: "로그인" }, value: undefined };
    const here = { currentUrl: "https://example.org/" };
    expect(readOnlyGuard.check(click, here).code).toBe("NEEDS_CONFIRMATION");
    expect(readOnlyGuard.check(click, { ...here, approvals: new Set([click.id]) }).code).toBe("APPROVED");
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
