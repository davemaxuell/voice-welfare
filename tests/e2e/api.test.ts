import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { z } from "zod";
import { TurnResultSchema } from "../../src/core/turn.ts";
import { makeApp, JSON_LIMIT, AUDIO_LIMIT, MAX_SESSIONS } from "../../src/server/app.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { UnsupportedSttProvider, type SttProvider } from "../../src/voice/stt.ts";
import { UnsupportedTtsProvider, type TtsProvider } from "../../src/voice/tts.ts";
import { FakeLlm, Gate, PORTAL, step, testRuntimeEnv } from "../helpers.ts";
import { Approval } from "./runtime-http-fixture.ts";

const result = z.object({ state: z.string(), speech: z.string(), intentType: z.string() }).passthrough();
const stt: SttProvider = {
  name: "fake",
  supported: true,
  async transcribe(_audio, options) {
    calls.push(options.language);
    return { text: heard };
  },
};
const tts: TtsProvider = {
  name: "fake",
  supported: true,
  async synthesize(text) {
    return { audio: new TextEncoder().encode(text), mimeType: "audio/mpeg" };
  },
};
let heard = "";
const calls: string[] = [];
let runtime: AgentRuntime;
let app: ReturnType<typeof makeApp<Awaited<ReturnType<AgentRuntime["createSession"]>>>>;
beforeAll(() => {
  runtime = new AgentRuntime(loadConfig(testRuntimeEnv()), new UnsupportedSttProvider(), new UnsupportedTtsProvider());
});
beforeEach(() => {
  app = makeApp(runtime, { stt, tts });
  heard = "";
  calls.length = 0;
});
afterEach(async () => {
  await app.sessions.close();
});
afterAll(async () => {
  await runtime.close();
});

async function post(path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}
async function sessionId() {
  const response = await post("/api/session");
  expect(response.status).toBe(200);
  return z.object({ sessionId: z.string() }).parse(await response.json()).sessionId;
}
function say(id: string, text: string, busy = false) {
  heard = text;
  return app.request("/api/audio/" + (busy ? "stop" : "turn") + "?sessionId=" + id, {
    method: "POST",
    body: new Uint8Array(1000),
    headers: { "content-type": "audio/webm" },
  });
}

it("test_session_turn_state_cancel", async () => {
  const id = await sessionId();
  const response = await post("/api/turn", { sessionId: id, text: "장애인연금 신청 도와줘" });
  expect(response.status).toBe(200);
  expect(TurnResultSchema.parse(await response.json()).state).toBe("APPLICATION_OPEN");
  expect(result.parse(await (await post("/api/session/" + id + "/confirm", { approve: true })).json()).state).toBe(
    "APPLICATION_OPEN",
  );
  await post("/api/turn", { sessionId: id, text: "비밀번호는 987654야" });
  expect(await (await app.request("/api/session/" + id + "/state")).text()).not.toContain("987654");
  expect(result.parse(await (await post("/api/session/" + id + "/cancel")).json()).state).toBe("STOPPED");
});

it("test_vault_replies_require_the_presented_id_across_inputs", async () => {
  const sid = await sessionId();
  const turn = async (text: string, extra = {}) => (await post("/api/turn", { sessionId: sid, text, ...extra })).json();
  const save = Approval.parse(await turn("내 이름은 박하늘이라고 저장해줘")).pendingConfirmation;
  expect(save.kind).toBe("vault-save"); expect(JSON.stringify(save)).not.toContain("박하늘");
  expect(Approval.parse(await turn("응")).pendingConfirmation.actionId).toBe(save.actionId);
  await turn("응", { actionId: save.actionId });
  const clear = Approval.parse(await turn("내 정보 지워줘")).pendingConfirmation;
  expect(clear.kind).toBe("vault-clear"); expect(clear.actionId).not.toBe(save.actionId);
  const audio = (text: string, id: string) => {
    heard = text;
    return app.request("/api/audio/turn?sessionId=" + sid, { method: "POST", body: new Uint8Array(1000),
      headers: { "content-type": "audio/webm", ...(id === "" ? {} : { "x-cheongeum-action": id }) } });
  };
  const long = await audio("응" + "!".repeat(499) + " 지우지 마세요", clear.actionId);
  expect(long.status).toBe(422); expect(await long.json()).toMatchObject({ error: "TRANSCRIPT_TOO_LONG" });
  for (const id of ["", save.actionId]) expect(Approval.parse(await (await audio("응", id)).json()).pendingConfirmation.actionId).toBe(clear.actionId);
  const confirm = async (actionId: string) => (await post("/api/session/" + sid + "/confirm", { approve: true, actionId })).json();
  expect(Approval.parse(await confirm(save.actionId)).pendingConfirmation.actionId).toBe(clear.actionId);
  expect(await confirm(clear.actionId)).toMatchObject({ intentType: "VAULT_CONFIRM" });
  expect(result.parse(await turn("내 정보 알려줘")).speech).toContain("저장된 정보가 없어요");
});
it("test_wake_accepts_only_current_stop_and_does_not_replay_a_task", async () => {
  const id = await sessionId(), path = "/api/session/" + id;
  const turn = async (text: string) => (await post("/api/turn", { sessionId: id, text })).json();
  await turn(PORTAL + " 열어줘");
  const { actionId } = Approval.parse(await turn("이름 칸에 김하늘 써줘")).pendingConfirmation;
  const token = z.object({ stopGeneration: z.number() }).parse(await turn("멈춰"));
  expect(await turn("다음으로")).toMatchObject({ state: "STOPPED" });
  const snapshot = async () => (await app.request(path + "/state")).json();
  const before = z.object({ observation: z.unknown(), history: z.unknown(), stopGeneration: z.number() }).parse(await snapshot());
  expect(before.stopGeneration).toBe(token.stopGeneration);
  for (const bad of [{}, { stopGeneration: true }, { stopGeneration: -1 }]) expect((await post(path + "/wake", bad)).status).toBe(400);
  const retry = () => app.request(path + "/wake", { method: "POST", headers: { "content-type": "application/json", "x-cheongeum-request": "1" }, body: JSON.stringify(token) });
  expect(await (await retry()).json()).toEqual({ state: "IDLE" }); expect(await (await post(path + "/wake", token)).json()).toEqual({ state: "IDLE" });
  const after: unknown = await snapshot();
  expect(after).not.toHaveProperty("stopGeneration"); expect(after).not.toHaveProperty("pendingConfirmation");
  expect(after).toMatchObject({ observation: before.observation, history: before.history });
  expect(await (await post(path + "/confirm", { approve: true, actionId })).json()).toMatchObject({ actions: [] });
  expect(await turn("화면 설명해줘")).toMatchObject({ semanticAction: "describe-screen" });
  const later = z.object({ stopGeneration: z.number() }).parse(await (await post(path + "/cancel")).json());
  expect(later.stopGeneration).toBeGreaterThan(token.stopGeneration);
  expect((await retry()).status).toBe(409); expect(await snapshot()).toMatchObject({ state: "STOPPED" });
});
it("test_stop_supersedes_a_wake_waiting_on_the_session_lock", async () => {
  const id = await sessionId(), s = app.sessions.get(id);
  if (s === undefined) throw new Error("Missing session");
  s.cancel(); const waiting = s.wake(s.generation);
  s.cancel(); expect(await waiting).toBeUndefined(); expect(s.state).toBe("STOPPED");
  expect(await s.wake(s.generation)).toBe("IDLE");
});

it("test_progress_endpoint_reports_code_built_steps", async () => {
  const id = await sessionId();
  const url = "/api/session/" + id + "/progress";
  expect(await (await app.request(url)).json()).toEqual({ running: false, seq: 0, latest: null, spoken: true, activity: null, activitySpoken: false });
  const gate = new Gate(
    [
      step("open_url", "http://127.0.0.1:5174/external.html"),
      step("click", "장애인연금 안내"),
      step("answer", null, "안내 기사예요.", ["두 번째 페이지입니다"]),
    ],
    3,
  );
  const session = app.sessions.get(id);
  if (session === undefined) throw new Error("Missing test session");
  session.deps.llm = gate;
  const pending = post("/api/turn", {
    sessionId: id,
    text: "127.0.0.1:5174/external.html에서 장애인연금 안내 기사 내용 알려줘",
  });
  try {
    await Promise.race([
      gate.reached,
      pending.then(() => {
        throw new Error("Turn finished before reaching its progress checkpoint");
      }),
    ]);
    expect(await (await app.request(url)).json()).toEqual({
      running: true,
      seq: 2,
      latest: "127.0.0.1에서 '장애인연금 안내'를 눌렀어요.",
      spoken: true,
    });
  } finally {
    gate.release();
    await pending;
  }
  expect(await (await app.request(url)).json()).toMatchObject({ running: false });
  expect((await app.request("/api/session/nope/progress")).status).toBe(404);
});

it("test_bad_requests_and_unsupported_voice", async () => {
  expect((await post("/api/turn", { sessionId: "x" })).status).toBe(400);
  expect((await post("/api/turn", { sessionId: "nope", text: "안녕" })).status).toBe(404);
  const disabled = makeApp(runtime);
  expect((await disabled.request("/api/audio/transcribe", { method: "POST" })).status).toBe(415);
  const recording = () => ({ method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(1000) });
  expect((await disabled.request("/api/audio/transcribe", recording())).status).toBe(404);
  const { sessionId: sid } = z.object({ sessionId: z.string() }).parse(await (await disabled.request("/api/session", { method: "POST" })).json());
  try { expect((await disabled.request("/api/audio/transcribe?sessionId=" + sid, recording())).status).toBe(501); }
  finally { await disabled.sessions.close(); }
  const services = z
    .object({ mode: z.string(), services: z.array(z.object({ source: z.object({ url: z.string() }) })) })
    .parse(await (await app.request("/api/welfare/services?q=" + encodeURIComponent("장애인연금"))).json());
  expect(services.mode).toBe("fixture");
  expect(services.services[0]?.source.url.startsWith("https://")).toBe(true);
});

it("test_voice_turn_reaches_screen", async () => {
  const id = await sessionId();
  expect(result.parse(await (await say(id, "장애인연금 신청 도와줘")).json()).state).toBe("APPLICATION_OPEN");
  expect(await (await say(id, "이름은 김하늘")).json()).toMatchObject({ field: "applicantName", value: "김하늘" });
});

it("test_while_busy_only_a_stop_word_is_acted_on", async () => {
  const id = await sessionId();
  expect((await say(id, "장애인연금 신청 도와줘")).status).toBe(200);
  const ignored = await say(id, "이름은 김하늘", true);
  expect(ignored.status).toBe(200);
  expect(await ignored.json()).toEqual({ stopped: false });
  const state = await (await app.request("/api/session/" + id + "/state")).text();
  expect(JSON.parse(state)).toMatchObject({ state: "APPLICATION_OPEN" });
  expect(state).not.toContain("김하늘");
  const stopped = await say(id, "멈춰", true);
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({ stopped: true, result: { state: "STOPPED" } });
});

it("test_while_busy_a_progress_question_is_answered", async () => {
  const id = await sessionId();
  expect(await (await say(id, "청음아, 지금 어디까지 했어?", true)).json()).toMatchObject({
    stopped: false,
    result: { intentType: "PROGRESS", speech: "지금 하고 있는 일은 없어요." },
  });
});

it("test_spoken_password_never_returned", async () => {
  const id = await sessionId();
  const res = await say(id, "비밀번호는 556677이야");
  const body = await res.text();
  expect(result.parse(JSON.parse(body)).state).toBe("AUTH_HANDOFF");
  expect(body).not.toContain("556677");
  expect(await (await app.request("/api/session/" + id + "/state")).text()).not.toContain("556677");
  heard = "주민번호 900101-1234567";
  const clean = await sessionId();
  const transcription = await app.request("/api/audio/transcribe?sessionId=" + clean, {
    method: "POST",
    body: new Uint8Array(1000),
    headers: { "content-type": "audio/webm" },
  });
  const safe = z.object({ secretDetected: z.boolean(), text: z.string() }).parse(await transcription.json());
  expect(safe.secretDetected).toBe(true);
  expect(safe.text).not.toContain("1234567");
});

it("test_empty_transcript_tts_health", async () => {
  const id = await sessionId();
  expect((await say(id, "")).status).toBe(422);
  const response = await post("/api/audio/speak", { text: "안녕하세요" });
  expect(response.headers.get("content-type")).toContain("audio/mpeg");
  expect(await response.text()).toBe("안녕하세요");
  expect(await (await app.request("/api/health")).json()).toMatchObject({
    stt: { provider: "fake", supported: true, localLanguages: [] },
  });
});

it("refuses an unlabeled recording before transcription", async () => {
  const id = await sessionId();
  const res = await app.request("/api/audio/transcribe?sessionId=" + id, { method: "POST", body: new Uint8Array(1000) });
  expect(res.status).toBe(415);
  expect(calls).toEqual([]);
});

it("bounds audio and JSON bodies and counts supplementary characters as one", async () => {
  expect((await post("/api/turn", { sessionId: "nope", text: "😀".repeat(500) })).status).toBe(404);
  expect((await post("/api/turn", { sessionId: "nope", text: "😀".repeat(501) })).status).toBe(400);
  expect((await post("/api/turn", { sessionId: "nope", text: "안녕", extra: "x".repeat(JSON_LIMIT) })).status).toBe(
    400,
  );
  const id = await sessionId();
  for (const [count, status] of [[199, 422], [AUDIO_LIMIT + 1, 413]] as const) {
    const res = await app.request("/api/audio/transcribe?sessionId=" + id, {
      method: "POST", body: new Uint8Array(count), headers: { "content-type": "audio/wav" },
    });
    expect(res.status).toBe(status);
  }
  expect(calls).toEqual([]);
});

it("preserves existing sessions when concurrent creates exceed capacity", async () => {
  const responses = await Promise.all(Array.from({ length: MAX_SESSIONS + 1 }, () => post("/api/session")));
  expect(responses.map(r => r.status).sort((a, b) => a - b)).toEqual([200, 200, 200, 409]);
  expect(app.sessions.size).toBe(MAX_SESSIONS);
  for (const s of app.sessions.values()) expect((await app.request("/api/session/" + s.id + "/state")).status).toBe(200);
});

it("keeps audio on the client until consent, then uses the selected conversation language", async () => {
  const restricted = new AgentRuntime(loadConfig(testRuntimeEnv({ REQUIRE_CONSENT: "true" })), stt, tts);
  app = makeApp(restricted);
  try {
    const id = await sessionId();
    const base = "/api/session/" + id;
    expect(await (await app.request(base + "/reminders")).json()).toEqual({ text: null });
    expect((await say(id, "시작")).status).toBe(403);
    expect((await say(id, "멈춰", true)).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await post(base + "/consent", { granted: "yes" })).status).toBe(400);
    expect((await post(base + "/consent", { granted: true })).status).toBe(200);
    expect((await post(base + "/language", { lang: "de" })).status).toBe(400);
    const session = app.sessions.get(id);
    if (session === undefined) throw new Error("Missing test session");
    session.deps.llm = new FakeLlm();
    expect((await post(base + "/language", { lang: "en" })).status).toBe(200);
    await say(id, "", true);
    expect(calls).toEqual(["en"]);
    expect(await (await app.request("/api/events")).json()).toHaveProperty("events");
    expect((await app.request(base, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(base + "/state")).status).toBe(404);
  } finally {
    await app.sessions.close();
    await restricted.close();
  }
});

it("긴 음성의 500번째 글자에 걸친 주민번호도 전부 가린다", async () => {
  const id = await sessionId();
  for (const prefix of ["가".repeat(497), "😀".repeat(497), "  " + "가".repeat(495)]) {
    const response = await say(id, prefix + "900101-1234567");
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "TRANSCRIPT_TOO_LONG" });
    expect(JSON.stringify(app.sessions.get(id)?.exportHistory().map(row => row.text))).not.toContain("900");
  }
});
