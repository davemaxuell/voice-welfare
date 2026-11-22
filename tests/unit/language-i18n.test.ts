import { expect, it } from "vitest";
import { fingerprint } from "../../src/agents/web/approval.ts";
import type { Approval, VaultCommand } from "../../src/core/dialogue.ts";
import type { Action } from "../../src/core/actions.ts";
import { LANGS, type PendingConfirmation } from "../../src/core/turn.ts";
import { foreignApproval } from "../../src/core/lexicon.ts";
import { approvalPresentation, detectLangSwitch, detectScriptLang, languagePatterns, parseForeignFieldFill, translateIn, translateOut, untranslatedKorean } from "../../src/language/i18n.ts";
import { unsupportedNumbers } from "../../src/safety/verify.ts";
import { FakeLlm } from "../helpers.ts";
import { codePointSpans } from "./python-spans.ts";

it.each([
  ["영어로 말해줘", "en"], ["Speak English", "en"], ["English please", "en"], ["English, please.", "en"],
  ["Korean, please.", "ko"], ["중국어로 대답해 줘", "zh"], ["说中文", "zh"], ["일본어로 해줘", "ja"],
  ["日本語で話して", "ja"], ["한국어로", "ko"], ["Korean please", "ko"], ["韓国語でお願いします", "ko"],
])("test_lang_switch", (text, lang) => {
  expect(detectLangSwitch(text)).toBe(lang);
});

it("test_lang_name_inside_long_sentence_is_not_command", () => {
  expect(detectLangSwitch("네이버에서 영어로 된 복지 안내 사이트를 찾아서 알려줘")).toBeUndefined();
  expect(detectLangSwitch("영어 사전 열어줘")).toBeUndefined();
});

it("test_script_lang", () => {
  expect(detectScriptLang("What is this website?")).toBe("en");
  expect(detectScriptLang("这个网站是做什么的")).toBe("zh");
  expect(detectScriptLang("このサイトは何ですか")).toBe("ja");
  expect(detectScriptLang("네이버 열어줘")).toBe("ko");
  expect(detectScriptLang("Open 네이버 뉴스.")).toBeUndefined();
  expect(detectScriptLang("gov.kr")).toBeUndefined();
  expect(detectScriptLang("On Gov24 I need a certificate. I am not sure which one.")).toBe("en");
  expect(detectScriptLang("Please open gov.kr.")).toBe("en");
  expect(detectScriptLang("yes")).toBeUndefined();
});

// 기대값은 77aad3e의 Python language/i18n.py로 계산했다.
it.each([
  ["Open Naver", "en"], ["open", "en"], [" OPEN ", "en"], ["Open", "en"], ["English please.", "en"],
  ["Can you find 국가장학금 documents?", "en"], ["정부24에서 certificate 찾아줘", undefined], ["What about 기초연금 and 국민연금?", "en"],
  ["Please open gov.kr.", "en"], ["a.b@c.com x", undefined], ["ﬁnd İt", undefined], ["Kelvin test", "en"], ["１２３ abc def", "en"],
  ["don't stop", "en"], ["yes", undefined], ["", undefined], ["国民年金 申请", "zh"], ["政府24で住民登録謄本", "ja"],
  ["Help me on 정부24 please", "en"], ["it's 한국어 mixed text here", undefined],
])("공공기관 이름을 빼고 글자 종류로 언어를 짐작한다: %j", (text, lang) => {
  expect(detectScriptLang(text)).toBe(lang);
});

it("언어 짐작 정규식의 일치 구간이 Python과 같다", () => {
  const tables: Array<[RegExp, Array<[string, Array<[number, number]>]>]> = [
    [languagePatterns.englishWord, [
      ["don't stop", [[0, 5], [6, 10]]], ["한ab한 ab_ ab", [[9, 11]]], ["İstanbul ıd", [[0, 8]]], ["abc'1 ab'cd1", [[0, 3], [6, 8]]],
      ["x2y z", [[4, 5]]], ["", []], ["ﬁne", []], ["Kelvin", [[0, 6]]], ["ſtop 1abc", [[0, 4]]], ["é café", []],
    ]],
    [languagePatterns.addressLike, [
      ["Please open gov.kr.", [[12, 19]]], ["a@b x", [[0, 3]]], [". x", []], ["end.", []], ["gov24.kr/a b", [[0, 10]]], ["", []],
      ["a　.b", [[2, 4]]],
    ]],
    [languagePatterns.figure, [
      ["1통에 400원", [[0, 1], [4, 7]]], ["3.5%와 1,000,000", [[0, 3], [6, 15]]], ["１２.５", [[0, 4]]], ["v1.2.3.", [[1, 6]]],
      ["", []], ["a,1", [[2, 3]]], ["1..2", [[0, 1], [3, 4]]],
    ]],
    [languagePatterns.otherScript, [["abc가ぁ一", [[0, 1], [1, 2], [2, 3], [4, 5], [5, 6]]], ["ＡＢ", []], ["", []], ["ı", []]]],
  ];
  for (const [expression, rows] of tables) {
    for (const [input, spans] of rows) expect(codePointSpans(expression, input), input).toEqual(spans);
  }
});

it("test_foreign_approval", () => {
  expect(foreignApproval("Yes", "en")).toBe("approve");
  expect(foreignApproval("Yes, approve", "en")).toBe("approve");
  expect(foreignApproval("确认", "zh")).toBe("approve");
  expect(foreignApproval("はい、お願いします", "ja")).toBe("approve");
  expect(foreignApproval("No", "en")).toBe("reject");
  expect(foreignApproval("不要", "zh")).toBe("reject");
  expect(foreignApproval("OK open Naver", "en")).toBeUndefined();
  expect(foreignApproval("Yes but change the address first", "en")).toBeUndefined();
});

it("test_verified_translation_distinguishes_legal_citations_decimals_and_won", async () => {
  const source = "제29조 제2항에 따라 월 30만 원을 받고 수수료율은 3.5%입니다.";
  const correct = "Under Article 29, paragraph 2, you receive 300,000 won a month. The fee rate is 3.5%.";
  expect(await translateOut(new FakeLlm({ translate_out: { text: correct } }), source, "en", undefined, { verified: true })).toBe(correct);
  const changed = correct.replace("3.5%", "3.6%");
  expect(await translateOut(new FakeLlm({ translate_out: { text: changed } }), source, "en", undefined, { verified: true })).toBeUndefined();
});

it("test_verified_translation_retries_with_source_figures_bound_to_the_service", async () => {
  const draft = new FakeLlm({ translate_out: { text: "It costs 400 won per copy." } });
  const reviewer = new FakeLlm({ translate_out: { text: "[[FIG_0]] copy costs [[FIG_1]] won." } });
  const answer = await translateOut(draft, "1통에 400원입니다.", "en", undefined, { verified: true, subject: "주민등록표 등본", reviewer });
  expect(answer).toBe("1 copy costs 400 won.");
  expect(draft.calls).toHaveLength(1);
  expect(reviewer.calls).toHaveLength(1);
  expect(reviewer.calls[0]?.user).toContain("주민등록표 등본");
  expect(reviewer.calls[0]?.user).not.toContain("400");
});

it("test_translation_number_units", () => {
  expect(unsupportedNumbers("每月30万韩元", ["매월 30만 원"])).toEqual([]);
  expect(unsupportedNumbers("月30万ウォン", ["월 300,000원"])).toEqual([]);
  expect(unsupportedNumbers("1.2 million won", ["120만 원"])).toEqual([]);
});

it("test_translate_out_retries_on_changed_numbers", async () => {
  const outputs = ["You get 400,000 won.", "You get 300,000 won a month."];
  const llm = new FakeLlm({}, () => ({ text: outputs.shift() }));
  expect(await translateOut(llm, "매월 30만 원을 받아요.", "en")).toBe("You get 300,000 won a month.");
  expect(llm.calls[1]?.system).toContain("changed or added these numbers");
  const liar = new FakeLlm({ translate_out: { text: "You get 999 won." } });
  expect(await translateOut(liar, "매월 30만 원을 받아요.", "en")).toBeUndefined();
  expect(liar.calls).toHaveLength(2);
});

it("test_translate_out_retries_when_korean_left", async () => {
  const korean = "内容是：“로그아웃 복지소식 복지로 소개 고객센터 사이트맵 검색어를 입력하세요”";
  const chinese = "内容是：“退出 福利新闻 福利路介绍 客服中心”";
  expect(untranslatedKorean("I opened Bokjiro (복지로, a welfare portal).")).toBe(false);
  expect(untranslatedKorean(korean)).toBe(true);
  const outputs = [korean, chinese];
  const llm = new FakeLlm({}, request => ({ text: request.schemaName === "translate_quote" ? korean : outputs.shift() }));
  expect(await translateOut(llm, '내용은 "로그아웃 복지소식 복지로 소개 고객센터"로 시작해요.', "zh")).toBe(chinese);
  expect(llm.calls[2]?.system).toContain("left Korean sentences untranslated");
});

it("번역 모델로 보내는 원문과 웹 인용에서 비밀값을 가린다", async () => {
  const secret = "880101-1234567";
  const llm = new FakeLlm({
    translate_in: { text: "확인해줘" }, translate_quote: { text: "Page text" }, translate_out: { text: "Page text" },
  });
  expect(await translateIn(llm, "Please check " + secret, "en")).toBe("확인해줘");
  await translateOut(llm, `내용은 "복지 신청 방법과 안내 내용을 확인해 주세요 ${secret}"로 시작해요.`, "en");
  expect(llm.calls.map(c => c.schemaName)).toEqual(["translate_in", "translate_quote", "translate_out"]);
  for (const call of llm.calls) expect(call.user).not.toContain(secret);
});

const typedValue = "연습 42 / 555-0100 / $&";
const controlName = "로그인";
const sampleAction: Action = { id: "fixture", type: "click", target: { name: controlName, role: "button" },
  reason: "연습 버튼 누르기", risk: "sensitive", requiresConfirmation: true };
const samplePrint = fingerprint({}, [sampleAction], "원래 승인 문장");
const sampleCard: PendingConfirmation = { actionId: "fixture", site: "연습 사이트", purpose: "원래 목적",
  description: "원래 승인 문장", realSubmission: false, values: [{ label: "이름", value: typedValue }] };
const acting = { action: sampleAction, confirmation: sampleCard, fingerprint: samplePrint };
const examples: [string, Approval | VaultCommand, string][] = [
  ["입력", { ...acting, kind: "assist", actions: [sampleAction] }, "Fill in fields without submitting"],
  ["일반 버튼", { ...acting, kind: "click", url: "http://localhost/" }, "Press the selected button"],
  ["링크", { ...acting, kind: "click", url: "http://localhost/", action: { ...sampleAction, target: { role: "link", name: controlName } } }, "Open the selected link"],
  ["로그인 화면", { ...acting, kind: "click", url: "http://localhost/", then: "login-open" }, "Open the sign-in page"],
  ["로그인 제출", { ...acting, kind: "click", url: "http://localhost/", then: "login-submit" }, "Press the sign-in button"],
  ["모의접수", { ...acting, kind: "submit" }, "Submit the practice disability pension application"],
  ["파일", { kind: "file", confirmation: sampleCard, record: {}, digest: "fixture", question: "" }, "Analyze the downloaded file"],
  ["사진", { kind: "visual", confirmation: sampleCard, goal: "", checkpoint: {} }, "Review an image of this page"],
  ["화면 설명", { kind: "visual", confirmation: { ...sampleCard, purpose: "화면 사진으로 현재 페이지 설명" }, goal: "", checkpoint: {} }, "Describe the current page from a screenshot"],
  ["메뉴 찾기", { kind: "visual", confirmation: { ...sampleCard, purpose: "화면 사진으로 메뉴 찾기" }, goal: "", checkpoint: {} }, "Find a menu in a screenshot"],
  ["안내 링크", { kind: "visual", confirmation: { ...sampleCard, purpose: "화면 사진으로 안내 링크 찾기" }, goal: "", checkpoint: {} }, "Find a guidance link in a screenshot"],
  ["조사", { kind: "research", confirmation: sampleCard, goal: typedValue }, "Research public sources"],
  ["금고 저장", { kind: "vault-save", confirmation: { ...sampleCard, values: [] }, values: { name: typedValue } }, "Save my information"],
  ["금고 삭제", { kind: "vault-clear", confirmation: { ...sampleCard, values: [] } }, "Delete my saved information"],
];
it.each(examples)("%s 승인의 네 언어 문구는 원래 승인과 실행값을 바꾸지 않는다", (_label, waiting, english) => {
  const before = structuredClone(waiting);
  for (const lang of LANGS) {
    const shown = approvalPresentation(waiting, lang, false);
    if (lang === "ko") { expect(shown).toBeUndefined(); continue; }
    expect(shown?.card.actionId).toBe(sampleCard.actionId);
    expect(shown?.card.site).toBe(sampleCard.site);
    expect(shown?.card.purpose).not.toMatch(/[가-힣]/u);
    expect(shown?.card.description).not.toMatch(/[가-힣]/u);
    if (lang === "en") expect(shown?.card.purpose).toBe(english);
    if (waiting.kind === "assist" || waiting.kind === "submit" || waiting.kind === "research") {
      expect(shown?.card.values.map(row => row.value)).toContain(typedValue);
      expect(shown?.speech).toContain(typedValue);
    }
    if (waiting.kind === "click") expect(shown?.card.values.map(row => row.value)).toContain(controlName);
    if (waiting.kind === "vault-save") expect(shown?.card.values).toEqual([]);
  }
  expect(waiting).toEqual(before);
});

it("숫자가 들어간 다국어 입력 요청은 관찰된 입력란으로 직접 맞추고 일반 문자열은 기존 번역을 유지한다", () => {
  const fields = ["이름", "연락처 (선택)", "주민등록 주소"];
  expect(parseForeignFieldFill("Enter Sample 42 555-0100 in the name field", "en", fields))
    .toEqual([{ fieldMention: "이름", value: "Sample 42 555-0100" }]);
  expect(parseForeignFieldFill("Fill phone with 010-5555-0100", "en", fields))
    .toEqual([{ fieldMention: "연락처 (선택)", value: "010-5555-0100" }]);
  expect(parseForeignFieldFill("Fill the name field with Sample 42 and fill the phone field with 010-5555-0100", "en", fields))
    .toEqual([
      { fieldMention: "이름", value: "Sample 42" },
      { fieldMention: "연락처 (선택)", value: "010-5555-0100" },
    ]);
  expect(parseForeignFieldFill("Fill the name field with Sample 42 and click submit", "en", fields)).toBeUndefined();
  expect(parseForeignFieldFill("把示例 42 555-0100 填到姓名栏", "zh", fields))
    .toEqual([{ fieldMention: "이름", value: "示例 42 555-0100" }]);
  expect(parseForeignFieldFill("氏名欄にサンプル42を入力してください", "ja", fields))
    .toEqual([{ fieldMention: "이름", value: "サンプル42" }]);
  expect(parseForeignFieldFill("Put Kim Haneul in the name field", "en", fields)).toBeUndefined();
  expect(parseForeignFieldFill("Enter Sample 42 in the unknown field", "en", fields)).toBeUndefined();
  expect(parseForeignFieldFill("이름 칸에 42 써줘", "ko", fields)).toBeUndefined();
});
