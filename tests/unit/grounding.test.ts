import { expect, it } from "vitest";
import { redactText } from "../../src/safety/privacy.ts";
import { checkGrounding, quoteInSource, unsupportedNumbers, extractNumbers } from "../../src/safety/verify.ts";

it("test_quote_tolerates_spacing_punctuation_endings", () => {
  const source = "신청은 주소지 행정복지센터나 온라인으로 할 수 있습니다. 필요한 서류는 기관마다 다릅니다.";
  expect(quoteInSource("신청은 주소지 행정복지센터나 온라인으로 할 수 있습니다", source)).toBe(true);
  expect(quoteInSource('"신청은 주소지  행정복지센터나 온라인으로 할 수 있어요."', source)).toBe(true);
});
it("test_quote_not_in_source_or_too_short", () => {
  const source = "신청은 주소지 행정복지센터나 온라인으로 할 수 있습니다.";
  expect(quoteInSource("신청은 우체국에서만 받습니다", source)).toBe(false);
  expect(quoteInSource("신청", source)).toBe(false);
});
it("test_units_converted", () => {
  expect(unsupportedNumbers("매월 30만 원을 받아요.", ["기준액 300,000원"])).toEqual([]);
  expect(unsupportedNumbers("기준액은 300,000원이에요.", ["기준액 30만원"])).toEqual([]);
  expect(unsupportedNumbers("1억 2천만 원 이하", ["재산 120,000,000원 이하"])).toEqual([]);
  expect(unsupportedNumbers("４０만 원", ["기준액 30만원"])).toEqual(["４０만"]);
});
it("test_unsupported_amounts_and_phones", () => {
  expect(unsupportedNumbers("매월 40만 원이에요.", ["기준액 300,000원"])).toEqual(["40만"]);
  expect(unsupportedNumbers("1588-1234로 전화하세요.", ["문의 1588-0000"])).toEqual(["15881234"]);
});
it("test_small_numbers_ignored", () => {
  expect(unsupportedNumbers("두 가지 중 1번이 맞아요.", ["아무 숫자 없음"])).toEqual([]);
});
it("test_dates", () => {
  expect(extractNumbers("2026.1.1").values.has(2026)).toBe(true);
  expect(unsupportedNumbers("2026년 1월부터예요.", ["시행일 2026.1.1"])).toEqual([]);
});
it("test_check_grounding", () => {
  expect(checkGrounding({ answer: "만 65세 이상이면 대상이에요.", quotes: ["만 65세 이상"], sources: ["대상: 만 65세 이상 어르신"] }).ok).toBe(true);
  expect(checkGrounding({ answer: "대상이에요.", quotes: [], sources: ["대상: 만 65세 이상"] }).reasons).toContain("근거 문장이 없음");
  expect(checkGrounding({ answer: "70세면 해당돼요.", sources: ["만 65세 이상"], allowed: ["70세인데 받을 수 있어?"], minQuotes: 0 }).ok).toBe(true);
});
it("test_grounding_still_passes_on_unredacted_page_copy", () => {
  const rrn = "900101-1234567";
  const raw = "대상은 만 65세 이상입니다. 주민번호 " + rrn + ".";
  expect(redactText(raw)).not.toContain(rrn);
  const answer = "대상은 만 65세 이상입니다.";
  expect(checkGrounding({ answer, quotes: [answer], sources: [raw], allowed: ["나이 조건이 뭐야?"] }).ok).toBe(true);
});
it.each([["5 MİLLİON", "5백만 원"], ["3 thouſand", "3천 원"], ["2 bİllion", "20억 원"]])("test_lookalike_unit_letters_read_as_plain_unit %s", (source, answer) => {
  expect(unsupportedNumbers(`지원금은 ${answer}이에요`, [source])).toEqual([]);
});
