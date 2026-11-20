import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { jsRound, todayIso } from "../../src/core/time.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.core.jsutil.today_iso와 js_round다. 만드는 법은 tests/fixtures/core/generate.py.
const fixture = z.object({
  today: z.array(z.tuple([z.string(), z.string()])),
  rounds: z.array(z.tuple([z.number(), z.number()])),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/time.json", import.meta.url), "utf8")));

it("오늘 날짜는 한국 시각 기준으로 하루가 바뀐다", () => {
  expect(fixture.today.length).toBeGreaterThan(10);
  for (const [instant, expected] of fixture.today) expect(todayIso(new Date(instant)), instant).toBe(expected);
  expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
});

it("반올림은 0.5를 올린다(JS Math.round와 같다)", () => {
  for (const [value, expected] of fixture.rounds) expect(Object.is(jsRound(value) + 0, expected + 0), String(value)).toBe(true);
});
