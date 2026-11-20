import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_IDS, LANGS, PIPELINE_PHASES, SEMANTIC_ACTIONS, SESSION_STATES, STATE_LABELS_KO, draft, parseTurnResult,
} from "../../src/core/turn.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.core.turn.parse_turn_result와 draft다. 만드는 법은 tests/fixtures/core/generate.py.
const outcome = z.union([
  z.object({ error: z.literal(true) }),
  z.object({ ok: z.record(z.string(), z.unknown()) }),
]);
const fixture = z.object({
  actions: z.array(z.string()), states: z.array(z.string()), labels: z.record(z.string(), z.string()), langs: z.array(z.string()),
  agents: z.record(z.string(), z.string()), phases: z.array(z.string()),
  base: z.record(z.string(), z.unknown()),
  fields: z.array(z.tuple([z.string(), z.unknown(), z.union([
    z.object({ error: z.literal(true) }), z.object({ present: z.boolean(), value: z.unknown() }),
  ])])),
  cases: z.array(z.tuple([z.unknown(), outcome])),
  drafts: z.array(z.tuple([z.string(), z.string(), z.string(), z.record(z.string(), z.unknown()), z.record(z.string(), z.unknown())])),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/turn.json", import.meta.url), "utf8")));

it("의미 동작·상태·언어·에이전트 이름표가 Python과 같다", () => {
  expect([...SEMANTIC_ACTIONS]).toEqual(fixture.actions);
  expect([...SESSION_STATES]).toEqual(fixture.states);
  expect({ ...STATE_LABELS_KO }).toEqual(fixture.labels);
  expect([...LANGS]).toEqual(fixture.langs);
  expect({ ...AGENT_IDS }).toEqual(fixture.agents);
  expect([...PIPELINE_PHASES]).toEqual(fixture.phases);
});

function parsed(payload: unknown): Record<string, unknown> | "error" {
  try {
    return z.record(z.string(), z.unknown()).parse(parseTurnResult(payload));
  } catch {
    return "error";
  }
}

it("응답의 새 칸과 바뀐 칸이 값마다 Python과 같이 받아들여지거나 거부된다", () => {
  expect(fixture.fields.length).toBeGreaterThan(150);
  const different = fixture.fields.flatMap(([name, value, expected]) => {
    const actual = parsed({ ...fixture.base, [name]: value });
    const seen = actual === "error" ? { error: true } : { present: Object.hasOwn(actual, name), value: actual[name] ?? null };
    const wanted = "error" in expected ? expected : { present: expected.present, value: expected.value ?? null };
    return isDeepStrictEqual(seen, wanted) ? [] : [{ name, value, expected, actual: seen }];
  });
  expect(different.slice(0, 5)).toEqual([]);
});

it("응답 전체 검사가 알 수 없는 칸·빠진 칸·승인 표시·인계 별명에서 Python과 같다", () => {
  expect(fixture.cases.length).toBeGreaterThan(15);
  const different = fixture.cases.flatMap(([payload, expected]) => {
    const actual = parsed(payload);
    const same = "error" in expected ? actual === "error" : actual !== "error" && isDeepStrictEqual(actual, expected.ok);
    return same ? [] : [{ payload, expected, actual }];
  });
  expect(different.slice(0, 5)).toEqual([]);
});

it("응답 초안은 값이 없는 칸을 빼고 필수 세 칸을 덮어쓰지 않는다", () => {
  for (const [state, semanticAction, speech, extra, expected] of fixture.drafts) {
    const keep = Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== null));
    expect(draft(state === "BROWSING" ? "BROWSING" : "IDLE", semanticAction === "read" ? "read" : "none", speech, keep)).toEqual(expected);
  }
  const made = draft("IDLE", "none", "말", { field: undefined, offersLinks: true, pictureHistory: "사진 설명", privateHistory: false });
  expect(Object.hasOwn(made, "field")).toBe(false);
  expect(made).toEqual({ state: "IDLE", semanticAction: "none", speech: "말", offersLinks: true, pictureHistory: "사진 설명", privateHistory: false });
  const page = { afterActionId: "a1", urlKey: "k", url: "https://www.bokjiro.go.kr/x", title: "복지로", headings: ["기초연금"], selected: [], text: "본문" };
  const reviewed = draft("BROWSING", "goal", "찾았어요.", {
    browserIterations: 3, reviewPages: [page], reviewQuotes: ["기초연금"], reviewQuoteSources: { 기초연금: [page.url] },
  });
  expect(reviewed).toMatchObject({ browserIterations: 3, reviewPages: [page], reviewQuotes: ["기초연금"] });
});
