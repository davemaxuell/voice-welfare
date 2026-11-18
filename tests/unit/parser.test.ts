import { expect, it } from "vitest";
import { RuleBasedIntentProvider, cleanValue, isStopUtterance, isProgressQuestion } from "../../src/understanding/rules.ts";
import { resolveSite, siteLabel } from "../../src/understanding/sites.ts";
import { stripAddress } from "../../src/understanding/filters.ts";
import { practiceVocabulary } from "./understanding-rules-regex.ts";

const parser = new RuleBasedIntentProvider(practiceVocabulary);
function parse(text: string, state = "APPLICATION_OPEN", awaitingFieldId?: string) {
  return parser.parseSync(text, { state, awaitingFieldId });
}

it.each([
  ["장애인연금 신청 도와줘", "START_APPLICATION"],
  ["신청 페이지를 열어줘", "START_APPLICATION"],
  ["주소 다시 읽어줘", "READ_FIELD"],
  ["다음으로", "NEXT"],
  ["이전으로", "PREV"],
  ["이 항목은 무슨 뜻이야?", "EXPLAIN"],
  ["지금까지 쓴 내용 읽어줘", "REVIEW"],
  ["모의 접수 내용을 확인했어", "PREPARE_SUBMIT"],
  ["최종 확인할게", "PREPARE_SUBMIT"],
  ["제출해", "PREPARE_SUBMIT"],
  ["모의접수 승인", "APPROVE"],
  ["승인 안 해", "REJECT"],
  ["멈춰", "STOP"],
  ["다시 시작", "RESUME"],
  ["로그인하고 싶어", "LOGIN"],
  ["주소 수정할게", "EDIT_FIELD"],
  ["현재 단계 알려줘", "CURRENT_STEP"],
  ["화면 설명해줘", "DESCRIBE_SCREEN"],
  ["지금 화면에 뭐가 있어?", "DESCRIBE_SCREEN"],
  ["장애인연금 신청 화면 설명해줘", "DESCRIBE_SCREEN"],
  ["127.0.0.1:5174/portal2.html에서 복지지도 메뉴를 열어서 무슨 화면인지 알려줘", "GOAL"],
  ["복지로 가서 첫 화면에 뭐가 있는지 알려줘", "GOAL"],
  ["이 화면에서 기초연금 신청 방법 읽어줘", "DESCRIBE_SCREEN"],
  ["지금 복지로에서 어느 단계야?", "CURRENT_STEP"],
  ["네이버에서 지금 화면 설명해줘", "DESCRIBE_SCREEN"],
  ["이 사이트 뭐 하는 곳이야? 네이버에서 들어왔어", "ABOUT_SITE"],
  ["장애인연금 지원대상과 신청 절차 알려줘", "POLICY_QUESTION"],
  ["장애인연금 지금 신청할 수 있어?", "POLICY_QUESTION"],
  ["지금 신청할 수 있어?", "POLICY_QUESTION"],
  ["상담원 연결해줘", "HELP_HUMAN"],
  ["오늘 날씨 어때", "UNKNOWN"],
] as const)("test_intents", (text, expected) => {
  expect(parse(text).type).toBe(expected);
});

it.each([
  "지금 어디까지 했어?",
  "청음아, 어디까지 됐어?",
  "얼마나 남았어?",
  "아직 멀었어?",
  "지금 뭐 하고 있어?",
] as const)("test_progress_question_is_rule_based", (text) => {
  expect(isProgressQuestion(text)).toBe(true);
  expect(parse(text, "BROWSING")).toEqual({ type: "PROGRESS" });
});

it.each([
  "신청 기한 얼마나 남았어?",
  "지금 어느 단계야?",
  "본문 어디까지 읽었어?",
  "지금 어디까지 했어 그리고 네이버 열어줘",
] as const)("test_not_a_progress_question", (text) => {
  expect(isProgressQuestion(text)).toBe(false);
});

it.each([
  ["이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10, 다음으로 넘어가줘", 3],
  ["복지로 열어줘 그리고 기초연금 검색해줘", 2],
  ["이름은 김하늘", 1],
] as const)("test_split_commands", (text, count) => {
  expect(parser.splitCommands(text)).toHaveLength(count);
});

it.each([
  ["뭐라고 말하면 돼?", false],
  ["뭐라고 해야 돼?", false],
  ["뭘 할 수 있어?", false],
  ["넌 뭘 할 수 있어?", false],
  ["무슨 말 할 수 있어?", false],
  ["도움말", false],
  ["사용법 알려줘", false],
  ["명령어 알려줘", false],
  ["명령어 뭐가 있어?", false],
  ["다른 말도 알려줘", true],
  ["다른 명령어도 알려줘", true],
  ["도움말 더", true],
] as const)("test_what_can_i_say", (text, more) => {
  expect(parse(text)).toEqual({ type: "WHAT_CAN_I_SAY", more });
});

it.each([
  ["다른 거 알려줘", "UNKNOWN"],
  ["이 사이트에서 뭘 할 수 있어?", "ABOUT_SITE"],
  ["도움 요청할래", "HELP_HUMAN"],
  ["어떻게 해야 돼?", "UNKNOWN"],
] as const)("test_not_help", (text, type) => {
  expect(parse(text, "BROWSING").type).toBe(type);
  expect(parse("다른 말로 해줘").type).not.toBe("WHAT_CAN_I_SAY");
});

it.each([
  ["복지로 열어줘", {"type":"OPEN_SITE"}],
  ["정부24 들어가줘", {"type":"OPEN_SITE"}],
  ["gov.kr 열어줘", {"type":"OPEN_SITE"}],
  ["모의 사이트 열어줘", {"type":"OPEN_SITE"}],
  ["본문 읽어줘", {"type":"READ_MAIN","more":false}],
  ["계속 읽어줘", {"type":"READ_MAIN","more":true}],
  ["링크 목록 알려줘", {"type":"LIST_LINKS","more":false}],
  ["링크 더 알려줘", {"type":"LIST_LINKS","more":true}],
  ["장애인연금 안내 링크 눌러줘", {"type":"FOLLOW_LINK","name":"장애인연금 안내"}],
  ["'자세히 보기' 눌러줘", {"type":"FOLLOW_LINK","name":"자세히 보기"}],
  ["신청방법 탭 눌러줘", {"type":"FOLLOW_LINK","name":"신청방법"}],
  ["지원대상 눌러줘", {"type":"FOLLOW_LINK","name":"지원대상"}],
  ["뒤로 가줘", {"type":"PREV"}],
  ["장애인연금 검색해줘", {"type":"SEARCH","query":"장애인연금"}],
  ["복지로에서 기초연금 검색해줘", {"type":"SEARCH","query":"기초연금","site":"복지로"}],
] as const)("test_browsing_commands", (text, expected) => {
  expect(parse(text, "BROWSING")).toMatchObject(expected);
});

it.each([
  ["청음아, 화면 설명해줘", "화면 설명해줘"],
  ["청음아 멈춰", "멈춰"],
  ["청음이야 다음으로", "다음으로"],
  ["청음, 뒤로 가줘", "뒤로 가줘"],
  ["청음이! 이름은 김하늘", "이름은 김하늘"],
  ["청음아.", ""],
  ["청음이 뭐야?", "청음이 뭐야?"],
  ["청음", "청음"],
  ["화면 설명해줘", "화면 설명해줘"],
] as const)("test_strip_address", (said, rest) => {
  expect(stripAddress(said)).toBe(rest);
});

it("test_field_and_value_split", () => {
  expect(parse("이름은 김하늘")).toEqual({ type: "FILL", fills: [{ fieldMention: "이름", value: "김하늘" }] });
  expect(parse("주소는 부산광역시 예시구 예시로 10")).toEqual({
    type: "FILL", fills: [{ fieldMention: "주소", value: "부산광역시 예시구 예시로 10" }],
  });
  expect(parse("이름은 김하늘이야")).toMatchObject({ fills: [{ value: "김하늘" }] });
});

it("test_multiple_fields_in_one_sentence", () => {
  expect(parse("이름은 김하늘, 주소는 부산광역시 예시구 예시로 10")).toMatchObject({
    type: "FILL", fills: [{ fieldMention: "이름" }, { fieldMention: "주소" }],
  });
});

it("test_specific_alias_beats_generic", () => {
  expect(parse("실거주지 주소는 서울특별시 예시구 예시로 5")).toMatchObject({
    fills: [{ fieldMention: "실거주지 주소", value: "서울특별시 예시구 예시로 5" }],
  });
});

it("test_edit_with_value_is_fill", () => {
  expect(parse("주소 수정해 부산광역시 예시구 예시로 20")).toEqual({
    type: "FILL", fills: [{ fieldMention: "주소", value: "부산광역시 예시구 예시로 20" }],
  });
});

it("test_awaiting_value_long_address_not_navigation", () => {
  expect(parse("서울특별시 이전구 다음로 3", "AWAITING_FIELD_VALUE", "address").type).toBe("UNKNOWN");
});

it("test_stop_is_rule_based", () => {
  expect(isStopUtterance("잠깐 멈춰")).toBe(true);
  expect(isStopUtterance("취소")).toBe(true);
  expect(isStopUtterance("멈추지 마")).toBe(false);
});

it("test_clean_value", () => {
  expect(cleanValue('"김하늘"이라고 써줘')).toBe("김하늘");
  expect(cleanValue("3명으로 해줘")).toBe("3명");
});

it("test_rephrase", () => {
  expect(parse("무슨 말이야?").type).toBe("REPHRASE");
  expect(parse("다시 말해줘").type).toBe("REPHRASE");
  expect(parse("주소 다시 말해줘").type).toBe("READ_FIELD");
});

it("test_listed_service_is_not_field_explanation", () => {
  expect(parse("두 번째 제도 설명해줘", "IDLE").type).toBe("UNKNOWN");
  expect(parse("가구원 수가 무슨 뜻이야?")).toEqual({ type: "EXPLAIN", fieldMention: "가구원 수" });
});

it("test_browsing_does_not_clash", () => {
  expect(parse("지금까지 쓴 내용 읽어줘", "BROWSING").type).toBe("REVIEW");
  expect(parse("장애인연금 신청 도와줘", "BROWSING").type).toBe("START_APPLICATION");
  expect(parse("신청 페이지를 열어줘", "BROWSING").type).toBe("START_APPLICATION");
  expect(parse("로그인 페이지 열어줘", "BROWSING").type).toBe("LOGIN");
  expect(parse("로그아웃해줘", "BROWSING").type).toBe("CLEAR_LOGIN");
  expect(parse("로그인 기록 지워줘", "BROWSING").type).toBe("CLEAR_LOGIN");
});

it("test_resolve_site", () => {
  expect(resolveSite("복지로 열어줘")?.url).toBe("https://www.bokjiro.go.kr");
  expect(resolveSite("국민연금공단 사이트")?.url).toBe("https://www.nps.or.kr");
  expect(resolveSite("gov.kr 열어줘")?.url).toBe("https://gov.kr");
  expect(resolveSite("127.0.0.1:5174/external.html 열어줘")?.url).toBe("http://127.0.0.1:5174/external.html");
  expect(resolveSite("우리동네복지관 열어줘")).toBeUndefined();
});

it("test_resolve_site_stt_variants", () => {
  expect(resolveSite("Naver 열어줘")?.url).toBe("https://www.naver.com");
  expect(resolveSite("네이보 열어줘")?.url).toBe("https://www.naver.com");
  expect(resolveSite("복지루 들어가줘")?.url).toBe("https://www.bokjiro.go.kr");
  expect(resolveSite("naver news 열어줘")?.url).toBe("https://news.naver.com");
  expect(resolveSite("우리동네복지관 열어줘")).toBeUndefined();
});

it("test_site_label", () => {
  expect(siteLabel("https://www.bokjiro.go.kr/ssis-tbu/index.do")).toBe("복지로");
  expect(siteLabel("https://search.naver.com/search.naver?query=x")).toBe("네이버");
  expect(siteLabel("https://news.naver.com/main")).toBe("네이버 뉴스");
  expect(siteLabel("https://www.example.org/a")).toBe("example.org");
  expect(siteLabel("http://localhost:5174/", [
    { names: ["모의 사이트"], url: "http://localhost:5174/index.html", label: "모의 복지 신청 사이트" },
  ])).toBe("모의 복지 신청 사이트");
  expect(siteLabel("")).toBe("");
});
