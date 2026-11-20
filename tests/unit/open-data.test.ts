import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { parseProfileAnswer } from "../../src/agents/welfare/discovery.ts";
import { OpenData } from "../../src/agents/welfare/open_data/index.ts";
import { DATASETS, LINKS, MOBILITY_CENTERS, PENSION_OFFICES } from "../../src/agents/welfare/open_data/datasets.ts";
import { main } from "../../src/agents/welfare/open_data/sync.ts";
import { isPlaceRequest } from "../../src/core/places.ts";
import { parseRegionMention } from "../../src/core/region.ts";

const folders: string[] = [];
function temp(): string {
  const folder = mkdtempSync(join(tmpdir(), "cheongeum-open-data-"));
  folders.push(folder);
  return folder;
}
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const data = OpenData.load();

/** Python csv.writer(QUOTE_MINIMAL, 줄 끝 \r\n). */
function csvText(rows: readonly (readonly (string | number)[])[]): string {
  const cell = (value: string | number) => {
    const text = String(value);
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return rows.map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

// Python의 cp949 인코딩. TextDecoder("euc-kr")가 풀어 주는 두 바이트 글자를 거꾸로 찾아 만든다.
const cp949Bytes = new Map<string, readonly number[]>();
const cp949Decoder = new TextDecoder("euc-kr");
for (let lead = 0x81; lead <= 0xfe; lead++) {
  for (let trail = 0x41; trail <= 0xfe; trail++) {
    const decoded = cp949Decoder.decode(Uint8Array.of(lead, trail));
    if (Array.from(decoded).length === 1 && decoded !== "�") cp949Bytes.set(decoded, [lead, trail]);
  }
}
function encodeCp949(text: string): Buffer {
  return Buffer.from(Array.from(text).flatMap(character => {
    const point = character.codePointAt(0) ?? 0;
    const bytes = point < 0x80 ? [point] : cp949Bytes.get(character);
    if (bytes === undefined) throw new Error(`cp949로 쓸 수 없는 글자: ${character}`);
    return [...bytes];
  }));
}

it("test_bundled_programs_have_own_source_and_application_rules", () => {
  const entries = data.programs.entries("2026-11-18");
  const program = entries.find(entry => entry.servNm === "꿈장학(초중고등학생)");
  expect(program?.targets).toEqual(["저소득"]);
  expect(program?.source.lastCheckedAt).toBe("2025-11-05");
  expect(program?.enfcEndYmd).toBeUndefined();
  expect(program?.documents.length).toBeGreaterThan(0);
  expect(program?.source.url.endsWith("15116392/fileData.do")).toBe(true);
  const ids = new Set(entries.map(entry => `${entry.organization}\n${entry.servNm}`));
  const ended = data.programs.records.filter(record => record.end < "2026-11-18").map(record => `${record.organization}\n${record.name}`);
  expect(ended.length).toBeGreaterThan(0);
  expect(ended.filter(id => ids.has(id))).toEqual([]);

  // 사업이 시작되기 전에도 신청은 열려 있을 수 있다.
  const upcoming = data.programs.records.reduce((latest, record) => record.start > latest.start ? record : latest);
  const earlier = `${Number(upcoming.start.slice(0, 4)) - 1}-12-31`;
  expect(data.programs.entries(earlier).some(entry => entry.servNm === upcoming.name)).toBe(true);
});

it("test_place_from_real_administrative_and_legal_dong", () => {
  const finder = data.places;
  const initial = finder.answer("우리 동네 주민센터 어디야?");
  expect(initial.ask).toBeDefined();
  const choices = initial.ask === undefined ? undefined : finder.followUp(initial.ask, "서울 강남구 개포동");
  expect(choices?.ask).toBeDefined();
  expect(choices?.speech).toContain("개포1동");
  expect(choices?.speech).toContain("개포2동");
  const reply = choices?.ask === undefined ? undefined : finder.followUp(choices.ask, "1번");
  expect(reply?.ask).toBeUndefined();
  expect(reply?.speech).toContain("개포1동 주민센터");
  expect(reply?.speech).toContain("선릉로 35");
  expect(reply?.speech).toContain("전화번호가 없어요");
  expect(reply?.speech).toContain("2025년 12월 31일");
  expect(choices?.ask === undefined ? "ask" : finder.followUp(choices.ask, "대신 현재 화면 설명해줘")).toBeUndefined();
  expect(finder.answer("강남구 개포일동 주민센터 위치").sources).toEqual(reply?.sources);
});

it("test_pension_office_in_address_district", () => {
  const reply = data.places.answer("서대문구 국민연금 지사 전화번호");
  expect(reply.speech).toContain("충정로 36");
  expect(reply.speech).toContain("공이, 이일칠육");
  expect(reply.sources[0]?.note).toBe("02-2176-9949");
  const english = data.places.answer("서대문구 국민연금 지사 전화번호", undefined, { lang: "en" });
  expect(english.speech).toContain(reply.sources[0]?.note);
  const absent = data.places.answer("가상구 국민연금 지사 주소");
  expect(absent.sources).toEqual([]);
  expect(absent.ask).toBeUndefined();
});

it("test_missing_kind_and_region_ambiguity", () => {
  expect(OpenData.load(temp()).places.answer("국민연금 지사 어디야").speech).toContain("내려받지");
  expect(parseRegionMention("광주시").districts).toEqual(["광주시"]);
  expect(parseRegionMention("광주시").province).toBe("");
  const ambiguous = data.places.answer("중앙동 주민센터 어디야");
  expect(ambiguous.ask).toBeDefined();
  expect(ambiguous.sources).toEqual([]);
});

it("test_mobility_csv_uses_booking_number_and_row_reference_date", async () => {
  const spec = MOBILITY_CENTERS;
  const folder = temp();
  const path = join(folder, "예약.csv");
  const rows = Array.from({ length: spec.floor }, (_, index) => {
    const row: Record<string, string> = {
      "교통약자이동지원센터명": `테스트${index}센터`, "소재지지번주소": `경기도 가상${index}시 예시동 1`,
      "예약접수전화번호": "1566-9999", "관리기관전화번호": "031-000-0000", "데이터기준일자": "2025-01-01",
    };
    return spec.headers.map(header => row[header] ?? "");
  });
  writeFileSync(path, "﻿" + csvText([spec.headers, ...rows]), "utf8");
  expect(await main(["--dir", folder, "--csv", `15028207=${path}`, "--reference-date", "15028207=2026-11-02"], { stdout: () => undefined })).toBe(0);
  const finder = OpenData.load(folder).places;
  const ask = finder.answer("장애인 콜택시 어디에 예약해?").ask;
  const reply = ask === undefined ? undefined : finder.followUp(ask, "가상1시");
  expect(reply?.speech).toContain("일오육육, 구구구구");
  expect(reply?.speech).toContain("2025년 1월 1일");
  expect(reply?.sources[0]?.note).toBe("1566-9999");
});

it.each([
  ["장애인 콜택시 어디에 예약해?", true], ["행정복지센터 전화번호 좀 알려줘", true],
  ["국민연금 지사 위치 알려줘", true], ["개포면사무소 주소 알려줘", true],
  ["기초연금 신청은 주민센터 어디서 해?", false], ["주소는 개포1동 주민센터야", false],
  ["이 페이지에서 주민센터 전화번호 읽어줘", false], ["주민센터 전화번호 링크 눌러", false],
] as const)("test_place_phrases", (text, valid) => {
  expect(isPlaceRequest(text)).toBe(valid);
});

it("test_csv_validation_preserves_good_snapshot_and_check_detects_corruption", async () => {
  const spec = PENSION_OFFICES;
  const folder = temp();
  const file = join(folder, "pension.csv");
  const rows = Array.from({ length: spec.floor }, (_, index) => [index + 1, `테스트${index}지사`, "12345", "서울특별시 강남구 가상로 1", "02-123-4567", ""]);
  writeFileSync(file, encodeCp949(csvText([spec.headers, ...rows])));
  const args = ["--dir", folder, "--csv", `${spec.id}=${file}`, "--reference-date", `${spec.id}=2026-08-01`];
  const quiet = { stdout: () => undefined, stderr: () => undefined };
  expect(await main(args, quiet)).toBe(0);
  const snapshot = join(folder, "15010814.json");
  const original = readFileSync(snapshot);
  writeFileSync(file, "성명,주소\n이름,주소\n", "utf8");
  expect(await main(args, quiet)).toBe(1);
  expect(readFileSync(snapshot).equals(original)).toBe(true);
  const tampered = z.object({ records: z.array(z.object({ phone: z.string() }).loose()) }).loose().parse(JSON.parse(original.toString("utf8")));
  const [first] = tampered.records;
  if (first === undefined) throw new Error("스냅샷에 행이 없습니다");
  first.phone = "02-000-0000";
  writeFileSync(snapshot, JSON.stringify(tampered), "utf8");
  expect(OpenData.load(folder).places.answer("강남구 국민연금 지사 전화번호").speech).toContain("내려받지");
});

it("test_bundled_central_welfare_links_cover_bokjiro_and_related_sites", () => {
  const links = data.links;
  expect(links.records.length).toBeGreaterThanOrEqual(LINKS.floor);
  expect(links.referenceDate).toBeDefined();
  expect(links.citation()?.url.endsWith("15083323/fileData.do")).toBe(true);

  const childcare = links.byName("아이돌봄서비스");
  expect(childcare?.serv_id).toBe("WLF00000024");
  expect(childcare?.detail_url.startsWith("https://www.bokjiro.go.kr/")).toBe(true);
  expect(childcare?.detail_url).toContain("wlfareInfoId=WLF00000024");
  expect(childcare?.sites.some(site => site.url === "https://idolbom.go.kr/")).toBe(true);

  // 공식 CSV의 https:// 오타가 정규화되어 유효한 주소로 저장된다.
  const assistant = links.byName("근로지원인 지원");
  expect(assistant?.sites.map(site => site.url)).toEqual([
    "https://www.esingo.or.kr",
    "https://www.kead.or.kr/sprlbsprt/cntntsPage.do?menuId=MENU0632",
  ]);
  // 사이트 칸에 전화번호만 있는 행은 주소로 오인하지 않는다.
  const special = links.byName("건강보험 산정특례");
  expect(special?.sites).toEqual([]);

  expect(links.relatedSite("문화누리카드")?.url).toBe("https://www.mnuri.kr");
  expect(links.relatedSite("마이홈")?.url).toBe("https://www.myhome.go.kr");
  expect(links.relatedSite("에너지바우처")?.url).toBe("https://www.energyv.or.kr");
  // 서로 다른 도메인이 섞인 라벨은 추측하지 않는다.
  expect(links.relatedSite("근로복지넷")).toBeUndefined();
  expect(links.matchInText("아이돌봄서비스 서류 알려줘")?.serv_id).toBe("WLF00000024");
  expect(links.matchInText("산재 보상금 알려줘")).toBeUndefined();
});

it("test_15083323_csv_import_validates_bokjiro_urls_and_parses_sites", async () => {
  const spec = LINKS;
  const folder = temp();
  const file = join(folder, "central_links.csv");
  const rows = Array.from({ length: spec.floor }, (_, index) => {
    const id = `WLF${String(index).padStart(8, "0")}`;
    const url = `https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=${id}&wlfareInfoReldBztpCd=01`;
    const sites = index === 0 ? "테스트포털www.example.go.kr 안내https;//sub.example.or.kr/guide" : "";
    return [id, `테스트복지서비스${index}`, url, "요약", sites, "129", "보건복지부", "복지과", "2026", "2026-08-19"];
  });
  // wlfareInfoId가 다른 잘못된 행은 2% 이하 오류로 걸러진다.
  rows.push(["WLF99999999", "잘못된서비스", "https://www.bokjiro.go.kr/?wlfareInfoId=WLF00000000", "요약", "", "129", "보건복지부", "복지과", "2026", "2026-08-19"]);
  writeFileSync(file, "﻿" + csvText([spec.headers, ...rows]), "utf8");
  expect(await main(["--dir", folder, "--csv", `15083323=${file}`, "--reference-date", "15083323=2026-08-19"], { stdout: () => undefined })).toBe(0);
  const loaded = OpenData.load(folder).links;
  expect(loaded.records).toHaveLength(spec.floor);
  expect(loaded.byId("WLF99999999")).toBeUndefined();
  const first = loaded.byName("테스트복지서비스0");
  expect(first?.sites.map(site => site.url)).toEqual(["https://www.example.go.kr", "https://sub.example.or.kr/guide"]);
  expect(loaded.relatedSite("테스트포털")?.url).toBe("https://www.example.go.kr");
});

it.each(["부산이요", "부산에서요", "부산 살아요", "부산이고…", "부산광역시에요.", "지역은 부산, 나이는 25살"])("test_spoken_discovery_province_answers", answer => {
  expect(parseProfileAnswer(answer, "ctpv").ctpv).toBe("부산광역시");
});

it("주소로 받은 자료 목록은 Python과 같은 순서다", () => {
  expect([...DATASETS.keys()]).toEqual(["15116392", "15083323", "15059715", "15010814", "15028207"]);
  expect(OpenData.empty().statuses.map(status => [status.dataset_id, status.error])).toEqual(
    [...DATASETS.keys()].map(id => [id, "missing"]),
  );
});
