import { expect, it } from "vitest";
import { authPageKind, firstFillField, verificationApp } from "../../src/agents/web/auth_page.ts";

it("test_auth_page_kind_login_by_page_id_and_password", () => {
  expect(authPageKind({ pageId: "mock-login", title: "아무 제목" })).toBe("login");
  expect(authPageKind({ fields: [
    { fieldId: "id", type: "text", visible: true, label: "아이디" },
    { fieldId: "pw", type: "password", visible: true, label: "비밀번호" },
  ] })).toBe("login");
});

it("test_auth_page_kind_login_by_title", () => {
  expect(authPageKind({ title: "회원 로그인" })).toBe("login");
  expect(authPageKind({ title: "Sign in to continue" })).toBe("login");
});

it("test_auth_page_kind_verification_by_title_without_password", () => {
  expect(authPageKind({ title: "본인인증" })).toBe("verification");
  expect(authPageKind({ title: "간편 인증 화면" })).toBe("verification");
});

it("test_auth_page_kind_other_when_not_auth", () => {
  expect(authPageKind({ title: "장애인연금 모의 신청", pageId: "mock-welfare" })).toBe("other");
  expect(authPageKind({ title: "검색 결과" })).toBe("other");
});

it("test_first_fill_field_prefers_non_password", () => {
  const fields = [
    { fieldId: "pw", type: "password", visible: true, label: "비밀번호" },
    { fieldId: "loginId", type: "text", visible: true, label: "아이디" },
  ];
  expect(firstFillField({ fields })?.fieldId).toBe("loginId");
});

it("test_pass_app", () => {
  expect(verificationApp({ title: "PASS 인증" })).toBe("PASS");
  expect(authPageKind({ title: "PASS 인증" })).toBe("verification");
  expect(verificationApp({ mainText: "PASS로 인증하세요" })).toBe("PASS");
  expect(verificationApp({ mainText: "xPASSx" })).toBeUndefined();
});

it("test_kakao_in_button", () => {
  const view = { title: "본인확인", outline: { items: [{ name: "카카오톡 인증", role: "button" as const }] } };
  expect(verificationApp(view)).toBe("카카오톡");
  expect(authPageKind(view)).toBe("verification");
});

it("test_login_not_verification", () => {
  expect(authPageKind({ title: "로그인", fields: [{ visible: true, type: "password", fieldId: "p" }] })).toBe("login");
});
