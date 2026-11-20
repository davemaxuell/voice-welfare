import { expect, it } from "vitest";
import { extractNumbers, PublicEvidence, unsupportedNumbers } from "../../src/safety/verify.ts";

// 기대값은 77aad3e의 Python safety/verify.py로 계산했다.
it.each([
  ["30만 원", [30, 300000], [300000], ["30만"]],
  ["1억 2천만", [1, 2, 120000000], [120000000], ["1억2천만"]],
  ["3.5만", [3.5, 35000], [35000], ["3.5만"]],
  ["제29조 제2항", [2, 29], [2, 29], ["29조", "2"]],
  ["제 3 조에 따라 3조 원", [3, 3000000000000], [3, 3000000000000], ["3 조", "3조"]],
  ["법 제29조", [29], [29], ["29조"]],
  ["2025.1.1", [1, 2025], [1, 2025], ["2025.1.1"]],
  ["１２만", [12, 120000], [120000], ["１２만"]],
  ["", [], [], []],
  ["0.5만 그리고 1,500,000원", [0.5, 5000, 1500000], [5000, 1500000], ["0.5만", "1,500,000"]],
  ["총 1조 2천억", [1, 2, 1000000002000], [1000000002000], ["1조2천"]],
  ["제조 3조", [3, 3000000000000], [3000000000000], ["3조"]],
])("숫자를 값으로 모은다(정규화 여부 포함): %j", (text, values, canonical, raw) => {
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  expect(sorted(extractNumbers(text).values)).toEqual(values);
  expect(sorted(extractNumbers(text, { canonical: true }).values)).toEqual(canonical);
  expect(extractNumbers(text).raw).toEqual(raw);
});

it("법령의 제N조는 조 단위 금액으로 보지 않는다", () => {
  expect(unsupportedNumbers("제29조에 따라", ["29조 원"])).toEqual([]);
  expect(unsupportedNumbers("제29조에 따라", ["제29조"])).toEqual([]);
  expect(unsupportedNumbers("29조 원", ["제29조"])).toEqual([]);
});

it("인용이 걸친 원문 문장과 표 행 전체를 보존한다", () => {
  const source = "신청 기간은 2026년 11월입니다.\n신입생에 한해 12월에도 받습니다. 끝.  다음   줄\r\n\r\n표 행 하나\t표 행 둘";
  for (const [quote, passage] of [
    ["2026년 11월입니다. 신입생에 한해", "신청 기간은 2026년 11월입니다. 신입생에 한해 12월에도 받습니다."],
    ["12월에도", "신입생에 한해 12월에도 받습니다."], ["끝. 다음", "끝. 다음 줄"], ["표 행 하나 표 행 둘", "표 행 하나 표 행 둘"],
    ["없는 말", undefined], ["다음 줄 표 행", "다음 줄 표 행 하나 표 행 둘"],
  ] as const) expect(PublicEvidence.passage(quote, source), quote).toBe(passage);
});

it("요청한 사실별로 마지막 페이지부터 찾고 빠진 사실을 말한다", () => {
  const evidence = new PublicEvidence(["amount", "dates", "documents"]);
  evidence.collect([
    { fact: "amount", quote: "월 13만 원을 받습니다." }, { fact: "documents", quote: "연락처 010-1234-5678입니다." },
    { fact: "other", quote: "필요 서류: 신분증." }, "x", { fact: "documents", quote: "  필요   서류: 신분증. " }, { fact: "dates", quote: "짧음" },
  ], new Map([["a", "해당 가구에 한해 월 13만 원을 받습니다. 연락처 010-1234-5678입니다."], ["b", "필요 서류: 신분증. 월 13만 원을 받습니다."]]));
  expect(Object.fromEntries(evidence.passages)).toEqual({
    amount: [["b", "월 13만 원을 받습니다."]],
    documents: [["a", "연락처 010-1234-5678입니다."], ["b", "필요 서류: 신분증."]],
  });
  expect(evidence.missing).toEqual(["dates"]);
  expect(evidence.result(new Map([["a", "가"], ["b", "나"]]))).toEqual([
    "월 13만 원을 받습니다. 연락처 010-1234-5678입니다. 필요 서류: 신분증. 공식 자료에서 기간 항목은 아직 확인하지 못했어요.",
    [{ url: "b", title: "나" }, { url: "a", title: "가" }],
  ]);

  const observed = new PublicEvidence(["contact"]);
  for (let i = 0; i < 2; i++) observed.collect([{ fact: "contact", quote: "1" }], new Map([["u", "전화 1 번"]]), { observedRow: true });
  expect(observed.result(new Map())).toEqual(["1", [{ url: "u", title: "" }]]);

  const long = new PublicEvidence(["other"]);
  long.collect([{ fact: "other", quote: "x".repeat(501) }], new Map([["u", "x".repeat(600)]]));
  expect(long.result(new Map())).toEqual(["공식 자료에서 요청한 정보 항목은 아직 확인하지 못했어요.", []]);
});

it("test_claims_preserve_source_conditions_and_missing_facts", () => {
  const e = new PublicEvidence(["amount", "dates"]);
  e.collect([{ fact: "amount", quote: "월 13만 원을 받습니다." }, { fact: "dates", quote: "매년 8월 31일까지" }],
    new Map([["notice", "해당 가구에 한해 월 13만 원을 받습니다."]]));
  const [speech, sources] = e.result(new Map([["notice", "공식 공고"]]));
  expect(speech).toContain("해당 가구에 한해 월 13만 원");
  expect(speech).toContain("기간 항목은 아직");
  expect(e.missing).toEqual(["dates"]);
  expect(sources).toEqual([{ url: "notice", title: "공식 공고" }]);
  e.collect([{ fact: "dates", quote: "2026년 11월입니다. 신입생에 한해" }],
    new Map([["notice", "신청 기간은 2026년 11월입니다.\n신입생에 한해 12월에도 받습니다."]]));
  expect(e.missing).toEqual([]);
  expect(e.result(new Map([["notice", "공고"]]))[0]).toContain("신입생에 한해 12월에도 받습니다.");
});
