import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { fullMatch, sessionPatterns } from "../../src/orchestrator/patterns.ts";
import { sessionRegexPorts77 } from "./session-regex-77.ts";

// 77aad3e의 session.py 정규식을 Python 일치 구간과 비교한다. 기준은 tests/fixtures/session/generate.py가
// 77aad3e 기록의 식을 Python에서 다시 돌려 만든 것이다(기록의 1613개 글에 한글·전각 숫자·빈 글 예문을 더했다).
const fixture = z.object({
  corpus: z.array(z.string()).nonempty(),
  patterns: z.array(z.object({
    id: z.string(), source: z.string(), flags: z.int(),
    sites: z.array(z.tuple([z.string(), z.int().positive()])).nonempty(),
    matches: z.record(z.string(), z.array(z.tuple([z.int(), z.int()]))),
  })).nonempty(),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/session/regex.json", import.meta.url), "utf8")));

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

it.each(fixture.patterns)("77aad3e 정규식 일치 구간 · $source", row => {
  const expression = sessionRegexPorts77.get(row.id);
  if (expression === undefined) throw new Error(`missing TS regex: ${row.id} ${row.source}`);
  const different = fixture.corpus.flatMap((input, index) => {
    const expected = row.matches[String(index)] ?? [];
    const actual = spansFor(expression, input);
    return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [{ input, expected, actual }];
  });
  expect(different.slice(0, 3)).toEqual([]);
});

it("77aad3e 기준에 등록한 정규식은 모두 기록에 있다", () => {
  expect([...sessionRegexPorts77.keys()].sort((a, b) => a < b ? -1 : 1)).toEqual(fixture.patterns.map(row => row.id).sort((a, b) => a < b ? -1 : 1));
});

it("fullMatch는 글 전체가 맞을 때만 일치한다", () => {
  expect(fullMatch(sessionPatterns.numberedChoice, "제2번이요")?.[1]).toBe("2");
  expect(fullMatch(sessionPatterns.numberedChoice, "두 번째요")?.[1]).toBeUndefined();
  expect(fullMatch(sessionPatterns.numberedChoice, "2번 눌러줘")).toBeNull();
  expect(fullMatch(sessionPatterns.declineSending, "보내지 마.")).not.toBeNull();
  expect(fullMatch(sessionPatterns.declineSending, "아니 그거 말고")).toBeNull();
  expect(fullMatch(sessionPatterns.spaces, " \t")).not.toBeNull();
});
