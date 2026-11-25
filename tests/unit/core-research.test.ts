import { expect, it } from "vitest";
import {
  DATA_DATE, ResearchCheckpoint, StoredResearch, researchSummary, sourceData, sourceKey, type ResearchPlan, type SourceData,
} from "../../src/core/research.ts";
import { SourceCitationSchema } from "../../src/core/turn.ts";

const bokjiro = "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00003249";
const official: SourceData = { kind: "live", origin: "official-api", date: "2026년" };
const source = (extra: object = {}) => ({ title: "복지로 공식 자료", url: bokjiro, lastCheckedAt: "2026-11-24", ...extra });
const finding = (text: string, data?: SourceData, url = bokjiro) => ({
  text, sources: [source({ url, ...(data === undefined ? {} : { data }) })], proof: [{ quote: text, url }],
});
function plan(...steps: unknown[]): ResearchPlan {
  return ResearchCheckpoint.parse({
    version: 1, activeMs: 0, continuations: 0,
    plan: { route: "welfare", goal: "기초연금 서류와 마감일", subject: "기초연금", exclusions: [],
      steps: steps.map((outcome, i) => ({ requirement: `항목 ${i + 1}`, attempts: 1, outcome })) },
  }).plan;
}
const verified = (found: ReturnType<typeof finding>) => ({ status: "verified", finding: found });

it("기준일은 'YYYY-MM-DD'와 기준 연도 'YYYY년'만 받는다", () => {
  const accepted = ["2026년", "2026-03-05", "1999-12-31"];
  const refused = ["2026-3-5", "２０２６년", "２０２６-０３-０５", "", "2026", "2026년 ", "2026-03-05\n", "2026년\n", "20260305", "2026-03-05T00:00", "기준일 미기재"];
  expect(accepted.filter(value => DATA_DATE.test(value))).toEqual(accepted);
  expect(refused.filter(value => DATA_DATE.test(value))).toEqual([]);
});

it("검토를 마친 조사의 이어 하기 기록은 인용마다 붙은 자료 정보를 그대로 둔다", () => {
  const saved = plan(verified(finding("서류는 신청서입니다.", official)), verified(finding("마감은 금요일입니다.", { kind: "live", origin: "official-api", date: "2026-03-05" }, "https://www.gov.kr/notices/1")));
  const restored = ResearchCheckpoint.parse(JSON.parse(JSON.stringify({ version: 1, activeMs: 0, continuations: 0, plan: saved }))).plan;
  const sources = restored.steps.flatMap(step => step.outcome?.status === "verified" ? step.outcome.finding.sources : []);
  expect(sources.map(item => item.data)).toEqual([official, { kind: "live", origin: "official-api", date: "2026-03-05" }]);
});

it("자료 정보가 없는 옛 이어 하기 기록도 그대로 읽힌다", () => {
  const old = { version: 1, activeMs: 10, continuations: 0, plan: { route: "browser", goal: "g", subject: "s", exclusions: [],
    steps: [{ requirement: "가", attempts: 1, outcome: { status: "verified", finding: finding("가 답") } }, { requirement: "나", attempts: 0 }] } };
  const parsed = ResearchCheckpoint.parse(old);
  const first = parsed.plan.steps[0]?.outcome;
  expect(first?.status === "verified" ? first.finding.sources.map(item => item.data) : "waiting").toEqual([undefined]);
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(old);
});

it("잘못 적힌 기준일은 그 칸만 비우고 조사 기록은 버리지 않는다", () => {
  const saved = plan(verified(finding("서류는 신청서입니다.", { kind: "live", origin: "official-api", date: "2026-3-5" })),
    verified(finding("마감은 금요일입니다.", { kind: "unknown", origin: "official-api", date: "2026년" } as never, "https://www.gov.kr/notices/1")),
    verified(finding("연락처는 129입니다.", { kind: "live", origin: "", date: "2026년" }, "https://www.bokjiro.go.kr/contact")));
  const [state, result] = researchSummary(saved);
  expect(state).toBe("completed");
  expect(result.text).toContain("연락처는 129입니다.");
  expect(JSON.parse(JSON.stringify((result.sources ?? []).map(item => item.data ?? null)))).toEqual([{ kind: "live", origin: "official-api" }, null, null]);
});

it("같은 주소를 기준일이 다르게 인용한 두 항목은 둘 다 남고 기준일 없는 중복만 빠진다", () => {
  const [state, result] = researchSummary(plan(
    verified(finding("서류는 신청서입니다.", { kind: "live", origin: "official-api", date: "2026년" })),
    verified(finding("지급일은 매달 25일입니다.", { kind: "live", origin: "official-api", date: "2026-03-05" })),
    verified(finding("신청은 방문입니다.")),
    verified(finding("공고문은 별도 쪽에 있습니다.", undefined, "https://www.gov.kr/notices/1")),
  ));
  expect(state).toBe("completed");
  expect((result.sources ?? []).map(item => [item.url, item.data?.date ?? null])).toEqual([
    [bokjiro, "2026년"], [bokjiro, "2026-03-05"], ["https://www.gov.kr/notices/1", null],
  ]);
});

it("기준일이 같은 인용이 되풀이되면 하나로 합치고 기준일이 아예 없는 인용은 그대로 둔다", () => {
  const [, result] = researchSummary(plan(
    verified(finding("가", official)), verified(finding("나", official)), verified(finding("다", undefined, "https://www.gov.kr/notices/1")),
    verified(finding("라", undefined, "https://www.gov.kr/notices/1")),
  ));
  expect((result.sources ?? []).map(item => [item.url, item.data?.date ?? null])).toEqual([[bokjiro, "2026년"], ["https://www.gov.kr/notices/1", null]]);
  expect(sourceKey({ url: bokjiro, data: official })).not.toBe(sourceKey({ url: bokjiro, data: { ...official, date: "2026-03-05" } }));
  expect(sourceKey({ url: bokjiro })).toBe(sourceKey({ url: bokjiro, data: undefined }));
});

it("저장된 조사 결과는 깨진 칸과 항목을 버릴 뿐 한 건을 통째로 거부하지 않는다", () => {
  const read = StoredResearch.parse({
    text: 5, sources: [source({ data: official }), 7, { title: 3 }, source({ url: "https://www.gov.kr/", data: { kind: "live", origin: "x", date: "bad" } })],
    missing: ["마감일", null, 4], proof: "none", reason: "mystery", data: { kind: "stored", origin: "" },
  });
  expect(read.text).toBeUndefined();
  expect(read.sources.map(item => item.url)).toEqual([bokjiro, "https://www.gov.kr/"]);
  expect(read.sources[1]?.data?.date).toBeUndefined();
  expect([read.missing, read.proof, read.reason, read.data]).toEqual([["마감일"], [], undefined, undefined]);
  expect(StoredResearch.parse({})).toEqual({ sources: [], missing: [], proof: [] });
  expect(StoredResearch.safeParse(null).success).toBe(false);
});

it("인용에 자료 정보가 없을 때만 옛 기록의 조사 전체 줄을 쓴다", () => {
  const legacy = StoredResearch.parse({ text: "답", sources: [source(), source({ url: "https://www.gov.kr/", data: official })],
    data: { kind: "stored", origin: "fixture", date: "2026-11-18" } });
  expect(legacy.sources.map(item => sourceData(legacy, item))).toEqual([
    { kind: "stored", origin: "fixture", date: "2026-11-18" }, official,
  ]);
  const modern = StoredResearch.parse({ sources: [source()] });
  expect(sourceData(modern, modern.sources[0]!)).toBeUndefined();
});

it("응답의 인용은 자료 정보를 싣되 없거나 잘못되면 그 키를 뺀다", () => {
  const cited = { title: "복지로", url: bokjiro, lastCheckedAt: "2026-11-24" };
  expect(SourceCitationSchema.parse({ ...cited, data: official })).toEqual({ ...cited, data: official });
  for (const data of [undefined, null, {}, "live", { kind: "live", origin: "" }]) {
    expect(Object.keys(SourceCitationSchema.parse({ ...cited, data })), JSON.stringify(data)).not.toContain("data");
  }
  expect(SourceCitationSchema.parse({ ...cited, data: { kind: "live", origin: "official-api", date: "2026-3-5" } }).data)
    .toEqual({ kind: "live", origin: "official-api" });
});
