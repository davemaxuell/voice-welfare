import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { KNOWN_SITES, PUBLIC_AGENCIES, PUBLIC_ORIGINS, PUBLIC_SITES, knownSite, type KnownSite } from "../../src/core/sites.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.core.sites 표다. 만드는 법은 tests/fixtures/core/generate.py.
const site = z.object({ names: z.array(z.string()), url: z.string(), label: z.string(), about: z.string().nullable(), services: z.array(z.string()) });
const fixture = z.object({
  public: z.array(site), known: z.array(site), agencies: z.record(z.string(), z.string()), origins: z.array(z.string()),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/sites.json", import.meta.url), "utf8")));
const hiKorea = {
  names: ["하이코리아", "Hi Korea"], label: "하이코리아", url: "https://www.hikorea.go.kr/Main.pt",
  about: "외국인의 출입국 민원과 방문 예약을 안내하는 법무부 누리집", services: [],
};

function plain(entry: KnownSite) {
  return { names: [...entry.names], url: entry.url, label: entry.label, about: entry.about ?? null, services: [...entry.services] };
}

it("기존 공공기관 표에 하이코리아의 공식 첫 화면을 추가한다", () => {
  expect(fixture.public).toHaveLength(18);
  expect(PUBLIC_SITES.map(plain)).toEqual([...fixture.public, hiKorea]);
});

it("알려진 사이트 표는 공공기관 표 뒤에 일반 사이트가 이어진다", () => {
  expect(KNOWN_SITES.map(plain)).toEqual([...fixture.public, hiKorea, ...fixture.known.slice(fixture.public.length)]);
  expect(KNOWN_SITES.slice(0, PUBLIC_SITES.length)).toEqual([...PUBLIC_SITES]);
});

it("공식 첫 화면 주소에 경로가 있어도 출처 표는 기관의 원점을 사용한다", () => {
  expect(Object.fromEntries([...PUBLIC_AGENCIES].map(([label, entry]) => [label, entry.url]))).toEqual({...fixture.agencies, 하이코리아: hiKorea.url});
  expect(PUBLIC_ORIGINS).toEqual(new Set([...fixture.origins, "https://www.hikorea.go.kr"]));
  expect(PUBLIC_ORIGINS.has("https://www.gov.kr")).toBe(true);
  expect(PUBLIC_AGENCIES.get("constructor")).toBeUndefined();
});

it("소개와 대표 업무는 없으면 비워 둔다", () => {
  expect(knownSite(["가"], "https://a.example", "가")).toEqual({ names: ["가"], url: "https://a.example", label: "가", services: [] });
  expect(knownSite(["가"], "https://a.example", "가", "소개", ["업무"]).about).toBe("소개");
});
