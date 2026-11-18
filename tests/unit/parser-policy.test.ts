import { expect, it } from "vitest";
import { ACTION_TYPES } from "../../src/core/actions.ts";
import { PolicyGuard, isActionName } from "../../src/safety/guard.ts";

const guard = new PolicyGuard({
  allowedOrigins: ["http://localhost:5174"], allowedActionTypes: ACTION_TYPES,
  allowedFieldIds: ["applicantName"], secretFieldIds: ["loginPassword"], maxActionsPerTurn: 10, readOnlyWeb: true,
});
const ctx = { currentUrl: "https://example.org/" };
const action = { id: "x", type: "click", reason: "t", risk: "low", requiresConfirmation: false };

it("test_tiers", () => {
  expect(guard.tierOf("http://localhost:5174/apply.html")).toBe("full");
  expect(guard.tierOf("https://www.bokjiro.go.kr/")).toBe("read-only");
  expect(guard.tierOf("file:///etc/passwd")).toBe("none");
  expect(guard.tierOf("javascript:alert(1)")).toBe("none");
});
it.each([
  { name: "다른 사이트로 이동", overrides: {type: "navigate",url: "https://www.gov.kr/"}, code: "ALLOWED_READ_ONLY" },
  { name: "링크 클릭", overrides: {target: {role: "link",name: "복지서비스"}}, code: "ALLOWED_READ_ONLY" },
  { name: "뒤로", overrides: {type: "back"}, code: "ALLOWED_READ_ONLY" },
  { name: "검색창 입력", overrides: {type: "fill",target: {role: "searchbox",fieldId: "q"},value: "장애인연금"}, code: "ALLOWED_READ_ONLY" },
  { name: "검색 실행", overrides: {type: "press",target: {role: "searchbox",fieldId: "q"},value: "Enter"}, code: "ALLOWED_READ_ONLY" },
  { name: "버튼 클릭", overrides: {target: {role: "button",name: "보내기"}}, code: "DENIED_READ_ONLY" },
  { name: "로그인 버튼은 묻고 누른다", overrides: {target: {role: "button",name: "로그인"}}, code: "NEEDS_CONFIRMATION" },
  { name: "로그인 링크도 묻고 누른다", overrides: {target: {role: "link",name: "로그인"}}, code: "NEEDS_CONFIRMATION" },
  { name: "초점 옮기기", overrides: {type: "focus",target: {role: "button",name: "로그인"}}, code: "ALLOWED_READ_ONLY" },
  { name: "로그아웃은 막는다", overrides: {target: {role: "button",name: "로그아웃"}}, code: "DENIED_READ_ONLY" },
  { name: "실제 신청은 막는다", overrides: {target: {role: "button",name: "신청하기"}}, code: "DENIED_READ_ONLY" },
  { name: "정보 이름 탭(safe)", overrides: {target: {role: "tab",name: "신청방법"}}, code: "ALLOWED_READ_ONLY" },
  { name: "동작 이름 탭(safe)", overrides: {target: {role: "tab",name: "온라인 신청하기"}}, code: "DENIED_READ_ONLY" },
  { name: "정보 이름 스크립트 링크(safe)", overrides: {target: {ref: "r2",role: "scriptlink",name: "신청방법"}}, code: "ALLOWED_READ_ONLY" },
  { name: "동작 이름 스크립트 링크(safe)", overrides: {target: {ref: "r3",role: "scriptlink",name: "회원 탈퇴"}}, code: "DENIED_READ_ONLY" },
  { name: "주소 있는 링크는 이름과 상관없이(safe)", overrides: {target: {role: "link",name: "회원 탈퇴 안내"}}, code: "ALLOWED_READ_ONLY" },
  { name: "메뉴 항목(safe)", overrides: {target: {role: "menuitem",name: "복지서비스"}}, code: "ALLOWED_READ_ONLY" },
  { name: "동작 메뉴 항목(safe)", overrides: {target: {role: "menuitem",name: "신청"}}, code: "DENIED_READ_ONLY" },
  { name: "역할 없는 요소(safe)", overrides: {target: {ref: "r1",role: "generic",name: "체험관 둘러보기"}}, code: "DENIED_READ_ONLY" },
  { name: "이름 없는 ref", overrides: {target: {ref: "r1"}}, code: "DENIED_SCHEMA" },
  { name: "일반 입력란", overrides: {type: "fill",target: {label: "이름",fieldId: "n"},value: "김하늘"}, code: "DENIED_READ_ONLY" },
  { name: "선택", overrides: {type: "select",target: {fieldId: "s"},value: "1"}, code: "DENIED_READ_ONLY" },
  { name: "Enter 외 키", overrides: {type: "press",target: {role: "searchbox",fieldId: "q"},value: "Tab"}, code: "DENIED_READ_ONLY" },
  { name: "검색어에 주민번호", overrides: {type: "fill",target: {role: "searchbox",fieldId: "q"},value: "900101-1234567"}, code: "DENIED_SECRET" },
  { name: "중요 동작", overrides: {target: {role: "link",name: "x"},risk: "consequential",requiresConfirmation: true}, code: "DENIED_READ_ONLY" },
  { name: "파일 주소 이동", overrides: {type: "navigate",url: "file:///etc/hosts"}, code: "DENIED_ORIGIN" },
])("test_read_only_policy", ({ overrides, code }) => {
  expect(guard.check({ ...action, ...overrides }, ctx).code).toBe(code);
});
it("test_read_only_login_click_runs_after_approval", () => {
  expect(guard.check({ ...action, target: { role: "button", name: "로그인" } },
    { ...ctx, approvals: new Set(["x"]) }).code).toBe("APPROVED");
});
it.each([
  ["신청방법", false],
  ["신청 안내", false],
  ["제출서류", false],
  ["지원대상", false],
  ["서비스 내용", false],
  ["신청 자격", false],
  ["신청하기", true],
  ["온라인 신청하기", true],
  ["신청", true],
  ["회원 탈퇴", true],
  ["결제 정보", true],
  ["로그인", true],
  ["신청하기 새창", true],
  ["신청하기 >", true],
  ["신청서 제출", true],
  ["임시 저장", true],
  ["전체 동의", true],
  ["본인 인증", true],
  ["가입", true],
  ["Send", true],
  ["Confirm", true],
  ["Sign in", true],
] as const)("test_action_names", (name, expected) => {
  expect(isActionName(name)).toBe(expected);
});
const anyGuard = new PolicyGuard({ ...guard.config, readOnlyClicks: "any" });
it("test_read_only_any_clicks_allows_every_click_but_not_input", () => {
  for (const target of [{ role: "tab", name: "신청방법" }, { ref: "r1", role: "generic", name: "체험관" }, { role: "button", name: "보내기" }]) {
    expect(anyGuard.check({ ...action, target }, ctx).code).toBe("ALLOWED_READ_ONLY");
  }
  expect(anyGuard.check({ ...action, type: "fill", target: { label: "이름", fieldId: "n" }, value: "김하늘" }, ctx).code).toBe("DENIED_READ_ONLY");
  expect(anyGuard.check({ ...action, target: { role: "link", name: "x" }, risk: "consequential", requiresConfirmation: true }, ctx).code).toBe("DENIED_READ_ONLY");
});
it("test_read_only_any_clicks_still_asks_before_login", () => {
  for (const role of ["button", "link"]) {
    expect(anyGuard.check({ ...action, target: { role, name: "로그인" } }, ctx).code).toBe("NEEDS_CONFIRMATION");
  }
});
it("test_read_only_off_means_supported_sites_only", () => {
  const strict = new PolicyGuard({ ...guard.config, readOnlyWeb: false });
  expect(strict.tierOf("https://www.gov.kr/")).toBe("none");
});
const assistGuard = new PolicyGuard({ ...guard.config, allowedFieldIds: [], secretFieldIds: [] });
const assist = { id: "f1", type: "fill", target: { fieldId: "x", name: "이름" }, value: "김하늘", reason: "t", risk: "sensitive", requiresConfirmation: true };
const approved = { ...ctx, approvals: new Set(["f1"]) };
it("test_assist_needs_approval", () => {
  expect(assistGuard.check(assist, ctx).code).toBe("NEEDS_CONFIRMATION");
  expect(assistGuard.check(assist, approved).code).toBe("APPROVED");
});
it("test_assist_secret_always_denied", () => {
  expect(assistGuard.check({ ...assist, target: { fieldId: "p", name: "비밀번호" } }, approved).code).toBe("DENIED_SECRET");
  expect(assistGuard.check({ ...assist, value: "900101-1234567" }, approved).code).toBe("DENIED_SECRET");
});
it("test_assist_low_risk_input_denied", () => {
  expect(assistGuard.check({ ...assist, risk: "low", requiresConfirmation: false }, approved).code).toBe("DENIED_READ_ONLY");
});
