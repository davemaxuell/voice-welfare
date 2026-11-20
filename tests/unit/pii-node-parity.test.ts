import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { models } from "../../src/core/assets.ts";
import { bertCharClass, PiiModel } from "../../src/safety/pii_model.ts";

// Expected values come from the Python PiiModel: tests/fixtures/pii/reference.py.
const fixtures = join(import.meta.dirname, "../fixtures/pii");
const read = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), "utf8"));
const { header, cases } = z.object({
  header: z.object({ threshold: z.number() }),
  cases: z.array(z.object({
    text: z.string(),
    spans: z.array(z.tuple([z.string(), z.int(), z.int(), z.number()])),
    secret: z.array(z.tuple([z.string(), z.int(), z.int()])),
  })).min(200),
}).parse(read("cases.json"));
const runs = z.array(z.tuple([z.int(), z.enum(["removed", "space", "alone", "char", "surrogate"])])).parse(read("char-classes.json"));

it("tokenizer characters behave as in the Rust tokenizer for every code point", () => {
  const wrong: string[] = [];
  for (const [index, [first, kind]] of runs.entries()) {
    if (kind === "surrogate") continue;
    const end = runs[index + 1]?.[0] ?? 0x110000;
    for (let point = first; point < end; point++) {
      const actual = bertCharClass(String.fromCodePoint(point));
      if (actual !== kind) wrong.push(`U+${point.toString(16).toUpperCase()} ${actual}, Python ${kind}`);
    }
  }
  expect(wrong).toEqual([]);
});

const directory = join(models, "koelectra-ko-pii-ner");
describe.skipIf(!PiiModel.available(directory))("Python PiiModel parity", () => {
  const everything = new PiiModel(directory, 0);
  const gated = new PiiModel(directory, header.threshold);
  afterAll(() => Promise.all([everything.close(), gated.close()]));

  it("finds the same spans with code-point offsets, scores within 1e-3", async () => {
    const mismatches: string[] = [];
    for (const { text, spans } of cases) {
      const actual = await everything.find(text);
      const same = actual.length === spans.length && actual.every((span, index) => {
        const [label, start, end, score] = spans[index] ?? [];
        return span.label === label && span.start === start && span.end === end && score !== undefined &&
          Math.abs(span.score - score) < 1e-3 && (span.score >= header.threshold) === (score >= header.threshold);
      });
      if (!same) mismatches.push(JSON.stringify({ text, node: actual.map(s => [s.label, s.start, s.end, s.score]), python: spans }));
    }
    expect(mismatches).toEqual([]);
  });

  it("blocks the same tier-1 values as Python", async () => {
    expect(await gated.secretSpans(cases.map(c => c.text))).toEqual(cases.map(c => c.secret));
  });
});
