import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { KINDS, PLACE_KINDS, PlaceAsk, isPlaceKind, isPlaceRequest, placeKind, placePatterns } from "../../src/core/places.ts";
import { RegionMention } from "../../src/core/region.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.core.places를 같은 말에 돌린 결과다. 만드는 법은 tests/fixtures/core/generate.py.
const fixture = z.object({
  kinds: z.record(z.string(), z.string()),
  labels: z.record(z.string(), z.string()),
  order: z.array(z.string()),
  sources: z.record(z.string(), z.string()),
  cases: z.array(z.tuple([z.string(), z.string().nullable(), z.boolean()])),
  replace: z.array(z.tuple([z.string(), z.string(), z.string()])),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/places.json", import.meta.url), "utf8")));

it("기관 종류 번호와 찾는 순서·이름이 Python과 같다", () => {
  expect(PLACE_KINDS).toEqual(fixture.kinds);
  expect([...KINDS.keys()]).toEqual(fixture.order);
  expect(Object.fromEntries([...KINDS].map(([kind, spec]) => [kind, spec.label]))).toEqual(fixture.labels);
  expect(isPlaceKind("15059715")).toBe(true);
  expect(isPlaceKind("1")).toBe(false);
});

it("기관 종류와 위치·전화번호 요청 판정이 말마다 Python과 같다", () => {
  expect(fixture.cases.length).toBeGreaterThan(90);
  const different = fixture.cases.flatMap(([text, kind, request]) => {
    const actual = { kind: placeKind(text) ?? null, request: isPlaceRequest(text) };
    return actual.kind === kind && actual.request === request ? [] : [{ text, expected: { kind, request }, actual }];
  });
  expect(different.slice(0, 10)).toEqual([]);
});

it("기관 이름을 공백으로 바꾸는 일도 Python의 sub와 같다", () => {
  expect(fixture.replace.length).toBeGreaterThan(50);
  const different = fixture.replace.flatMap(([text, expected, kindValue]) => {
    const spec = [...KINDS].find(([kind]) => kind === kindValue)?.[1];
    const actual = spec === undefined ? undefined : text.replace(spec.pattern, " ");
    return actual === expected ? [] : [{ text, kindValue, expected, actual }];
  });
  expect(different.slice(0, 10)).toEqual([]);
});

it("찾을 때는 search를 써서 전역 정규식의 lastIndex에 걸리지 않는다", () => {
  for (let round = 0; round < 3; round++) expect(placeKind("우리 동네 주민센터 어디야?")).toBe(PLACE_KINDS.DONG_OFFICE);
});

it("되물을 때 남기는 값은 바꿀 수 없고 기본 칸 이름은 region이다", () => {
  const ask = new PlaceAsk(PLACE_KINDS.PENSION, new RegionMention("서울특별시"));
  expect([ask.options, ask.field]).toEqual([[], "region"]);
  expect(Object.isFrozen(ask)).toBe(true);
  expect(Object.isFrozen(ask.options)).toBe(true);
  expect(new PlaceAsk(PLACE_KINDS.DONG_OFFICE, new RegionMention(), ["종로구"], "district").field).toBe("district");
});

function nonAscii(source: string): string {
  return [...source].filter(char => (char.codePointAt(0) ?? 0) > 127).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join("");
}

it("정규식 속 한글은 Python 원문과 한 글자도 다르지 않다", () => {
  const pairs: [RegExp, string | undefined][] = [
    [placePatterns.dongOffice, fixture.sources[PLACE_KINDS.DONG_OFFICE]], [placePatterns.pension, fixture.sources[PLACE_KINDS.PENSION]],
    [placePatterns.mobility, fixture.sources[PLACE_KINDS.MOBILITY]], [placePatterns.cue, fixture.sources.cue],
    [placePatterns.screen, fixture.sources.screen],
  ];
  for (const [ported, python] of pairs) expect(nonAscii(ported.source), python).toBe(nonAscii(python ?? ""));
});
