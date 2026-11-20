import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { CTPV, RegionMention, districtAfterProvince, dongForms, parseRegionMention, provinceName, regionPatterns } from "../../src/core/region.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.core.region을 같은 말에 돌린 결과다. 만드는 법은 tests/fixtures/core/generate.py.
const mention = z.object({ province: z.string(), districts: z.array(z.string()), dong: z.string(), present: z.boolean() });
const fixture = z.object({
  mention: z.array(z.tuple([z.string(), mention, mention])),
  afterProvince: z.array(z.tuple([z.string(), z.string()])),
  dongForms: z.array(z.tuple([z.string(), z.array(z.string())])),
  province: z.array(z.tuple([z.string(), z.string()])),
  ctpv: z.record(z.string(), z.string()),
  sources: z.object({ particle: z.string(), area: z.string() }),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/region.json", import.meta.url), "utf8")));

function plain(found: RegionMention) {
  return { province: found.province, districts: [...found.districts], dong: found.dong, present: found.present };
}

it("말한 지역에서 시·도, 시·군·구, 동을 Python과 같게 뽑는다", () => {
  expect(fixture.mention.length).toBeGreaterThan(150);
  const different = fixture.mention.flatMap(([text, expected, bare]) => {
    const actual = { open: plain(parseRegionMention(text)), bare: plain(parseRegionMention(text, { bare: true })) };
    return JSON.stringify(actual) === JSON.stringify({ open: expected, bare }) ? [] : [{ text, expected: { open: expected, bare }, actual }];
  });
  expect(different.slice(0, 10)).toEqual([]);
});

it("시·도 바로 뒤의 시·군·구만 사는 곳으로 본다", () => {
  const different = fixture.afterProvince.flatMap(([text, expected]) => {
    const actual = districtAfterProvince(text);
    return actual === expected ? [] : [{ text, expected, actual }];
  });
  expect(different).toEqual([]);
  expect(districtAfterProvince("부산 사상구 삼락동")).toBe("사상구");
  expect(districtAfterProvince("1인 가구")).toBe("");
});

const byCodePoint = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

it("동 이름의 숫자·한글 숫자·제 표기 후보가 Python과 같다", () => {
  const different = fixture.dongForms.flatMap(([name, expected]) => {
    const actual = [...dongForms(name)].sort(byCodePoint);
    return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [{ name, expected, actual }];
  });
  expect(different).toEqual([]);
  expect([...dongForms("삼성1동")].sort(byCodePoint)).toEqual(["삼성1동", "삼성일동", "삼성제1동", "삼성제일동"]);
});

it("시·도 별칭표와 이름 찾기가 Python과 같다", () => {
  expect(Object.entries(CTPV)).toEqual(Object.entries(fixture.ctpv));
  const different = fixture.province.flatMap(([name, expected]) => provinceName(name) === expected ? [] : [{ name, expected, actual: provinceName(name) }]);
  expect(different).toEqual([]);
  expect(provinceName("광주시")).toBe("");
  expect(provinceName("constructor")).toBe("");
});

it("지역 말이 비었는지는 시·도, 시·군·구, 동 가운데 하나라도 있는지로 본다", () => {
  expect(new RegionMention().present).toBe(false);
  expect(new RegionMention("서울특별시").present).toBe(true);
  expect(new RegionMention("", ["종로구"]).present).toBe(true);
  expect(new RegionMention("", [], "청운동").present).toBe(true);
  expect(Object.isFrozen(new RegionMention("", ["종로구"]).districts)).toBe(true);
});

function nonAscii(source: string): string {
  return [...source].filter(char => (char.codePointAt(0) ?? 0) > 127).sort(byCodePoint).join("");
}

it("정규식 속 한글은 Python 원문과 한 글자도 다르지 않다", () => {
  expect(nonAscii(regionPatterns.particle.source)).toBe(nonAscii(fixture.sources.particle));
  expect(nonAscii(regionPatterns.area.source)).toBe(nonAscii(fixture.sources.area));
});
