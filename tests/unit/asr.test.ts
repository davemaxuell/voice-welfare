import { expect, it } from "vitest";
import { cer, digitRuns, hasSpelledNumbers } from "../../src/evaluation/asr.ts";

it("test_cer_and_digit_runs", () => {
  expect(cer("다음으로 가줘", "다음으로 가 줘.")).toBe(0);
  expect(cer("네이버 열어줘", "네이버 열어")).toBeCloseTo(1 / 6);
  expect(cer("", "")).toBe(0);
  expect(cer("", "아")).toBe(1);
  expect(digitRuns("연락처는 010-1234-5678이에요")).toEqual(["01012345678"]);
  expect(digitRuns("공일공 일이삼사 오육칠팔")).toEqual(["01012345678"]);
});

it("scores Unicode characters once and preserves spelled-number offsets after astral characters", () => {
  expect(cer("가𠮷", "가")).toBe(0.5);
  expect(digitRuns("𠮷 공일공 일이삼사 오육칠팔, １２-３")).toEqual(["01012345678", "１２３"]);
  expect(hasSpelledNumbers("공일공 일이삼사")).toBe(true);
  expect(hasSpelledNumbers("010 1234")).toBe(false);
});
