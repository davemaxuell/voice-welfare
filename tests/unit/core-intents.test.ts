import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import { HELP_GROUPS, INTENTS, helpPages, parseIntent, type HelpGroup } from "../../src/core/intents.ts";

// 기대값은 pyref(77aad3e)의 의도 표(core/intents.py)와 parse_intent다. 만드는 법은 tests/fixtures/core/generate.py.
const fixture = z.object({
  table: z.array(z.object({
    type: z.string(), describe: z.string(), help: z.string().nullable(), examples: z.array(z.tuple([z.string(), z.string()])),
    params: z.array(z.tuple([z.string(), z.boolean()])), llm: z.boolean(), beforeConsent: z.boolean(),
  })),
  cases: z.array(z.tuple([z.unknown(), z.record(z.string(), z.unknown()).nullable()])),
  pages: z.array(z.tuple([z.array(z.string()), z.boolean(), z.array(z.array(z.tuple([z.string(), z.array(z.string())])))])),
  groups: z.array(z.string()),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/intents.json", import.meta.url), "utf8")));

it("의도 표의 줄 순서·설명·도움말 묶음·예문·표지가 Python과 같다", () => {
  expect(INTENTS).toHaveLength(43);
  expect(INTENTS.map(spec => ({
    type: spec.type, describe: spec.describe, help: spec.help ?? null, examples: spec.examples.map(example => [example.text, example.state]),
    llm: spec.llm, beforeConsent: spec.beforeConsent,
  }))).toEqual(fixture.table.map(({ params: _params, ...row }) => row));
  expect([...HELP_GROUPS]).toEqual(fixture.groups);
});

it("매개변수 이름과 꼭 있어야 하는지가 Python과 같다", () => {
  const actual = INTENTS.map(spec => [spec.type, Object.entries<z.ZodType>(spec.schema.shape)
    .filter(([name]) => name !== "type")
    .map(([name, schema]) => [name, !schema.safeParse(undefined).success])]);
  expect(actual).toEqual(fixture.table.map(row => [row.type, row.params]));
});

it("의도 객체 검사가 올바른 값·경계 값·틀린 형식에서 Python과 같다", () => {
  expect(fixture.cases.length).toBeGreaterThan(400);
  const different = fixture.cases.flatMap(([payload, expected]) => {
    const actual = parseIntent(payload) ?? null;
    return isDeepStrictEqual(actual, expected) ? [] : [{ payload, expected, actual }];
  });
  expect(different.slice(0, 5)).toEqual([]);
});

it("새 의도는 매개변수 없이 또는 정해진 매개변수로 받는다", () => {
  for (const type of ["FIND_PLACE", "READ_START_GUIDE", "INTRO_REPLAY", "SETUP_RESTART"]) expect(parseIntent({ type })).toEqual({ type });
  expect(parseIntent({ type: "OPEN_OFFICIAL" })).toEqual({ type: "OPEN_OFFICIAL" });
  expect(parseIntent({ type: "OPEN_OFFICIAL", service: "2번" })).toEqual({ type: "OPEN_OFFICIAL", service: "2번" });
  expect(parseIntent({ type: "DESCRIBE_PICTURE", question: "접수 기한이 언제야?" })).toEqual({ type: "DESCRIBE_PICTURE", question: "접수 기한이 언제야?" });
  expect(parseIntent({ type: "DESCRIBE_PICTURE" })).toBeUndefined();
  expect(parseIntent({ type: "DESCRIBE_PICTURE", question: "" })).toBeUndefined();
});

it("도움말 쪽 나누기가 화면 묶음과 동의 여부마다 Python과 같다", () => {
  expect(fixture.pages).toHaveLength(16);
  for (const [lead, consented, expected] of fixture.pages) {
    const groups = lead.flatMap(name => HELP_GROUPS.filter((group): group is HelpGroup => group === name));
    expect(helpPages(groups, consented), JSON.stringify([lead, consented])).toEqual(expected);
  }
});
