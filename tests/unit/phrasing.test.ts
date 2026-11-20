import { expect, it } from "vitest";
import {
  chunkText, hasPhoneNumber, josa, phrasingPatterns, readback, speakCallName, speakDate, speakLabel, spellPhoneNumbers,
} from "../../src/speech/phrasing.ts";
import { codePointSpans } from "./python-spans.ts";

it("마지막 발음과 받침으로 조사를 고른다", () => {
  for (const [word, particle] of [["'성명'", "을"], ["주소", "를"], ["PDF", "를"], ["URL", "을"], ["3", "을"], ["4", "를"], ["😀", "를"]] as const) {
    expect(josa(word, "을", "를")).toBe(word + particle);
  }
});

it("본문 길이와 문장 경계는 유니코드 글자 단위로 센다", () => {
  expect(chunkText("😀😀😀😀😀. 다음 문장을 읽어요.", 0, 9)).toBe("😀😀😀😀😀.");
  expect(chunkText("한😀글", 1, 1)).toBe("😀");
  expect(chunkText("문장", 2)).toBe("");
});

it("되읽을 항목만 가리고 날짜와 라벨을 소리 내어 읽을 모양으로 바꾼다", () => {
  expect(readback({ maskOnReadback: true }, "010-1234-5678")).toBe("010-****-5678");
  expect(readback({ maskOnReadback: false }, "서울시")).toBe("서울시");
  expect(speakLabel("연락처 (선택)")).toBe("연락처");
  expect(speakDate("2026-０２-١٣")).toBe("2월 13일");
});

// 기대값은 77aad3e의 Python speech/phrasing.py로 계산했다.
it.each([
  ["고객센터는 1355입니다.", "고객센터는 1 3 5 5입니다."],
  ["051-709-4657로 전화하세요", "0 5 1, 7 0 9, 4 6 5 7로 전화하세요"],
  ["상담 번호는 국번없이 129", "상담 번호는 국번없이 1 2 9"],
  ["문의는 129로 하세요", "문의는 1 2 9로 하세요"],
  ["센터 이용 정원은 100", "센터 이용 정원은 100"],
  ["100분의 1", "100분의 1"],
  ["120시간", "120시간"],
  ["100 만원", "100 만원"],
  ["100 이하", "100 이하"],
  ["120가구", "120가구"],
  ["제102조", "제102조"],
  ["1955-03-02", "1955-03-02"],
  ["1588-1234", "1 5 8 8, 1 2 3 4"],
  ["대표번호 1588 1234 입니다", "대표번호 1 5 8 8, 1 2 3 4 입니다"],
  ["02)123-4567", "0 2, 1 2 3, 4 5 6 7"],
  ["010.1234.5678", "0 1 0, 1 2 3 4, 5 6 7 8"],
  ["전화 ０５１-７０９-４６５７", "전화 ０５１-７０９-４６５７"],
  ["문의 １３５５", "문의 １３５５"],
  ["", ""],
  ["번호는 1355, 그리고 129요", "번호는 1 3 5 5, 그리고 129요"],
  ["3.14 그리고 0.5", "3.14 그리고 0.5"],
  ["2026년 1355번", "2026년 1355번"],
  ["연락처: 1661-2129", "연락처: 1 6 6 1, 2 1 2 9"],
  ["☎ 129", "☎ 1 2 9"],
  ["문의\n129", "문의\n1 2 9"],
  ["031-1234-5678년", "031-1234-5678년"],
  ["1234-5678", "1 2 3 4, 5 6 7 8"],
])("전화번호만 한 자리씩 끊어 읽는다: %j", (text, spoken) => {
  expect(spellPhoneNumbers(text)).toBe(spoken);
});

it("전화번호가 있는 문장과 부르는 이름을 Python과 같이 고른다", () => {
  for (const [text, found] of [
    ["고객센터는 1355입니다.", true], ["센터 이용 정원은 100", false], ["051-709-4657", true], ["", false],
    ["120가구", false], ["문의 １３５５", false], ["1588-1234", true], ["번호 129번", true], ["전화 129예요", true],
  ] as const) expect(hasPhoneNumber(text), text).toBe(found);
  for (const [name, spoken] of [["길동", "길동님"], ["길동님", "길동님"], ["", "님"], ["님", "님"], ["홍 길동 님", "홍 길동 님"]] as const) {
    expect(speakCallName(name)).toBe(spoken);
  }
});

it("전화번호 정규식의 일치 구간이 Python과 같다", () => {
  const tables: Array<[RegExp, Array<[string, Array<[number, number]>]>]> = [
    [phrasingPatterns.fullPhone, [
      ["051-709-4657", [[0, 12]]], ["1588-1234", [[0, 9]]], ["02)123-4567", [[0, 11]]], ["1955-03-02", []],
      ["전화 ０５１-７０９-４６５７", []], ["", []], ["0101234567년", []], ["1.051-709-4657", []], ["010-1234-5678생", []],
    ]],
    [phrasingPatterns.barePhone, [
      ["1355", [[0, 4]]], ["129로", [[0, 3]]], ["100분", []], ["120 가구", []], ["1355\n", [[0, 4]]], ["129.", [[0, 3]]],
      ["129,5", []], ["129번 129예 129입", [[0, 3], [5, 8], [10, 13]]], ["１２９", []], ["12", []], ["가129", [[1, 4]]],
      ["100 이하", []], ["100이상", []],
    ]],
    [phrasingPatterns.cueBefore, [
      ["고객센터는 ", [[2, 6]]], ["상담 번호는 국번없이 ", [[3, 12]]], ["문의는", [[0, 3]]], ["☎ ", [[0, 2]]], ["센터 ", [[0, 3]]],
      ["연락처:", [[0, 4]]], ["번호", [[0, 2]]], ["전화 국번 없이 ", [[0, 9]]], ["정원은 ", []], ["", []],
    ]],
  ];
  for (const [expression, rows] of tables) {
    for (const [input, spans] of rows) expect(codePointSpans(expression, input), input).toEqual(spans);
  }
});
