import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { addedWelfareRegex } from "./welfare-regex.ts";

const data = z.object({
  corpus: z.array(z.string()),
  matches: z.record(z.string(),z.record(z.string(),z.array(z.tuple([z.int(),z.int()])))),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/welfare/agent-regex.json",import.meta.url),"utf8")));

it("replays exact Python match spans for the welfare agent's new expressions", () => {
  expect(new Set(addedWelfareRegex.keys())).toEqual(new Set(Object.keys(data.matches)));
  for (const [id, expression] of addedWelfareRegex) {
    for (const [index,input] of data.corpus.entries()) {
      const all = new RegExp(expression.source,expression.global ? expression.flags : expression.flags + "g");
      const spans = [...input.matchAll(all)].map(match => {
        const start = Array.from(input.slice(0,match.index)).length;
        return [start, start + Array.from(match[0]).length];
      });
      expect(spans, id + " " + input).toEqual(data.matches[id]?.[String(index)] ?? []);
    }
  }
});
