import { expect, it } from "vitest";
import { detectSensitive, privacyPatterns, redactPictureText } from "../../src/safety/privacy.ts";

function spans(pattern: RegExp, text: string) {
  const units = new Map([[0, 0]]);
  let offset = 0;
  for (const character of text) units.set(offset += character.length, units.size);
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))]
    .map(match => [units.get(match.index), units.get(match.index + match[0].length)]);
}

// Python privacy.py VALUE_PATTERNS[0]와 PICTURE_CONTACT의 finditer 구간(코드 포인트)
it("the tvly key pattern uses Python's Unicode word boundary", () => {
  const T = "tvly-abcdefghijkl";
  const expected: Record<string, number[][]> = {
    [T]: [[0, 17]], [" " + T]: [[1, 18]], ["키" + T]: [], ["a" + T]: [], ["1" + T]: [], ["_" + T]: [], ["-" + T]: [[1, 18]],
    ["ä" + T]: [], ["́" + T]: [], ["‿" + T]: [], ["‍" + T]: [], ["²" + T]: [[1, 18]], ["Ⅳ" + T]: [], ["·" + T]: [[1, 18]],
    ["١" + T]: [], ["(" + T]: [[1, 18]], [" " + T]: [[1, 18]], ["한글" + T]: [], "tvly-short": [], "TVLY-abcdefghijkl": [], "tvly-abcdefghijklé": [[0, 17]],
  };
  for (const [text, expectedSpans] of Object.entries(expected)) expect(spans(privacyPatterns.apiKey, text), JSON.stringify(text)).toEqual(expectedSpans);
});
it("picture contact matches phone numbers and mail addresses as Python does", () => {
  const expected: Record<string, number[][]> = {
    "": [], "010-1234-5678": [[0, 13]], "01012345678": [[0, 11]], "010 1234 5678": [[0, 13]], "010.1234.5678": [[0, 13]], "02-123-4567": [[0, 11]],
    "031-123-4567": [[0, 12]], "070-1234-5678": [[0, 13]], "+82-10-1234-5678": [[0, 16]], "+8210 1234 5678": [[0, 15]], "+82 2 123 4567": [[0, 14]],
    "1010-1234-5678": [], "010-1234-56789": [], "０１０-１２３４-５６７８": [], "٠١٠١٢٣٤٥٦٧٨": [], "name@example.org": [[0, 16]],
    "NAME@EXAMPLE.ORG": [[0, 16]], "İname@example.org": [[0, 17]], "na.me+x@sub.example.co.kr": [[0, 25]], "a@b": [], "a@b.c": [[0, 5]],
    "연락처 name@example.org 로": [[4, 20]], "ſam@example.org": [[0, 15]], "Kim@example.org": [[0, 15]],
    "전화 010-1234-5678, 메일 a@b.kr": [[3, 16], [21, 27]], "050-1234-5678": [], "016-123-4567": [[0, 12]], "0101-234-5678": [],
  };
  for (const [text, expectedSpans] of Object.entries(expected)) expect(spans(privacyPatterns.pictureContact, text), text).toEqual(expectedSpans);
  const redacted: Record<string, string> = { "": "", "문의 010-1234-5678": "문의 [비공개]", "Search for tvly-private-test-token": "Search for [비공개]",
    "메일은 name@example.org 입니다": "메일은 [비공개] 입니다", "비밀번호 1234": "비밀번호 [비공개]", "주민번호 900101-1234567": "주민번호 [비공개]" };
  for (const [text, out] of Object.entries(redacted)) expect(redactPictureText(text), text).toBe(out);
  expect(["Search for tvly-private-test-token", "키tvly-private-test-token", "tvly-short"].map(text => detectSensitive(text).hasSecretValue)).toEqual([true, false, false]);
});
