import { expect, it } from "vitest";
import { downloadKey } from "../../scripts/collect-previews.ts";
import { pictureChoice, reportsNumber } from "../../scripts/eval-pictures.ts";

// Results from the pinned Python evaluator and preview collector, including non-ASCII decimal digits.
it.each([
  ["누를 수 있는 곳\n1. 닫기", 1], ["１２. 닫기", 12], ["1. 닫기 추가", undefined], ["", undefined],
] as const)("reads the exact numbered picture choice in %j", (text, expected) => {
  expect(pictureChoice(text, "닫기")).toBe(expected);
});
it.each([
  ["대상 12명", true], ["１２", false], ["１12", false], ["12３", false], ["12", true], ["", false],
] as const)("checks decimal boundaries in picture speech %j", (text, expected) => {
  expect(reportsNumber(text, "12")).toBe(expected);
});
it.each([
  ["fn_fileDataDown( '123', '한글')", "한글"], ['fn_fileDataDown(　"123", "１２")', "１２"],
  ["fn_fileDataDown('321', 'abc')", undefined], ["", undefined],
] as const)("reads public download keys from %j", (html, expected) => {
  expect(downloadKey(html, "123")).toBe(expected);
});
