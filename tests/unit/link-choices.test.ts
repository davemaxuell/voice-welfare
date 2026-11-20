import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { LinkChoices, linkReference, resolveDescription } from "../../src/agents/web/link_choices.ts";
import type { LlmRequest } from "../../src/core/llm.ts";
import { PICTURE_CONTACT } from "../../src/safety/privacy.ts";

// 기대값은 pyref(77aad3e)의 link_reference를 같은 말에 돌린 결과다. 만드는 법은 tests/fixtures/webagent/generate.py.
const rows = z.array(z.object({
  text: z.string(), state: z.enum(["none", "stale", "proposed", "recent", "single"]),
  result: z.object({ action: z.string(), index: z.int().nullable(), match_description: z.boolean() }).nullable(),
})).parse(JSON.parse(readFileSync(new URL("../fixtures/webagent/link_reference.json", import.meta.url), "utf8")));

const options = [1, 2, 3].map(index => ({ name: `항목${index}`, ref: `r${index}`, role: "link" }));
const states = {
  none: () => undefined,
  stale: () => new LinkChoices("http://x/", options, "search"),
  proposed: () => new LinkChoices("http://x/", options, "search", 2, "o1"),
  recent: () => new LinkChoices("http://x/", options, "list", undefined, "o2"),
  single: () => new LinkChoices("http://x/", options.slice(0, 1), "list", undefined, "o3"),
};

it("링크 선택지를 가리키는 말을 Python과 같게 해석한다", () => {
  expect(rows.length).toBeGreaterThan(200);
  const different = rows.flatMap(row => {
    const found = linkReference(row.text, states[row.state]());
    const actual = found === undefined ? null : { action: found.action, index: found.index ?? null, match_description: found.matchDescription };
    return JSON.stringify(actual) === JSON.stringify(row.result) ? [] : [{ ...row, actual }];
  });
  expect(different.slice(0, 5)).toEqual([]);
});

it("목록은 보이는 이름마다 링크를 먼저 고르고 검색 결과는 누를 수 있는 링크만 둔다", () => {
  const view = { url: "http://x/", outline: { items: [
    { ref: "b1", role: "button" as const, name: "안내", disabled: false },
    { ref: "l1", role: "link" as const, name: "안내", disabled: false },
    { ref: "l2", role: "link" as const, name: "결과", disabled: false, searchResult: true },
    { ref: "l3", role: "link" as const, name: "막힘", disabled: true, searchResult: true },
  ] } };
  expect(LinkChoices.named(view, ["안내", "없음"]).options).toEqual([{ name: "안내", ref: "l1", role: "link" }]);
  expect(LinkChoices.search(view).options).toEqual([{ name: "결과", ref: "l2", role: "link" }]);
});

it("설명으로 고른 번호는 보낸 선택지 안의 정수만 받는다", async () => {
  const sent: LlmRequest[] = [];
  const model = (index: unknown) => ({ name: "fake", generate: async (request: LlmRequest) => { sent.push(request); return { index }; } });
  const choices = new LinkChoices("http://x/", [...options, { name: "문의 010-1234-5678", ref: "r4", role: "link" }], "list");
  expect(await resolveDescription(model(2), "두 번째 거", choices, undefined, text => text)).toBe(2);
  expect(JSON.parse(sent[0]?.user ?? "{}")).toEqual({ utterance: "두 번째 거", options: { 1: "항목1", 2: "항목2", 3: "항목3", 4: "문의 [비공개]" } });
  expect(await resolveDescription(model(5), "x", choices, undefined, text => text)).toBeUndefined();
  expect(await resolveDescription(model(true), "x", choices, undefined, text => text)).toBeUndefined();
  expect(await resolveDescription(model(1.5), "x", choices, undefined, text => text)).toBeUndefined();
  expect(await resolveDescription(undefined, "x", choices, undefined, text => text)).toBeUndefined();
});

it("사진·선택지 글의 연락처 가리기는 Python의 PICTURE_CONTACT 구간과 같다", () => {
  const cases: Array<[string, Array<[number, number]>]> = [
    ["ıa@b.co", [[1, 7]]], ["İa@b.co", [[0, 7]]], ["ſa@b.co", [[0, 7]]], ["Ka@b.co", [[0, 7]]], ["A@B.CO", [[0, 6]]],
    ["010-1234-5678", [[0, 13]]], ["０１０-1234-5678", []], ["010 1234 5678", [[0, 13]]], ["+82 10-1234-5678", [[0, 16]]], ["０2-123-4567", []],
  ];
  for (const [text, spans] of cases) {
    expect([...text.matchAll(PICTURE_CONTACT)].map(match => [match.index, match.index + match[0].length]), text).toEqual(spans);
  }
});
