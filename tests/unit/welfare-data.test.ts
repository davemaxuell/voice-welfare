import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  cleanHttpUrl, FixtureWelfareDataProvider, OfficialCentralWelfareApiProvider, parseWelfareDetail,
} from "../../src/agents/welfare/data/index.ts";
import { cleanPublicUrl } from "../../src/agents/welfare/open_data/sync.ts";
import { fakeFetch } from "../helpers.ts";

const read = (path: string) => readFileSync(join(import.meta.dirname, "../fixtures", path), "utf8");
const detailXml = read("welfare-detail-WLF00003249.xml");
const bokjiro = "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00003249&wlfareInfoReldBztpCd=01";
const apiBase = "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001";
const openapiPage = "https://www.data.go.kr/data/15090532/openapi.do";

// 기대값은 pyref(77aad3e)의 _clean_http_url과 open_data.sync._clean_public_url을 같은 글에 돌린 결과다. 만드는 법은 tests/fixtures/welfare/generate.py.
const failed = z.object({ error: z.literal("ValueError") });
const cleaned = z.union([z.string(), z.null(), failed]);
const urlTable = z.array(z.object({ in: z.string(), http: cleaned, public: cleaned }))
  .parse(JSON.parse(read("welfare/clean-url.json")));

function outcome(clean: (raw: string) => string | undefined, raw: string): string | null | { error: string } {
  try {
    return clean(raw) ?? null;
  } catch (error) {
    if (error instanceof RangeError) return { error: "ValueError" };
    throw error;
  }
}

it("공식 API 응답의 주소는 Python과 같은 글만 http(s) 주소로 받는다", () => {
  expect(urlTable.length).toBeGreaterThan(50);
  const different = urlTable.flatMap(row => {
    const actual = outcome(cleanHttpUrl, row.in);
    return JSON.stringify(actual) === JSON.stringify(row.http) ? [] : [{ input: row.in, expected: row.http, actual }];
  });
  expect(different).toEqual([]);
});

it("CSV의 관련 사이트 주소는 Python과 같은 글만 주소로 받는다", () => {
  const different = urlTable.flatMap(row => {
    const actual = outcome(cleanPublicUrl, row.in);
    return JSON.stringify(actual) === JSON.stringify(row.public) ? [] : [{ input: row.in, expected: row.public, actual }];
  });
  expect(different).toEqual([]);
});

it("test_detail_mapping_extracts_related_sites_and_forms_for_central_and_local", () => {
  const central = parseWelfareDetail(detailXml, bokjiro, "2026-11-16");
  expect(central.relatedSites).toEqual([{ name: "보건복지상담센터", url: "http://www.129.go.kr" }]);
  expect(central.forms).toHaveLength(4);
  expect(central.forms?.every(form => form.url.startsWith("https://bokjiro.go.kr/"))).toBe(true);

  const localXml = `<?xml version="1.0" encoding="UTF-8"?>
    <wantedDtl>
      <servId>WLF00006793</servId><servNm>첫째아 출산지원금</servNm><ctpvNm>부산광역시</ctpvNm>
      <bizChrDeptNm>해운대구 가족복지과</bizChrDeptNm><servDgst>출산지원금 지원</servDgst>
      <sprtTrgtCn>해운대구 거주 출산 가정</sprtTrgtCn><aplyMtdCn>행정복지센터 방문</aplyMtdCn>
      <inqplHmpgReldList><wlfareInfoReldNm>해운대구청</wlfareInfoReldNm><wlfareInfoReldCn>www.haeundae.go.kr</wlfareInfoReldCn></inqplHmpgReldList>
      <basfrmList><wlfareInfoReldNm>출산지원금 신청서.hwpx</wlfareInfoReldNm><wlfareInfoReldCn>https://www.bokjiro.go.kr/ssis-tbu/CmmFileUtil/getDownload.do?atcflId=LOCAL1&amp;atcflSn=1</wlfareInfoReldCn></basfrmList>
      <resultCode>0</resultCode><resultMessage>SUCCESS</resultMessage>
    </wantedDtl>`;
  const detailUrl = "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00006793&wlfareInfoReldBztpCd=02";
  const local = parseWelfareDetail(localXml, detailUrl, "2026-11-16");
  expect(local.relatedSites).toEqual([{ name: "해운대구청", url: "https://www.haeundae.go.kr" }]);
  expect(local.forms).toEqual([{ name: "출산지원금 신청서.hwpx", url: "https://www.bokjiro.go.kr/ssis-tbu/CmmFileUtil/getDownload.do?atcflId=LOCAL1&atcflSn=1" }]);
});

it("같은 관련 사이트가 거듭 나오면 처음 이름으로 한 번만 싣고, 주소가 아닌 값은 뺀다", () => {
  const xml = `<wantedDtl><servId>X</servId><servNm>시험</servNm><resultCode>0</resultCode>
    <inqplHmpgReldList><servSeDetailNm>첫째</servSeDetailNm><servSeDetailLink>www.example.go.kr</servSeDetailLink></inqplHmpgReldList>
    <inqplHmpgReldList><servSeDetailNm>둘째</servSeDetailNm><servSeDetailLink>https://WWW.EXAMPLE.GO.KR/</servSeDetailLink></inqplHmpgReldList>
    <inqplHmpgReldList><servSeDetailNm>전화</servSeDetailNm><servSeDetailLink>129</servSeDetailLink></inqplHmpgReldList>
    <inqplHmpgReldList><servSeDetailNm>내부</servSeDetailNm><servSeDetailLink>http://localhost/x</servSeDetailLink></inqplHmpgReldList>
    </wantedDtl>`;
  expect(parseWelfareDetail(xml, "", "2026-11-16").relatedSites).toEqual([{ name: "첫째", url: "https://www.example.go.kr" }]);
});

const fixtures = FixtureWelfareDataProvider.fromFile();
function official(handler: (request: Request) => Response | Promise<Response>) {
  const fetcher = fakeFetch(handler);
  return { provider: new OfficialCentralWelfareApiProvider({ apiKey: "test-key", baseUrl: apiBase }, fixtures, fetcher), calls: fetcher.calls };
}

function listPage(total: string | undefined, rows: readonly (readonly [string, string])[], { local = false } = {}): string {
  const region = local ? "<ctpvNm>경기도</ctpvNm>" : "";
  const items = rows.map(([id, name]) => `<servList><servId>${id}</servId><servNm>${name}</servNm>${region}</servList>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><wantedList>${total === undefined ? "" : `<totalCount>${total}</totalCount>`}<resultCode>0</resultCode>${items}</wantedList>`;
}

const pageOf = (request: Request) => Number(new URL(request.url).searchParams.get("pageNo") ?? "1");
const listCalls = (calls: Request[], operation: string) => calls.filter(call => new URL(call.url).pathname.endsWith(operation)).map(pageOf);

it("test_catalog_paginates_local_and_central_lists_when_total_count_exceeds_page", async () => {
  const { provider, calls } = official(request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("LcgvWelfarelist")) {
      const row: [string, string] = pageOf(request) === 1 ? ["WLF00009001", "경기사업1"] : ["WLF00009002", "경기사업2"];
      return new Response(listPage("2", [row], { local: true }));
    }
    return new Response(listPage("1", [["WLF00003249", "장애인연금"]]));
  });
  const rows = await provider.catalog("경기도");
  expect(new Set(rows.map(row => row.servId))).toEqual(new Set(["WLF00003249", "WLF00009001", "WLF00009002"]));
  expect(listCalls(calls, "LcgvWelfarelist")).toEqual([1, 2]);
  expect(listCalls(calls, "NationalWelfarelistV001")).toEqual([1]);
});

// 쪽을 이어 받는 규칙(최대 5쪽, 새 항목이 없으면 멈춤, totalCount를 읽지 못하면 쪽이 가득 찼을 때만 계속)을 Python과 같게 따른다.
const paging: [string, (page: number) => string, number[]][] = [
  ["총 개수만큼 모으면 한 쪽에서 멈춘다", () => listPage("1", [["A1", "가나"]]), [1]],
  ["같은 항목만 되풀이하면 두 번째 쪽에서 멈춘다", () => listPage("5", [["A1", "가나"]]), [1, 2]],
  ["총 개수가 없고 쪽이 덜 찼으면 멈춘다", () => listPage(undefined, [["A1", "가나"], ["A2", "다라"]]), [1]],
  ["총 개수가 아무리 커도 다섯 쪽까지만 받는다", page => listPage("100", [[`P${page}`, `사업${page}`]]), [1, 2, 3, 4, 5]],
  ["쉼표가 든 총 개수는 읽지 못해 0으로 본다", page => listPage("1,000", [[`Q${page}`, `사업${page}`]]), [1]],
  ["전각 숫자도 총 개수로 읽는다", page => listPage("２", [[`Q${page}`, `사업${page}`]]), [1, 2]],
  ["밑줄이 든 숫자는 Python int처럼 읽는다", page => listPage("1_0", [[`Q${page}`, `사업${page}`]]), [1, 2, 3, 4, 5]],
  ["앞의 더하기 표시와 둘레 공백을 받는다", page => listPage(" +2 ", [[`Q${page}`, `사업${page}`]]), [1, 2]],
  ["음수 총 개수는 이미 채운 것으로 본다", page => listPage("-5", [[`Q${page}`, `사업${page}`]]), [1]],
  ["소수나 16진수는 읽지 못해 0으로 본다", page => listPage("2.0", [[`Q${page}`, `사업${page}`]]), [1]],
  ["servId가 비어 있는 항목은 중복으로 치지 않는다", () => listPage("3", [["", "이름없음"]]), [1, 2, 3]],
];

it.each(paging)("중앙 목록 쪽 이어 받기: %s", async (_title, page, expected) => {
  const { provider, calls } = official(request => new Response(page(pageOf(request))));
  await provider.catalog();
  expect(listCalls(calls, "NationalWelfarelistV001")).toEqual(expected);
});

it("쪽이 가득 차 있으면 총 개수가 없어도 다음 쪽을 받는다", async () => {
  const full = Array.from({ length: 500 }, (_, index): [string, string] => [`R1-${index}`, `사업${index}`]);
  const { provider, calls } = official(request => new Response(listPage(undefined, pageOf(request) === 1 ? full : [["R2", "끝"]])));
  expect(await provider.catalog()).toHaveLength(501);
  expect(listCalls(calls, "NationalWelfarelistV001")).toEqual([1, 2]);
});

it("상세는 처음에 자료 안내 주소를 출처로 갖고, 복지로 주소를 알게 되면 그 주소로 바꿔 캐시에 둔다", async () => {
  const { provider, calls } = official(() => new Response(detailXml));
  expect((await provider.getService("WLF00003249"))?.source.url).toBe(openapiPage);
  expect((await provider.getService("WLF00003249", bokjiro))?.source.url).toBe(bokjiro);
  expect((await provider.getService("WLF00003249"))?.source.url).toBe(bokjiro);
  expect(calls).toHaveLength(1);
});

it("이미 복지로 주소를 출처로 가진 상세는 다른 주소로 바꾸지 않는다", async () => {
  const { provider } = official(() => new Response(detailXml));
  expect((await provider.getService("WLF00003249", bokjiro))?.source.url).toBe(bokjiro);
  expect((await provider.getService("WLF00003249", "https://www.bokjiro.go.kr/other"))?.source.url).toBe(bokjiro);
});
