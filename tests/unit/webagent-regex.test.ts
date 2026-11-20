import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { webAgentRegexPorts77 } from "./webagent-regex-77.ts";

// 77aad3e에서 새로 생긴 웹 에이전트 정규식을 Python 일치 구간과 비교한다.
// 기준은 tests/fixtures/webagent/extract-regex.ts가 77aad3e 기록에서 옮긴 것이다.
const fixture = z.object({
  corpus: z.array(z.string()).nonempty(),
  patterns: z.array(z.object({
    id: z.string(), source: z.string(), flags: z.int(),
    sites: z.array(z.tuple([z.string(), z.int().positive()])).nonempty(),
    matches: z.record(z.string(), z.array(z.tuple([z.int(), z.int()]))),
  })),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/webagent/regex.json", import.meta.url), "utf8")));

function spansFor(expression: RegExp, input: string): Array<[number, number]> {
  const flags = expression.global ? expression.flags : expression.flags + "g";
  const codePoints = new Map([[0, 0]]);
  let units = 0;
  for (const character of input) {
    units += character.length;
    codePoints.set(units, codePoints.size);
  }
  return Array.from(input.matchAll(new RegExp(expression.source, flags)), match => {
    const start = codePoints.get(match.index);
    const end = codePoints.get(match.index + match[0].length);
    if (start === undefined || end === undefined) throw new Error("UTF-16 서로게이트 쌍을 나눈 정규식");
    return [start, end];
  });
}

const files = new Set(fixture.patterns.flatMap(row => row.sites.map(([file]) => file)).filter(file => webAgentRegexPorts77.has(file)));
for (const file of files) {
  it(`77aad3e 정규식 일치 구간 · ${file}`, () => {
    for (const row of fixture.patterns.filter(pattern => pattern.sites.some(([owner]) => owner === file))) {
      const expression = webAgentRegexPorts77.get(file)?.get(row.id);
      if (expression === undefined) throw new Error(`missing TS regex: ${file} ${row.id} ${row.source}`);
      const different = fixture.corpus.flatMap((input, index) => {
        const expected = row.matches[String(index)] ?? [];
        const actual = spansFor(expression, input);
        return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [{ input, expected, actual }];
      });
      expect(different.slice(0, 3), row.source).toEqual([]);
    }
  });
}

it("77aad3e 기준에 등록한 정규식은 모두 기록에 있다", () => {
  for (const [file, entries] of webAgentRegexPorts77) {
    for (const id of entries.keys()) {
      expect(fixture.patterns.some(row => row.id === id && row.sites.some(([owner]) => owner === file)), `${file} ${id}`).toBe(true);
    }
  }
});
