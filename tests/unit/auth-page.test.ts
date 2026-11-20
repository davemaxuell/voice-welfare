import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { authPageKind, firstFillField, verificationApp } from "../../src/agents/web/auth_page.ts";
import { WebObservationSchema, type WebObservation } from "../../src/agents/web/view.ts";

// 공개 복지로 화면의 실제 관찰(2026-11-19). 모든 화면 머리말에 '공동인증서 내보내기' 단추가 있다.
const bokjiro = z.object({ detail: WebObservationSchema, home: WebObservationSchema }).parse(
  JSON.parse(readFileSync(new URL("../fixtures/bokjiro-public-pages.json", import.meta.url), "utf8")),
);

function view(extra: WebObservation = {}): WebObservation {
  return { pageId: "external", title: "일반 페이지", fields: [], url: "https://example.org/", ...extra };
}

const buttons = (names: readonly string[]) => names.map(name => ({ role: "button" as const, name }));

it("test_auth_page_kind_login_by_page_id_and_password", () => {
  expect(authPageKind(view({ pageId: "mock-login", title: "아무 제목" }))).toBe("login");
  expect(authPageKind(view({ fields: [
    { fieldId: "id", type: "text", visible: true, label: "아이디" },
    { fieldId: "pw", type: "password", visible: true, label: "비밀번호" },
  ] }))).toBe("login");
});

it("test_auth_page_kind_login_by_title", () => {
  expect(authPageKind(view({ title: "회원 로그인" }))).toBe("login");
  expect(authPageKind(view({ title: "Sign in to continue" }))).toBe("login");
});

it("test_auth_page_kind_verification_by_title_without_password", () => {
  expect(authPageKind(view({ title: "본인인증" }))).toBe("verification");
  expect(authPageKind(view({ title: "간편 인증 화면" }))).toBe("verification");
});

it("test_auth_page_kind_other_when_not_auth", () => {
  expect(authPageKind(view({ title: "장애인연금 모의 신청", pageId: "mock-welfare" }))).toBe("other");
  expect(authPageKind(view({ title: "검색 결과" }))).toBe("other");
});

it("test_first_fill_field_prefers_non_password", () => {
  const fields = [
    { fieldId: "pw", type: "password", visible: true, label: "비밀번호" },
    { fieldId: "loginId", type: "text", visible: true, label: "아이디" },
  ];
  expect(firstFillField(view({ fields }))?.fieldId).toBe("loginId");
});

it("test_verification_clue_is_read_from_observed_main_text", () => {
  const page = view({ title: "확인", outline: { mainText: "PASS 인증으로 본인 확인을 진행합니다.", items: [] } });
  expect(authPageKind(page)).toBe("verification");
});

it.each(["detail", "home"] as const)("test_public_page_with_certificate_button_is_not_an_auth_screen", page => {
  expect(authPageKind(bokjiro[page])).toBe("other");
});

it("test_real_gate_on_the_same_site_still_hands_off", () => {
  const home = bokjiro.home;
  const password = { fieldId: "pw", type: "password", visible: true, label: "비밀번호" };
  expect(authPageKind({ ...home, fields: [...(home.fields ?? []), password] })).toBe("login");
  expect(authPageKind({ ...home, title: "로그인 | 복지로" })).toBe("login");
  expect(authPageKind({ ...home, title: "본인인증 | 복지로" })).toBe("verification");
  const dialog = { title: "인증서 선택", text: "인증서 선택 금융인증서 공동인증서 닫기", buttons: ["금융인증서", "공동인증서", "닫기"] };
  const items = dialog.buttons.map((name, index) => ({ ref: `d${index}`, role: "button" as const, name }));
  const opened = { ...home, dialogs: [dialog], outline: { ...home.outline, items: [...(home.outline?.items ?? []), ...items] } };
  expect(authPageKind(opened)).toBe("verification");
  expect(verificationApp(opened)).toBe("금융인증서");
});

it.each([
  [["카카오톡 인증", "PASS 인증", "네이버 인증", "공동인증서"]],
  [["공동인증서 로그인", "금융인증서 로그인", "간편인증 로그인"]],
])("test_certificate_login_buttons_without_a_telling_title_are_verification", names => {
  expect(authPageKind(view({ title: "우리시청 누리집", outline: { items: buttons(names), mainText: "" } }))).toBe("verification");
});

it("test_certificate_tool_buttons_alone_are_not_verification", () => {
  const names = ["공동인증서 내보내기", "인증서 가져오기", "금융인증서 발급 안내"];
  expect(authPageKind(view({ outline: { items: buttons(names), mainText: "" } }))).toBe("other");
});

it("test_sms_code_page_is_verification", () => {
  const page = view({
    title: "휴대폰 인증 | 우리시청",
    fields: [
      { fieldId: "name", type: "text", visible: true, label: "이름" },
      { fieldId: "code", type: "text", visible: true, label: "인증번호 6자리" },
    ],
    outline: { items: buttons(["SKT", "KT", "인증번호 받기", "확인"]), mainText: "" },
  });
  expect(authPageKind(page)).toBe("verification");
});

const otherScreens: WebObservation[] = [
  { title: "휴대폰 본인 확인" },
  { outline: { items: buttons(["카카오톡", "네이버", "토스"]), mainText: "간편인증 서비스를 선택해 주세요" } },
  { outline: { items: buttons(["아이디 로그인", "인증서 로그인", "간편 로그인"]), mainText: "" } },
];
it.each(otherScreens)("test_other_real_verification_screens", extra => {
  expect(["verification", "login"]).toContain(authPageKind(view(extra)));
});

it.each([
  "주민등록표 등본 발급. 공동·금융인증서 또는 간편인증으로 로그인이 필요합니다.",
  "온라인 신청은 공동인증서로 로그인한 뒤 신청하세요.",
  "PASS 앱이 있으면 더 편하게 신청할 수 있습니다.",
])("test_guide_text_describing_certificates_is_not_a_gate", body => {
  expect(authPageKind(view({ title: "주민등록표 등본(초본) 교부 | 정부24", outline: { items: [], mainText: body } }))).toBe("other");
});

it.each([
  "PASS 인증으로 본인 확인을 진행합니다.", "휴대폰에서 PASS 앱으로 인증하세요.", "공동인증서를 선택해 주세요.",
  "PASS 앱에서 인증을 완료한 뒤 확인을 눌러 주세요.",
])("test_body_instruction_to_verify_now_is_a_gate", body => {
  expect(authPageKind(view({ title: "확인", outline: { items: [], mainText: body } }))).toBe("verification");
});

it("test_pass_app", () => {
  const page = { title: "PASS 인증", fields: [], outline: { items: [], mainText: "" } };
  expect(verificationApp(page)).toBe("PASS");
  expect(authPageKind(page)).toBe("verification");
  // 한글이 바로 이어져도 ASCII 단어로 본다
  const glued = { title: "", fields: [], outline: { items: [], mainText: "PASS로 인증하세요" } };
  expect(verificationApp(glued)).toBe("PASS");
  expect(verificationApp({ ...glued, outline: { items: [], mainText: "xPASSx" } })).toBeUndefined();
});

it("test_kakao_in_button", () => {
  const page = { title: "본인확인", fields: [], outline: { items: buttons(["카카오톡 인증"]), mainText: "" } };
  expect(verificationApp(page)).toBe("카카오톡");
  expect(authPageKind(page)).toBe("verification");
});

it("test_login_not_verification", () => {
  expect(authPageKind({ title: "로그인", fields: [{ visible: true, type: "password", fieldId: "p" }] })).toBe("login");
});
