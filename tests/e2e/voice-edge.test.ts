import { ReadableStream } from "node:stream/web";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { AuthHandoff } from "../../src/core/dialogue.ts";
import { LiveProvider, VoiceEdge, type EdgeSession } from "../../src/server/voice_edge.ts";
import { createVoiceProviders } from "../../src/voice/config.ts";
import { FakeLlm, withLlm } from "../helpers.ts";
import { apiFixture, serveFixture } from "./runtime-http-fixture.ts";

it("test_conversation_route_owns_sdp_consent_writer_and_auth_handoff", async () => {
  const [stt, tts] = createVoiceProviders({ apiKey: "dummy" });
  const offer = vi.fn(async () => ["live_1", "answer-test"] as const);
  const sent: unknown[] = [];
  const stream = new ReadableStream<string>();
  const attached = vi.fn(async () => ({
    [Symbol.asyncIterator]: () => stream.values(), async send(text: string) { sent.push(JSON.parse(text)); },
    async recv() { return ""; }, async close() {},
  }));
  const edge = new VoiceEdge({ provider: () => ({ offer, attach: attached }) });
  const { rt, api, close } = apiFixture({ REQUIRE_CONSENT: "true", PRACTICE_MODE: "false", HEADLESS: "false" }, { stt, tts, voiceEdge: edge });
  const service = await serveFixture(api);
  try {
    const s = await rt.createSession(); api.sessions.add(s);
    const lease = api.sessions.enable(s.id);
    const call = (writer: string) => service.packet("/api/session/" + s.id + "/audio/conversation", { sdp: "v=0", writer });
    const writer = lease.writer ?? "";
    expect(await call(writer)).toMatchObject({ error: "REQUEST_CONFLICT" });
    await s.consentTo(true);
    expect(await call("wrong-writer")).toMatchObject({ error: "REQUEST_CONFLICT" });
    s.dialogue.holdAuth(undefined, new AuthHandoff({ id: "h", sessionId: s.id, taskId: "t", browser: null, expectedOrigin: "", expectedPath: "",
      deadline: 100, kind: "login", site: "local" }));
    expect(await call(writer)).toMatchObject({ error: "REQUEST_CONFLICT" });
    expect(offer).not.toHaveBeenCalled();
    s.dialogue.finishAuth("cancelled");
    expect(await call(writer)).toEqual({ sdp: "answer-test" });
    expect(offer).toHaveBeenCalledTimes(1); expect(attached).toHaveBeenCalledWith("live_1");
    await expect.poll(() => sent.at(-1)).toMatchObject({ type: "session.close" });
  } finally { await service.closeServer(); await close(); }
});

it("test_live_offer_seeds_recent_redacted_app_dialogue", async () => {
  const { rt, api, close } = apiFixture();
  const [stt] = createVoiceProviders({ apiKey: "dummy" });
  let body: unknown;
  const provider = new LiveProvider(stt, { fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ session: { id: "live_test" }, transport: { sdp: "answer-test" } }, { status: 201 });
  } });
  try {
    const s = await rt.createSession(); api.sessions.add(s); await provider.offer("v=0", s, 1.35);
    const first = z.object({ session: z.looseObject({ delegation: z.object({ type: z.string(), decisions: z.object({
      questions: z.array(z.object({ name: z.string(), choices: z.array(z.object({ value: z.string() })) })),
    }) }) }) }).parse(body).session;
    expect(first).not.toHaveProperty("input"); expect(first).not.toHaveProperty("triggers"); expect(first.delegation.type).toBe("decisions");
    expect(first).toMatchObject({ model: "gpt-live-1.1", audio: { output: { voice: "coral" } } });
    expect(first).not.toHaveProperty("audio.format");
    expect(first.delegation.decisions.questions).toHaveLength(1); expect(first.delegation.decisions.questions[0]?.name).toBe("sol_effort");
    expect(first.delegation.decisions.questions[0]?.choices.map(item => item.value)).toEqual(["low", "medium", "high"]);
    await s.handleTurn("도움말 알려줘"); const kept = await s.handleTurn("청음");
    for (let i = 0; i < 30; i++) await s.handleTurn("청음");
    s.rememberCallName("테스트이름"); await s.handleTurn("테스트이름의 이메일은 contact@example.test");
    await provider.offer("v=0", s, 1.35);
    const schema = z.object({ session: z.object({ input: z.array(z.object({ role: z.string(), content: z.array(z.object({ type: z.string(), text: z.string() })) })) }) });
    const history = schema.parse(body).session.input;
    expect(history.map(row => row.role)).toEqual(Array.from({ length: 32 }, () => ["user", "assistant"]).flat());
    expect(history[0]?.content).toEqual([{ type: "input_text", text: "청음" }]);
    expect(history[1]?.content).toEqual([{ type: "output_text", text: kept.speech }]);
    for (const secret of ["도움말 알려줘", "테스트이름", "contact@example.test"]) expect(JSON.stringify(history)).not.toContain(secret);
    expect(history.at(-2)?.content[0]?.text).toBe("[비공개]의 이메일은 [비공개]");
    await s.handleTurn("내 이름은 별구름이라고 저장해줘"); await s.handleTurn("아니"); await provider.offer("v=0", s, 1.35);
    expect(JSON.stringify(schema.parse(body).session.input)).not.toContain("별구름");
  } finally { await close(); }
});

it("test_live_history_keeps_the_newest_turns_within_the_size_limit", async () => {
  const { rt, api, close } = apiFixture();
  try {
    const s = await rt.createSession(); api.sessions.add(s);
    for (let i = 0; i < 12; ++i) await s.handleTurn("테스트 기록 " + i + " " + "글".repeat(300));
    const history = s.recentVoiceDialogue();
    expect(history.reduce((sum, message) => sum + Buffer.byteLength(message.text), 0)).toBeLessThanOrEqual(6400);
    expect(history.at(-2)).toMatchObject({ role: "user", text: expect.stringMatching(/^테스트 기록 11 /u) });
    expect(history.some(message => message.text.startsWith("테스트 기록 0 "))).toBe(false);
    const prefix = "나".repeat(265) + "aa";
    await s.handleTurn(prefix + "🍊");
    expect(s.recentVoiceDialogue().at(-2)?.text).toBe(prefix);
  } finally { await close(); }
});

function monitorSession(session: EdgeSession, action = "") {
  let feed = (_event: object) => {};
  const stream = new ReadableStream<string>({ start(controller) { feed = e => controller.enqueue(JSON.stringify(e)); } });
  const sent: unknown[] = [], packets: unknown[] = [];
  const monitor = new VoiceEdge().monitor({ [Symbol.asyncIterator]: () => stream.values(), async send(raw) { sent.push(JSON.parse(raw)); } },
    { async sendJson(value) { packets.push(value); }, receive: () => new Promise(() => {}) }, session, () => {}, action);
  function utter(text: string, start: number, end: number, delegate: string) {
    feed({ type: "session.input_transcript.delta", delta: text, start_ms: start, end_ms: end, event_id: "input-" + start });
    feed({ type: "session.delegation.created", offset_ms: end + 10, delegation: { id: delegate, target: "client" } });
  }
  async function result(index: number) {
    await expect.poll(() => packets.length, { timeout: 7000 }).toBeGreaterThan(index);
    return z.object({ exact: z.boolean(), result: z.looseObject({ speech: z.string() }) }).parse(packets[index]);
  }
  return { sent, feed, utter, result, async close() { feed({ type: "session.closed" }); await monitor; } };
}

it("a delegated lookup receives the preceding Live comparison with split private text redacted", async () => {
  const { rt, api, close } = apiFixture();
  const s = await rt.createSession(); api.sessions.add(s);
  const model = new FakeLlm({ public_service_decision: {
    kind: "clarify", agency: null, source: "browser", subject: null, goal: null, requestedFacts: [], exclusions: [],
    continuation: false, question: "어느 기관에서 찾아볼까요?", choices: [],
  } });
  withLlm(s, model);
  s.rememberCallName("별구름");
  const run = monitorSession(s);
  try {
    const say = (role: string, delta: string, start_ms: number, end_ms: number) =>
      run.feed({ type: `session.${role}_transcript.delta`, event_id: role + start_ms, delta, start_ms, end_ms });
    say("input", "별구", 0, 60);
    say("input", "름에게 student aid 두 종류를 비교해줘", 60, 270);
    say("output", "첫째는 국가장학금, ", 350, 550);
    say("output", "둘째는 학자금 대출이에요.", 580, 890);
    const follow = "두 번째 건 어디에서 신청해요?";
    run.utter(follow, 1100, 1700, "lookup");
    await run.result(0);
    const request = model.calls.find(call => call.schemaName === "public_service_decision");
    expect(JSON.parse(request?.user ?? "{}")).toMatchObject({ utterance: follow, dialogue: [{
      user: "[비공개]에게 student aid 두 종류를 비교해줘", assistant: "첫째는 국가장학금, 둘째는 학자금 대출이에요.",
    }] });
    expect(request?.user).not.toContain("별구름");
  } finally { await run.close(); await close(); }
});

it("test_private_readback_reaches_the_device_without_live_commentary", async () => {
  const { rt, api, close } = apiFixture(); const s = await rt.createSession(); api.sessions.add(s);
  const run = monitorSession(s);
  try {
    await s.handleTurn("내 이름은 별구름이라고 저장해줘"); await s.handleTurn("응");
    run.utter("내 정보 알려줘", 50, 460, "read"); const reply = await run.result(0);
    expect(reply.result.speech).toContain("별구름"); expect(reply.exact).toBe(true);
    expect(JSON.stringify(run.sent)).not.toContain("별구름");
  } finally { await run.close(); await close(); }
});
it("test_live_vault_consent_uses_the_card_known_at_connection_start", async () => {
  const { rt, api, close } = apiFixture(); const s = await rt.createSession(); api.sessions.add(s);
  try {
    const id = (await s.handleTurn("내 이름은 박하늘이라고 저장해줘")).pendingConfirmation?.actionId;
    if (id === undefined) throw new Error("Missing vault approval");
    async function reply(action: string) {
      const run = monitorSession(s, action);
      try { run.utter("응", 100, 500, "vault-reply"); return (await run.result(0)).result; }
      finally { await run.close(); }
    }
    expect(await reply("earlier-card")).toMatchObject({ pendingConfirmation: { actionId: id } });
    expect(s.personal.vault()).toEqual({});
    expect(await reply(id)).not.toHaveProperty("pendingConfirmation");
    expect(s.personal.vault()).toEqual({ name: "박하늘" });
  } finally { await close(); }
});
it("test_live_link_reply_belongs_to_the_offer_heard_before_speaking", async () => {
  const { rt, api, close } = apiFixture(); const s = await rt.createSession(); api.sessions.add(s);
  const run = monitorSession(s), open = s.web.openSite.bind(s.web);
  let started = false, release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(s.web, "openSite").mockImplementation(async (url, ctx) => { started = true; await gate; return await open(url, ctx); });
  try {
    run.utter("푸른마을자료관 홈페이지 열어줘", 100, 800, "search");
    await expect.poll(() => started, { timeout: 5000 }).toBe(true);
    run.utter("네", 6000, 6100, "early");
    await expect.poll(() => run.sent).toContainEqual(expect.objectContaining({ type: "session.thinking.append", delegation_id: "early" }));
    release(); const first = await run.result(0); const early = await run.result(1);
    expect(first.result).toMatchObject({ observation: { url: s.web.adapter.page?.url() } }); expect(early.result.actions).toEqual([]);
    run.utter("첫 번째 결과 열어줘", 12000, 12400, "pick"); await run.result(2);
    expect(s.web.adapter.page?.url()).toContain("/external2.html?");
  } finally { release(); await run.close(); await close(); }
});
