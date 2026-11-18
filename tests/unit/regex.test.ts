import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import { partialSources, portedSources as ported } from "../../scripts/port-manifest.ts";
import { regexPorts } from "./regex-ports.ts";

const span = z.tuple([z.int().nonnegative(), z.int().nonnegative()]);
const pattern = z.object({
  id: z.string(),
  source: z.string(),
  flags: z.int(),
  sites: z.array(z.tuple([z.string(), z.int().positive()])).nonempty(),
  matches: z.record(z.string(), z.array(span)),
});
const adoption = z.object({
  kind: z.literal("regex"),
  id: z.string(),
  input: z.string(),
  python: z.array(span),
  spans: z.array(span),
  reason: z.string().trim().min(1),
});

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const corpus = z.array(z.string()).nonempty().parse(JSON.parse(read("../fixtures/regex/corpus.json")));
const patterns = read("../fixtures/regex/patterns.jsonl").trimEnd().split("\n")
  .map(line => pattern.parse(JSON.parse(line)));
const exceptions = z.array(z.object({ kind: z.string() }).passthrough())
  .parse(JSON.parse(read("../fixtures/oracle/adopt-js.json")))
  .filter(entry => entry.kind === "regex").map(entry => adoption.parse(entry));

function spansFor(expression: RegExp, input: string): Array<[number, number]> {
  const flags = expression.global ? expression.flags : expression.flags + "g";
  const matches = Array.from(input.matchAll(new RegExp(expression.source, flags)));
  if (matches.length === 0) return [];
  const codePoints = new Map([[0, 0]]);
  let units = 0;
  for (const character of input) {
    units += character.length;
    codePoints.set(units, codePoints.size);
  }
  return matches.map(match => {
    const start = codePoints.get(match.index);
    const end = codePoints.get(match.index + match[0].length);
    if (start === undefined || end === undefined) throw new Error("UTF-16 서로게이트 쌍을 나눈 정규식");
    return [start, end];
  });
}

function portedExpression(file: string, id: string): RegExp {
  const expression = regexPorts.get(file)?.get(id);
  if (expression === undefined) throw new Error(`missing TS regex: ${file} ${id}`);
  return expression;
}

function compare(row: z.infer<typeof pattern>, expression: RegExp, adopted: typeof exceptions = []): void {
  for (const [index, input] of corpus.entries()) {
    const expected = row.matches[String(index)] ?? [];
    const actual = spansFor(expression, input);
    const exception = adopted.find(entry => entry.id === row.id && entry.input === input);
    if (exception !== undefined) {
      expect(actual).not.toEqual(expected);
      expect(expected).toEqual(exception.python);
      expect(actual).toEqual(exception.spans);
    } else if (!isDeepStrictEqual(actual, expected)) {
      expect(actual, JSON.stringify({ sites: row.sites, regex: row.source, flags: row.flags, input })).toEqual(expected);
    }
  }
}

it("코드 포인트로 이모지 뒤의 구간과 빈 일치를 비교한다", () => {
  expect(spansFor(/(?=한)|A/u, "😀한A")).toEqual([[1, 1], [2, 3]]);
  expect(() => spansFor(/./, "😀")).toThrow(/UTF-16/);
  expect(() => portedExpression("없는 파일", "누락")).toThrow(/missing TS regex/);
});

it("기록된 공백 구간으로 Python과 JS의 BOM 처리 차이를 찾아낸다", () => {
  const whitespace = patterns.find(row => row.source === String.raw`\s+` && row.flags === 0);
  if (whitespace === undefined) throw new Error("missing Python whitespace fixture");
  compare(whitespace, /\p{White_Space}+/u);
  expect(() => compare(whitespace, /\s+/u)).toThrow();
});

it("정규식 예제·등록·예외가 현재 기록에 있는지 확인한다", () => {
  expect(patterns.length).toBeGreaterThan(0);
  expect(new Set(patterns.map(row => row.id)).size).toBe(patterns.length);
  for (const [file, entries] of regexPorts) {
    expect(ported.has(file) || partialSources.has(file), file).toBe(true);
    for (const id of entries.keys()) {
      expect(patterns.some(row => row.id === id && row.sites.some(([owner]) => owner === file)), id).toBe(true);
    }
  }
  const keys = exceptions.map(entry => JSON.stringify([entry.id, entry.input]));
  expect(new Set(keys).size).toBe(keys.length);
  for (const entry of exceptions) {
    expect(corpus).toContain(entry.input);
    expect(patterns.some(row => row.id === entry.id && row.sites.some(([file]) => ported.has(file))), entry.id).toBe(true);
  }
});

const files = new Set(patterns.flatMap(row => row.sites.map(([file]) => file)));
for (const file of files) {
  it(`정규식 일치 구간 · ${file}`, () => {
    for (const row of patterns.filter(row => row.sites.some(([owner]) => owner === file))) {
      compare(row, portedExpression(file, row.id), exceptions);
    }
  });
}
