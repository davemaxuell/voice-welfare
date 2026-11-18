import { expect, it } from "vitest";
import { chunkText, josa, readback, speakDate, speakLabel } from "../../src/speech/phrasing.ts";

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
