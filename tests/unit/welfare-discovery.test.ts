import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FixtureWelfareDataProvider, parseServiceCatalog, parseWelfareDetail } from "../../src/agents/welfare/data/index.ts";
import { matchServices, nextProfileSlot, parseProfileAnswer } from "../../src/agents/welfare/discovery.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8");
const provider = FixtureWelfareDataProvider.fromFile();

it("test_central_catalog", () => {
  const items = parseServiceCatalog(fixture("welfare-list-all.xml"), "central");
  expect(items).toHaveLength(461);
  const pension = items.find(s => s.servNm === "장애인연금");
  expect(pension?.targets).toContain("장애인");
  expect(pension?.lifeStages.length).toBeGreaterThan(0);
});

it("test_local_catalog", () => {
  const items = parseServiceCatalog(fixture("welfare-local-busan.xml"), "local");
  expect(items).toHaveLength(284);
  expect(items.every(s => s.region?.ctpv === "부산광역시")).toBe(true);
});

it("test_profile_answer_many_at_once", () => {
  expect(parseProfileAnswer("마흔다섯 살이고 심한 장애가 있고 부산 살아요")).toMatchObject({age:45,disability:"severe",ctpv:"부산광역시"});
});

it("test_profile_short_answers", () => {
  expect(parseProfileAnswer("아니요","disability")).toEqual({disability:"no"});
  expect(parseProfileAnswer("잘 모르겠어요","income")).toEqual({income:"unknown"});
  expect(parseProfileAnswer("건너뛰기","ctpv")).toEqual({ctpv:null});
  expect(parseProfileAnswer("음 맞아.","income")).toEqual({income:"low"});
  expect(parseProfileAnswer("어, 있어요","disability")).toEqual({disability:"yes"});
  expect(nextProfileSlot({age:70,disability:"no",income:"unknown",ctpv:null})).toBeUndefined();
});

it("test_profile_unrelated", () => {
  expect(parseProfileAnswer("네이버 열어줘","age")).toEqual({});
});

it("test_rank_severe_basic", async () => {
  const ranks = matchServices(await provider.catalog(), {age:45,disability:"severe",income:"basic",ctpv:null});
  expect(ranks.slice(0,5).map(x => x.service.servNm)).toContain("장애인연금");
  expect(ranks.some(({service:s}) => s.targets.length > 0 && s.targets.every(t => t === "다문화·탈북민"))).toBe(false);
});

it("test_rank_senior_low_income", async () => {
  const ranks = matchServices(await provider.catalog(), {age:70,disability:"no",income:"low",ctpv:null});
  expect(ranks.slice(0,3).map(x => x.service.servNm)).toContain("기초연금");
  expect(ranks.every(({service:s}) => s.lifeStages.length === 0 || s.lifeStages.includes("노년"))).toBe(true);
});

it("test_rank_with_region", async () => {
  const ranks = matchServices(await provider.catalog("부산광역시"), {age:45,disability:"severe",income:"basic",ctpv:"부산광역시"});
  expect(ranks.slice(0,10).some(x => x.service.provider === "local")).toBe(true);
});

it("test_local_detail", () => {
  const details = parseWelfareDetail(fixture("welfare-local-detail.xml"), "");
  expect(details).toMatchObject({servNm:"가임력 보존지원 사업",enfcBgngYmd:"20240101",enfcEndYmd:"99991231"});
  expect(details.target).toContain("기준중위소득");
  expect(details.criteria).toContain("거주기준");
  expect(details.contacts?.[0]?.value).toBe("051-888-3362");
});
