import { expect, it } from "vitest";
import { z } from "zod";
import { ExecContext, WebExecutionAgent } from "../../src/agents/web/agent.ts";
import { Autopilot } from "../../src/agents/web/autopilot.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { ACTION_TYPES } from "../../src/core/actions.ts";
import { ModelConnections, OPENAI_BASE_URL, OpenAIStructuredLlm } from "../../src/core/llm.ts";
import { STACK } from "../../src/core/model_stack.ts";
import { translateIn, translateOut } from "../../src/language/i18n.ts";
import { decide, PublicTask } from "../../src/orchestrator/public_task.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { TavilySearch } from "../../src/server/public_search.ts";
import { LiveProvider } from "../../src/server/voice_edge.ts";
import { chatRoute } from "../../src/understanding/chat.ts";
import { planWithLlm } from "../../src/understanding/llm_planner.ts";
import { FakeLlm, fakeFetch } from "../helpers.ts";

const demonstration = /\bfor example\b|\be\.g\.|\bexample\s*:|(?:예시?|예문)\s*[:：]|["'”’]\s*→|로그인은 됐고 국가장학금 서류만 알려줘|FILL\(이름=김하늘\)|such as an annual calendar|such as Korean public holidays/iu;
const message = z.object({ role: z.string(), content: z.string() });

it("test_outgoing_instructions_and_real_user_context", async () => {
  const transport = fakeFetch(() => Response.json({ choices: [] }));
  const pool = new ModelConnections(transport);
  const model = new OpenAIStructuredLlm({ model: STACK.agent, baseUrl: OPENAI_BASE_URL, apiKey: "test", provider: "openai", pool });
  const utterance = redactText("하이코리아 홈페이지 열어줘"), prior = redactText("예: 안내문에 적힌 표현을 다시 읽어 주세요.");
  const history = [{ agency: "정부24", request: prior, reply: "읽었어요." }];
  const signal = new AbortController().signal;
  try {
    await decide(model, utterance, "ko", new PublicTask({ agency: "정부24" }), { voice: true, recent: history, signal });
    await planWithLlm(model, utterance, { state: "BROWSING" }, ["이름"], { history: [prior] });
    await chatRoute(model, utterance, { recent: [prior], askedJustNow: false });
    await translateIn(model, "Open the homepage", "en");
    await translateOut(model, utterance, "en", undefined, { verified: true });
    await new TavilySearch("test", model, undefined, { postJson: async () => ({ results: [] }) })
      .search(new PublicTask({ goal: "공공기관 운영 시간" }), "ko", signal);
    const bodies = new Map<string, string>();
    for (const req of transport.calls) {
      const body = z.object({ messages: z.tuple([message, message]), response_format: z.object({ json_schema: z.object({ name: z.string() }) }) })
        .parse(await req.json());
      const [system, user] = body.messages;
      expect([system.role, user.role]).toEqual(["system", "user"]);
      expect(system.content).not.toMatch(demonstration);
      bodies.set(body.response_format.json_schema.name, user.content);
    }
    expect(new Set(bodies.keys())).toEqual(new Set(["chat_route", "intent_plan", "public_search_answer", "public_service_decision", "translate_in", "translate_out"]));
    expect(JSON.parse(bodies.get("public_service_decision") ?? "{}")).toMatchObject({ recent: history });
    for (const name of ["intent_plan", "chat_route"]) expect(JSON.parse(bodies.get(name) ?? "{}")).toMatchObject({ utterance, recent: [prior] });
  } finally { await pool.close(); }
});

it("test_live_startup_and_delegation_instructions", async () => {
  const transport = fakeFetch(() => Response.json({ session: { id: "test" }, transport: { sdp: "answer" } }, { status: 201 }));
  const live = new LiveProvider({ apiKey: "test", baseUrl: OPENAI_BASE_URL, edgeModel: STACK.voice }, { fetch: transport });
  await live.offer("v=0", { lang: "ko", state: "IDLE", recentVoiceDialogue: () => [] }, 1);
  const body: unknown = await transport.calls[0]?.json();
  const { session } = z.object({ session: z.looseObject({ instructions: z.string(), delegation: z.object({
    decisions: z.object({ questions: z.tuple([z.object({ instructions: z.string() })]) }),
  }) }) }).parse(body);
  expect(session).not.toHaveProperty("input");
  expect(session).toMatchObject({
    model: "gpt-live-1.1",
    audio: { output: { voice: "coral" } },
  });
  expect(session).not.toHaveProperty("audio.format");
  expect(session.instructions).not.toMatch(demonstration);
  expect(session.delegation.decisions.questions[0].instructions).not.toMatch(demonstration);
});

it.each([false, true])("test_browser_step_instructions", async official => {
  const schema = official ? "public_browse_step" : "browse_step";
  const model = new FakeLlm({ [schema]: { action: "fail", answer: "읽을 자료가 없습니다." } });
  const profile = createMockWelfareProfile("http://localhost:5174");
  const guard = new PolicyGuard({ allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [],
    secretFieldIds: [], maxActionsPerTurn: 12, readOnlyWeb: true });
  const web = new WebExecutionAgent({ async observe() { return { platform: "pc", url: profile.origin, title: "안내", fields: [], errors: [], dialogs: [], capturedAt: "",
    outline: { headings: [], notices: [], steps: [], buttons: [], links: [], mainLinks: [], mainText: "" } }; },
    async execute() { throw new Error("Unexpected action"); }, async close() {} },
    guard, profile);
  const ctx = new ExecContext({ signal: new AbortController().signal, isStopped: () => false, trace() {} });
  await new Autopilot(web, model, { searchUrl: q => q }).run("신청 절차를 알려줘", ctx, undefined, { requestedFacts: official ? ["procedure"] : [] });
  expect(model.calls).toHaveLength(1);
  expect(model.calls[0]?.schemaName).toBe(schema);
  expect(model.calls[0]?.system).not.toMatch(demonstration);
});
