import { expect, expectTypeOf, it } from "vitest";
import { createStructuredLlm, overlayLlm, type Redacted, SIMPLE_TEXT_SCHEMA } from "../../src/core/llm.ts";
import { fakeFetch } from "../helpers.ts";
import { fixtureText } from "./redacted-fixture.ts";

it("test_overlay_llm_falls_back", () => {
  const base = { provider: "openai", model: "gpt-4o", apiKey: "k", baseUrl: "https://api.openai.com/v1" };
  expect(overlayLlm(base)).toBe(base);
  expect(overlayLlm(base, { provider: "ollama", model: "qwen2.5" })).toEqual({
    ...base, provider: "ollama", model: "qwen2.5",
  });
});

it("구조화 모델에는 가린 텍스트와 설정한 모델·스키마를 보낸다", async () => {
  expectTypeOf<string>().not.toMatchTypeOf<Redacted>();
  const fetchImpl = fakeFetch(() => Response.json({
    choices: [{ message: { content: '{"text":"완료","extra":null,"nested":[{"value":null},null]}' } }],
  }));
  const llm = createStructuredLlm({
    provider: "openai", model: "configured", baseUrl: "https://example.test/v1/", apiKey: "test", reasoningEffort: "minimal",
  }, fetchImpl);
  const request = { system: "지시", user: fixtureText("가린 입력"), schemaName: "answer", schema: SIMPLE_TEXT_SCHEMA };
  await expect(llm?.generate(request)).resolves.toEqual({ text: "완료", nested: [{}, null] });
  const [call] = fetchImpl.calls;
  expect(call?.url).toBe("https://example.test/v1/chat/completions");
  expect(call?.headers.get("authorization")).toBe("Bearer test");
  expect(await call?.json()).toEqual({
    model: "configured", reasoning_effort: "minimal",
    response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: SIMPLE_TEXT_SCHEMA } },
    messages: [{ role: "system", content: "지시" }, { role: "user", content: "가린 입력" }],
  });
});

it("중단 신호를 대기 중인 요청으로 보내고 결과를 비운다", async () => {
  const fetchImpl = fakeFetch(req => new Promise((_resolve, reject) => {
    req.signal.addEventListener("abort", () => { reject(req.signal.reason); }, { once: true });
  }));
  const llm = createStructuredLlm({ provider: "ollama", model: "local-test" }, fetchImpl);
  const controller = new AbortController();
  const pending = llm?.generate({
    system: "지시", user: fixtureText("입력"), schemaName: "answer", schema: SIMPLE_TEXT_SCHEMA, signal: controller.signal,
  });
  expect(fetchImpl.calls).toHaveLength(1);
  controller.abort();
  await expect(pending).resolves.toBeUndefined();
  expect(fetchImpl.calls[0]?.signal.aborted).toBe(true);
});
