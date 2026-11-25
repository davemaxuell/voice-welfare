import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { citeWithData } from "../../src/agents/welfare/answer_card.ts";
import { WelfareInformationAgent } from "../../src/agents/welfare/agent.ts";
import { FixtureWelfareDataProvider, parseWelfareDetail, type WelfareDataProvider } from "../../src/agents/welfare/data/index.ts";
import type { GroundedAnswerCard, SourceCitation } from "../../src/core/turn.ts";

const bokjiro = "https://www.bokjiro.go.kr/welfare/WLF1";
const source = (extra: Partial<SourceCitation> = {}): SourceCitation => ({ title: "복지로 공식 자료", url: bokjiro, lastCheckedAt: "2026-11-24", ...extra });
const card = (extra: Partial<GroundedAnswerCard> = {}): GroundedAnswerCard => ({
  answer: "신청서가 필요합니다.", serviceId: "WLF1", serviceName: "기초연금", fields: ["documents"], grounded: true, source: source(),
  dataKind: "live", dataOrigin: "official-api", dataDate: "2026년", nextAction: "출처에서 확인해 주세요.", ...extra,
});

it("답 카드의 자료 종류·기관·기준일은 카드가 가리키는 인용에만 붙고 다른 인용과 원래 목록은 그대로다", () => {
  const other = source({ title: "정부24", url: "https://www.gov.kr/" });
  const original = [other, source()];
  const cited = citeWithData(card(), original);
  expect(cited).toEqual([other, source({ data: { kind: "live", origin: "official-api", date: "2026년" } })]);
  expect(original).toEqual([other, source()]);
});

it("카드 자신의 출처가 목록에 없으면 자료 정보를 붙여 더한다", () => {
  const other = source({ title: "정부24", url: "https://www.gov.kr/" });
  expect(citeWithData(card({ dataKind: "stored", dataOrigin: "fixture", dataDate: "2026-11-18" }), [other])).toEqual([
    other, source({ data: { kind: "stored", origin: "fixture", date: "2026-11-18" } }),
  ]);
  expect(citeWithData(card(), [])).toEqual([source({ data: { kind: "live", origin: "official-api", date: "2026년" } })]);
});

it("기준일이 없는 카드는 date 키 없이 종류와 기관만 붙인다", () => {
  const { dataDate: _omitted, ...undated } = card({ dataKind: "private-program", dataOrigin: "official-snapshot" });
  const [cited] = citeWithData(undated, [source()]);
  expect(cited?.data).toStrictEqual({ kind: "private-program", origin: "official-snapshot" });
});

it("공식 자료로 답한 카드의 출처는 그 답의 인용 목록에 이미 들어 있어 제자리에서 자료 정보가 붙는다", async () => {
  const xml = readFileSync(join(import.meta.dirname, "../fixtures/welfare-detail-WLF00003249.xml"), "utf8");
  const service = { ...parseWelfareDetail(xml, "https://www.bokjiro.go.kr/x", "2026-11-16"), documents: "신청서를 제출하세요.", forms: [] };
  const fixtures = FixtureWelfareDataProvider.fromFile();
  const provider: WelfareDataProvider = {
    mode: "official-api", async listServices() { return [service]; }, async getService() { return service; },
    async findService() { return service; }, async catalog() { return []; }, getFieldGlossary(id) { return fixtures.getFieldGlossary(id); },
  };
  const answer = await new WelfareInformationAgent(provider).publicFacts("지원", "서류", ["documents"], new AbortController().signal);
  expect(answer?.card).toBeDefined();
  const urls = answer?.sources.map(item => item.url);
  expect(urls).toContain(answer?.card?.source.url);
  const cited = citeWithData(answer!.card!, answer!.sources);
  expect(cited).toHaveLength(answer!.sources.length);
  expect(cited.find(item => item.url === answer!.card!.source.url)?.data).toMatchObject({ kind: "live", origin: "official-api", date: "2026년" });
});
