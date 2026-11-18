import { expect, it } from "vitest";
import { type ModelIntentContext } from "../../src/core/llm.ts";
import { createIntentProvider, flatToIntent, INTENT_JSON_SCHEMA, OpenAICompatibleIntentProvider } from "../../src/understanding/llm_planner.ts";
import { isStopUtterance, RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { Understanding } from "../../src/understanding/understand.ts";
import { FakeLlm, fakeFetch } from "../helpers.ts";
import { fixtureText } from "./redacted-fixture.ts";
import { practiceVocabulary } from "./understanding-rules-regex.ts";

const ctx: ModelIntentContext = { state: "APPLICATION_OPEN" };

function reply(content: unknown, status = 200) {
  return fakeFetch(() => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] }, { status }));
}

function provider(fetchImpl: typeof fetch, structured = true) {
  return new OpenAICompatibleIntentProvider({
    model: "test-model", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", structured,
    rules: new RuleBasedIntentProvider(practiceVocabulary), vocabulary: practiceVocabulary,
  }, fetchImpl);
}

it("test_stop_words_multilingual", () => {
  for (const stop of ["stop", "停止", "止めて", "ストップ"]) expect(isStopUtterance(stop)).toBe(true);
  expect(isStopUtterance("附近的停车场在哪里")).toBe(false);
});

it("test_rules_first_no_llm_call", async () => {
  const fetchImpl = reply({});
  expect(await provider(fetchImpl).parse(fixtureText("다음으로"), ctx)).toEqual({ type: "NEXT" });
  expect(fetchImpl.calls).toHaveLength(0);
});

it("test_openai_strict_schema_no_temperature", async () => {
  const fills = [{ fieldMention: "주소", value: "부산광역시 예시구 예시로 10" }];
  const fetchImpl = reply({ type: "FILL", fills, fieldMention: null, topic: null, text: null });
  const utterance = fixtureText("살고 있는 데가 부산광역시 예시구 예시로 10이에요");
  expect(await provider(fetchImpl).parse(utterance, ctx)).toEqual({ type: "FILL", fills });
  const [call] = fetchImpl.calls;
  expect(call?.url).toBe("https://api.openai.com/v1/chat/completions");
  const body: unknown = await call?.json();
  expect(body).toMatchObject({
    model: "test-model", response_format: { type: "json_schema", json_schema: INTENT_JSON_SCHEMA },
    messages: [{ role: "system", content: expect.any(String) }, { role: "user",
      content: '{"state":"APPLICATION_OPEN","awaitingField":null,"utterance":"살고 있는 데가 부산광역시 예시구 예시로 10이에요"}' }],
  });
  expect(body).not.toHaveProperty("temperature");
});

it("test_compatible_mode_json_object", async () => {
  const fetchImpl = reply({ type: "HELP_HUMAN" });
  expect(await provider(fetchImpl, false).parse(fixtureText("누구랑 직접 얘기하고 싶어"), ctx)).toEqual({ type: "HELP_HUMAN" });
  expect(await fetchImpl.calls[0]?.json()).toMatchObject({ temperature: 0, response_format: { type: "json_object" } });
});

it("test_llm_cannot_approve_or_stop", async () => {
  for (const type of ["APPROVE", "STOP"]) {
    const fetchImpl = reply({ type, fills: null, fieldMention: null, topic: null, text: null });
    expect((await provider(fetchImpl).parse(fixtureText("그래 그렇게 해"), ctx)).type).toBe("UNKNOWN");
    expect(INTENT_JSON_SCHEMA.schema.properties.type.enum).not.toContain(type);
  }
});

it("test_llm_failures_fall_back", async () => {
  const offline = fakeFetch(() => { throw new Error("offline"); });
  const invalid = reply({ type: "FILL", fills: [], fieldMention: null, topic: null, text: null });
  for (const fetchImpl of [reply({}, 400), invalid, offline]) {
    expect((await provider(fetchImpl).parse(fixtureText("음 뭐였더라"), ctx)).type).toBe("UNKNOWN");
  }
});

it("test_flat_unknown_uses_utterance", () => {
  expect(flatToIntent({ type: "UNKNOWN", text: "조작된 텍스트" }, "원래 발화")).toEqual({ type: "UNKNOWN", text: "원래 발화" });
});

it("test_no_key_means_rules", () => {
  const cfg = { provider: "openai", model: "m" };
  expect(createIntentProvider(cfg, practiceVocabulary).name).toBe("mock-rule");
  expect(createIntentProvider({ ...cfg, apiKey: "sk" }, practiceVocabulary).name).toBe("openai(m)+mock-rule");
});

it("한 발화의 연속 입력을 합치고 모르는 단계는 건너뛴다", async () => {
  const fills = [{ fieldMention: "주소", value: "예시로 10" }, { fieldMention: "이름", value: "김하늘" }];
  const llm = new FakeLlm({ intent_plan: { steps: [
    ...fills.map(fill => ({ type: "FILL", fills: [fill] })), { type: "UNKNOWN" }, { type: "NEXT" },
  ] } });
  const rules = new RuleBasedIntentProvider(practiceVocabulary);
  const parser = new Understanding(rules, { intentProvider: rules, llm }, practiceVocabulary);
  const traces: string[] = [];
  const turn = { clarifying: false, recent: [], trace: (note: string) => { traces.push(note); } };
  const text = fixtureText("음 뭐였더라");
  await expect(parser.understand(text, ctx, turn)).resolves.toEqual({
    by: "fake", intents: [{ type: "FILL", fills }, { type: "NEXT" }],
  });
  expect(traces).toEqual(["LLM 계획"]);
  expect(llm.calls).toHaveLength(1);
  await expect(parser.understand(text, ctx, { ...turn, clarifying: true })).resolves.toEqual({
    by: "rules", intents: [{ type: "UNKNOWN", text }],
  });
  expect(llm.calls).toHaveLength(1);
});
