import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { ModelConnections } from "../../src/core/llm.ts";
import { EmbeddingService, ModerationService, STACK } from "../../src/core/model_stack.ts";
import { fakeFetch } from "../helpers.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.core.model_stack 서비스를 가짜 HTTP 서버로 돌린 결과다. 만드는 법은 tests/fixtures/core/generate.py.
const run = z.object({
  out: z.union([z.array(z.number()), z.boolean()]).nullable(),
  requests: z.array(z.object({
    url: z.string(), authorization: z.string().nullable(), contentType: z.string().nullable(), body: z.record(z.string(), z.unknown()),
  })),
});
const row = z.tuple([z.string(), z.string(), z.number(), z.string(), run]);
const fixture = z.object({
  stack: z.record(z.string(), z.string()), embed: z.array(row), screen: z.array(row),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/model_stack.json", import.meta.url), "utf8")));

async function observed(text: string, status: number, content: string, call: (pool: ModelConnections) => Promise<unknown>) {
  const fetcher = fakeFetch(() => new Response(content, { status }));
  const out = await call(new ModelConnections(fetcher));
  const requests = await Promise.all(fetcher.calls.map(async request => ({
    url: request.url, authorization: request.headers.get("authorization"), contentType: request.headers.get("content-type"),
    body: z.record(z.string(), z.unknown()).parse(await request.json()),
  })));
  return { out: out ?? null, requests, text };
}

it("역할별 모델 이름이 Python과 같고 바꿀 수 없다", () => {
  expect({ ...STACK }).toEqual(fixture.stack);
  expect(Object.isFrozen(STACK)).toBe(true);
});

it("임베딩은 숫자 하나 이상이 든 벡터 한 개만 돌려주고 나머지는 비운다", async () => {
  for (const [label, text, status, content, expected] of fixture.embed) {
    const actual = await observed(text, status, content, pool => new EmbeddingService("sk-test", "model-x", pool).embed(text));
    expect({ out: actual.out, requests: actual.requests }, label).toEqual(expected);
  }
});

it("검열은 결과 하나의 flagged가 불리언일 때만 돌려주고 나머지는 비운다", async () => {
  for (const [label, text, status, content, expected] of fixture.screen) {
    const actual = await observed(text, status, content, pool => new ModerationService("sk-test", "model-x", pool).screen(text));
    expect({ out: actual.out, requests: actual.requests }, label).toEqual(expected);
  }
});

it("중단 신호가 이미 선 호출은 요청을 보내지 않고 비운다", async () => {
  const fetcher = fakeFetch(() => Response.json({ data: [{ embedding: [1] }] }));
  const stopped = new AbortController();
  stopped.abort();
  await expect(new EmbeddingService("sk-test", "model-x", new ModelConnections(fetcher)).embed("가", { signal: stopped.signal })).resolves.toBeUndefined();
  expect(fetcher.calls).toEqual([]);
});
