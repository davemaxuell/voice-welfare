import { expect, it } from "vitest";
import type { WelfareService } from "../../src/agents/welfare/data/index.ts";
import { chunkService, ragPatterns, retrieve, SECTION_HINTS } from "../../src/agents/welfare/rag.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.agents.welfare.rag를 같은 입력에 돌린 결과다.
function codePointSpans(pattern: RegExp, text: string): [number, number][] {
  const starts = new Map<number, number>([[0, 0]]);
  let units = 0;
  for (const character of text) {
    units += character.length;
    starts.set(units, starts.size);
  }
  return Array.from(text.matchAll(new RegExp(pattern.source, "gu")), match => [starts.get(match.index) ?? -1, starts.get(match.index + match[0].length) ?? -1]);
}

const documentsHint: [string, [number, number][]][] = [
  ["", []], ["서류", [[0, 2]]], ["준비 서류가 뭐야?", [[3, 5]]], ["구비서류", [[0, 2], [2, 4]]], ["준비물", [[0, 3]]],
  ["첨부파일", [[0, 2]]], ["첨부", [[0, 2]]], ["서식", []], ["신청서류", [[2, 4]]], ["서류서류", [[0, 2], [2, 4]]],
  ["ＡＢ서류", [[2, 4]]], ["서류 １２３", [[0, 2]]], ["12345 준비물 67890", [[6, 9]]], ["구비 구비", [[0, 2], [3, 5]]],
  ["서 류", []], ["문서", []], ["😀서류😀", [[1, 3]]],
  ["필요한 서류와 준비물, 구비 서류, 첨부 서류", [[4, 6], [8, 11], [13, 15], [16, 18], [20, 22], [23, 25]]],
  ["\n서류\n", [[1, 3]]],
];

it.each(documentsHint)("제출서류 질문 힌트는 Python과 같은 자리에서 맞는다: %j", (text, spans) => {
  expect(codePointSpans(ragPatterns.documents, text)).toEqual(spans);
  expect(SECTION_HINTS["제출서류"]).toBe(ragPatterns.documents);
});

const source = { title: "출처", url: "https://example.com/x", lastCheckedAt: "2026-11-18", version: "API 실시간" };
const service: WelfareService = {
  servId: "T1", servNm: "시험지원금", summary: "요약 문장입니다.", target: "만 65세 이상\n소득 하위 70%",
  criteria: "소득인정액 기준\n재산 기준", benefit: "월 30만원 지급\n매월 25일 지급",
  documents: "신분증 사본\n통장 사본\n소득 증빙 서류\n가", applyMethod: "주민센터 방문 신청",
  forms: [{ name: "신청서.hwp", url: "https://a" }], contacts: [{ name: "담당과", value: "051-1" }], laws: ["시험법"],
  source, dataOrigin: "official-api",
};

it("제출서류 조각은 지원내용 뒤 신청절차 앞에 오고 어느 항목에서 나왔는지 field로 밝힌다", () => {
  expect(chunkService(service)).toEqual([
    { id: "T1#1", section: "개요", field: "summary", text: "시험지원금: 요약 문장입니다." },
    { id: "T1#2", section: "지원대상", field: "target", text: "만 65세 이상\n소득 하위 70%" },
    { id: "T1#3", section: "선정기준", field: "criteria", text: "소득인정액 기준\n재산 기준" },
    { id: "T1#4", section: "지원내용", field: "benefit", text: "월 30만원 지급\n매월 25일 지급" },
    { id: "T1#5", section: "제출서류", field: "documents", text: "신분증 사본\n통장 사본\n소득 증빙 서류" },
    { id: "T1#6", section: "신청절차", field: "applyMethod", text: "주민센터 방문 신청" },
    { id: "T1#7", section: "서식", field: "forms", text: "관련 서식: 신청서" },
    { id: "T1#8", section: "문의처", field: "contacts", text: "문의처: 담당과 051-1" },
    { id: "T1#9", section: "근거법령", field: "laws", text: "근거 법령: 시험법" },
  ]);
});

it("신청 절차 조각의 field는 단계 목록이 있으면 applySteps, 없으면 applyMethod다", () => {
  const steps = chunkService({ ...service, applySteps: [{ step: "신청기관", detail: "주민센터" }] });
  expect(steps.find(chunk => chunk.section === "신청절차")).toMatchObject({ field: "applySteps", text: "신청기관: 주민센터" });
  const { documents: _documents, ...withoutDocuments } = service;
  expect(chunkService(withoutDocuments).map(chunk => [chunk.section, chunk.field])).toEqual([
    ["개요", "summary"], ["지원대상", "target"], ["선정기준", "criteria"], ["지원내용", "benefit"],
    ["신청절차", "applyMethod"], ["서식", "forms"], ["문의처", "contacts"], ["근거법령", "laws"],
  ]);
});

it.each([
  ["준비 서류가 뭐야?", [["T1#5", "제출서류", "documents", 0.666667], ["T1#1", "개요", "summary", 0.5], ["T1#7", "서식", "forms", 0.5], ["T1#2", "지원대상", "target", 0]]],
  ["구비서류 알려줘", [["T1#5", "제출서류", "documents", 0.666667], ["T1#7", "서식", "forms", 0.5], ["T1#1", "개요", "summary", 0], ["T1#2", "지원대상", "target", 0]]],
  ["첨부 파일", [["T1#5", "제출서류", "documents", 0.5], ["T1#7", "서식", "forms", 0.5], ["T1#1", "개요", "summary", 0], ["T1#2", "지원대상", "target", 0]]],
  ["신청 방법", [["T1#6", "신청절차", "applyMethod", 0.833333], ["T1#9", "근거법령", "laws", 0.5], ["T1#7", "서식", "forms", 0.333333], ["T1#1", "개요", "summary", 0]]],
] as const)("서류를 물으면 제출서류와 서식 조각이 함께 앞선다: %s", (question, expected) => {
  const found = retrieve(question, chunkService(service), 4).map(chunk => [chunk.id, chunk.section, chunk.field, Math.round(chunk.score * 1e6) / 1e6]);
  expect(found).toEqual(expected);
});
