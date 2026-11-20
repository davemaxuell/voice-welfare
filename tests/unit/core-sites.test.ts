import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { KNOWN_SITES, PUBLIC_AGENCIES, PUBLIC_ORIGINS, PUBLIC_SITES, knownSite, type KnownSite } from "../../src/core/sites.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.core.sites 표다. 만드는 법은 tests/fixtures/core/generate.py.
const site = z.object({ names: z.array(z.string()), url: z.string(), label: z.string(), about: z.string().nullable(), services: z.array(z.string()) });
const fixture = z.object({
  public: z.array(site), known: z.array(site), agencies: z.record(z.string(), z.string()), origins: z.array(z.string()),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/sites.json", import.meta.url), "utf8")));

function plain(entry: KnownSite) {
  return { names: [...entry.names], url: entry.url, label: entry.label, about: entry.about ?? null, services: [...entry.services] };
}

it("공공기관 사이트 표가 이름·주소·소개·대표 업무까지 Python과 같다", () => {
  expect(fixture.public).toHaveLength(18);
  expect(PUBLIC_SITES.map(plain)).toEqual(fixture.public);
});

it("알려진 사이트 표는 공공기관 표 뒤에 일반 사이트가 이어진다", () => {
  expect(KNOWN_SITES.map(plain)).toEqual(fixture.known);
  expect(KNOWN_SITES.slice(0, PUBLIC_SITES.length)).toEqual([...PUBLIC_SITES]);
});

it("기관 이름으로 찾는 표와 공공기관 출처 목록이 Python과 같다", () => {
  expect(Object.fromEntries([...PUBLIC_AGENCIES].map(([label, entry]) => [label, entry.url]))).toEqual(fixture.agencies);
  expect([...PUBLIC_ORIGINS].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)).toEqual(fixture.origins);
  expect(PUBLIC_ORIGINS.has("https://www.gov.kr")).toBe(true);
  expect(PUBLIC_AGENCIES.get("constructor")).toBeUndefined();
});

it("소개와 대표 업무는 없으면 비워 둔다", () => {
  expect(knownSite(["가"], "https://a.example", "가")).toEqual({ names: ["가"], url: "https://a.example", label: "가", services: [] });
  expect(knownSite(["가"], "https://a.example", "가", "소개", ["업무"]).about).toBe("소개");
});
