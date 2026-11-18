import { expect, it } from "vitest";
import { detectLangSwitch, detectScriptLang, foreignConfirmation, translateIn, translateOut, untranslatedKorean } from "../../src/language/i18n.ts";
import { unsupportedNumbers } from "../../src/safety/verify.ts";
import { FakeLlm } from "../helpers.ts";

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
  for (const text of ["Open 네이버 뉴스.", "gov.kr", "yes"]) expect(detectScriptLang(text)).toBeUndefined();
});

it("test_foreign_confirmation", () => {
  expect(foreignConfirmation("Yes", "en")).toBe("approve");
  expect(foreignConfirmation("Yes, approve", "en")).toBe("approve");
  expect(foreignConfirmation("确认", "zh")).toBe("approve");
  expect(foreignConfirmation("はい、お願いします", "ja")).toBe("approve");
  expect(foreignConfirmation("No", "en")).toBe("reject");
  expect(foreignConfirmation("不要", "zh")).toBe("reject");
  expect(foreignConfirmation("OK open Naver", "en")).toBeUndefined();
  expect(foreignConfirmation("Yes but change the address first", "en")).toBeUndefined();
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
