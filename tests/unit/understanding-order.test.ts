import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createMockWelfareProfile, fieldVocabulary } from "../../src/agents/web/profile.ts";
import { SessionStateSchema, type SessionState } from "../../src/core/turn.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { fastIntent } from "../../src/understanding/fastpath.ts";
import { INTENT_JSON_SCHEMA } from "../../src/understanding/llm_planner.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { PLAN_TIMEOUT_MS, Understanding } from "../../src/understanding/understand.ts";
import { FakeLlm } from "../helpers.ts";

const rules = new RuleBasedIntentProvider(["이름"]);
const vocabulary = fieldVocabulary(createMockWelfareProfile("http://127.0.0.1:5174"));
const fastCases = z.array(z.object({ text: z.string(), state: SessionStateSchema, expect: z.array(z.string()), fast: z.boolean() }))
  .parse(JSON.parse(readFileSync(new URL("../fixtures/understanding_cases.json", import.meta.url), "utf8"))).filter(row => row.fast);
it.each(fastCases.flatMap(row => [true, false].map(online => ({ row, online }))))("test_fast_cases_never_call_the_model", async ({ row, online }) => {
  const rules = new RuleBasedIntentProvider(vocabulary);
  const model = new FakeLlm();
  const parser = new Understanding(rules, { llm: online ? model : undefined, intentProvider: rules }, vocabulary);
  const result = await parser.understand(redactText(row.text), { state: row.state }, { clarifying: false, recent: [], trace() {} });
  expect(row.expect).toContain(result.intents[0]?.type);
  expect(model.calls).toHaveLength(0);
});
type Llm = ConstructorParameters<typeof Understanding>[1]["llm"];

function flat(type: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...Object.fromEntries(Object.keys(INTENT_JSON_SCHEMA.schema.properties).map(key => [key, null])), type, ...fields };
}

async function understand(text: string, llm: Llm, state: SessionState = "BROWSING",
  { clarifying = false, awaited }: { clarifying?: boolean; awaited?: { validate?: (value: string) => { ok: boolean } } } = {}) {
  return new Understanding(rules, { llm, intentProvider: rules }, ["이름"]).understand(
    redactText(text), { state, awaitingFieldId: awaited === undefined ? undefined : redactText("name") },
    { awaited, clarifying, recent: [], trace: () => undefined },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

it.each([
  ["멈춰", "BROWSING", "STOP"],
  ["지금 어디까지 했어?", "BROWSING", "PROGRESS"],
  ["응", "WAITING_FOR_USER_CONFIRMATION", "APPROVE"],
  ["아니", "WAITING_FOR_USER_CONFIRMATION", "REJECT"],
  ["다 했어", "AUTH_HANDOFF", "AUTH_DONE"],
  ["복지로 열어줘", "IDLE", "OPEN_SITE"],
  ["정부24", "IDLE", "OPEN_SITE"],
  ["공지사항 눌러줘", "BROWSING", "FOLLOW_LINK"],
  ["화면 사진으로 설명해줘", "BROWSING", "DESCRIBE_PICTURE"],
] as const)("test_fast_path_skips_model", async (text, state, kind) => {
  const fake = new FakeLlm();
  const out = await understand(text, fake, state);
  expect(out.by).toBe("fast");
  expect(out.intents[0]?.type).toBe(kind);
  expect(fake.calls).toEqual([]);
});

it("test_model_decides_misread_phrase", async () => {
  const fake = new FakeLlm({ intent_plan: { steps: [flat("POLICY_QUESTION", { topic: "필요한 서류" })] } });
  const out = await understand("신청하지 마시고 필요한 서류만 알려줘", fake);
  expect(out).toEqual({ by: "fake", intents: [{ type: "POLICY_QUESTION", topic: "필요한 서류" }] });
  expect(fake.calls.map(call => call.schemaName)).toEqual(["intent_plan"]);
});

it("test_question_while_waiting_never_approves", async () => {
  const text = "이 버튼 눌러도 돼?";
  const out = await understand(text, new FakeLlm({ intent_plan: { steps: [flat("UNKNOWN", { text })] } }), "WAITING_FOR_USER_CONFIRMATION");
  expect(out).toEqual({ by: "fake", intents: [{ type: "UNKNOWN", text }] });
});

it("test_planner_unknown_is_final", async () => {
  const text = "그거 말고 다른 거 찾아줘";
  const out = await understand(text, new FakeLlm({ intent_plan: { steps: [flat("UNKNOWN", { text })] } }));
  expect(out).toEqual({ by: "fake", intents: [{ type: "UNKNOWN", text }] });
});

it("test_planner_error_falls_back", async () => {
  const out = await understand("문의사항 눌러줘", new FakeLlm(() => { throw new Error("boom"); }));
  expect(out).toEqual({ by: "rules-fallback", intents: [{ type: "FOLLOW_LINK", name: "문의사항" }] });
});

it("test_planner_timeout_falls_back", async () => {
  vi.useFakeTimers();
  const slow = { name: "slow", generate: () => new Promise<unknown>(() => undefined) };
  const pending = understand("문의사항 눌러줘", slow);
  await vi.advanceTimersByTimeAsync(PLAN_TIMEOUT_MS);
  const out = await pending;
  expect(out.by).toBe("rules-fallback");
  expect(out.intents[0]?.type).toBe("FOLLOW_LINK");
});

it.each([
  [[]],
  ["APPROVE"],
  [[flat("READ_MAIN"), flat("APPROVE")]],
  [[flat("READ_MAIN"), flat("DESCRIBE_PICTURE")]],
])("test_bad_plan_falls_back_as_a_whole", async steps => {
  const out = await understand("문의사항 눌러줘", new FakeLlm({ intent_plan: { steps } }));
  expect(out).toEqual({ by: "rules-fallback", intents: [{ type: "FOLLOW_LINK", name: "문의사항" }] });
});

it("test_split_rules_fallback_does_not_grant_approval", async () => {
  const out = await understand("응 그리고 본문 읽어줘", new FakeLlm({ intent_plan: { steps: [flat("APPROVE")] } }), "WAITING_FOR_USER_CONFIRMATION");
  expect(out.by).toBe("rules-fallback");
  expect(out.intents.every(intent => intent.type !== "APPROVE")).toBe(true);
});

it("test_unknown_step_keeps_its_question", async () => {
  const text = "자격이 뭐야? 그리고 오늘 날씨는 어때?";
  const plan = [flat("UNKNOWN"), flat("POLICY_QUESTION", { topic: "자격" }), flat("UNKNOWN", { text: "오늘 날씨는 어때?" })];
  const out = await understand(text, new FakeLlm({ intent_plan: { steps: plan } }));
  expect(out.intents).toEqual([{ type: "POLICY_QUESTION", topic: "자격" }, { type: "UNKNOWN", text: "오늘 날씨는 어때?" }]);
});

it("test_only_duplicate_unknown_steps_leave_one_unknown", async () => {
  const text = "그거 말고 다른 거 찾아줘";
  const out = await understand(text, new FakeLlm({ intent_plan: { steps: [flat("UNKNOWN"), flat("UNKNOWN")] } }));
  expect(out).toEqual({ by: "fake", intents: [{ type: "UNKNOWN", text }] });
});

it.each([
  ["김하늘", false, { validate: () => ({ ok: true }) }],
  ["두 번째 항목", true, undefined],
  ["2번 눌러줘", false, undefined],
] as const)("test_contextual_input_skips_model", async (text, clarifying, awaited) => {
  const fake = new FakeLlm();
  const out = await understand(text, fake, "BROWSING", { clarifying, awaited });
  expect(out.by).toBe("rules");
  expect(fake.calls).toEqual([]);
});

it.each([
  [["화면 사진으로 설명해줘", "본문 읽어줘"], false],
  [["본문 읽어줘", "화면 사진으로 설명해줘"], false],
  [["화면 사진으로 설명해줘", "본문 읽어줘"], true],
  [["본문 읽어줘", "화면 사진으로 설명해줘"], true],
] as const)("test_compound_picture_commands_keep_both_steps", async (parts, withModel) => {
  const fake = withModel ? new FakeLlm() : undefined;
  const out = await understand(parts.join(" 그리고 "), fake);
  expect(out.intents).toEqual(parts.map(part => rules.parseSync(part, { state: "BROWSING" })));
  if (fake !== undefined) expect(fake.calls).toEqual([]);
});

it("test_picture_needs_explicit_words", () => {
  expect(fastIntent("스크린샷 없이 차트를 알려줘", { state: "BROWSING" }, rules)).toBeUndefined();
});

it("test_later_clause_can_withdraw_picture_request_even_on_failure", async () => {
  const out = await understand("화면 사진으로 설명해줘 그리고 사진 보내지 마", new FakeLlm({ intent_plan: { steps: [flat("DESCRIBE_PICTURE")] } }));
  expect(out.intents.every(intent => intent.type !== "DESCRIBE_PICTURE")).toBe(true);
});
