import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { z } from "zod";
import { TurnResultSchema } from "../../src/core/turn.ts";
import { makeApp, JSON_LIMIT, AUDIO_LIMIT, MAX_SESSIONS } from "../../src/server/app.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { UnsupportedSttProvider, type SttProvider } from "../../src/voice/stt.ts";
import { UnsupportedTtsProvider, type TtsProvider } from "../../src/voice/tts.ts";
import { FakeLlm, Gate, step, testRuntimeEnv } from "../helpers.ts";

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

it("test_progress_endpoint_reports_code_built_steps", async () => {
  const id = await sessionId();
  const url = "/api/session/" + id + "/progress";
  expect(await (await app.request(url)).json()).toEqual({ running: false, seq: 0, latest: null, spoken: true });
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
  expect((await disabled.request("/api/audio/transcribe", { method: "POST" })).status).toBe(501);
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
  const transcription = await app.request("/api/audio/transcribe", {
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

it("test_blank_audio_content_type_is_read_as_webm", async () => {
  heard = "다음으로";
  const res = await app.request("/api/audio/transcribe", {
    method: "POST",
    body: new Uint8Array(1000),
    headers: { "content-type": "" },
  });
  expect(await res.json()).toMatchObject({ text: "다음으로" });
});

it("bounds audio and JSON bodies and counts supplementary characters as one", async () => {
  expect((await post("/api/turn", { sessionId: "nope", text: "😀".repeat(500) })).status).toBe(404);
  expect((await post("/api/turn", { sessionId: "nope", text: "😀".repeat(501) })).status).toBe(400);
  expect((await post("/api/turn", { sessionId: "nope", text: "안녕", extra: "x".repeat(JSON_LIMIT) })).status).toBe(
    400,
  );
  for (const count of [199, AUDIO_LIMIT + 1]) {
    const res = await app.request("/api/audio/transcribe", {
      method: "POST",
      body: new Uint8Array(count),
      headers: { "content-type": "audio/wav" },
    });
    expect(await res.json()).toEqual({ text: "", provider: "fake", secretDetected: false });
  }
  expect(calls).toEqual([]);
});

it("evicts the oldest sessions even when creation requests overlap", async () => {
  const ids = await Promise.all(Array.from({ length: MAX_SESSIONS + 1 }, sessionId));
  expect(app.sessions.size).toBe(MAX_SESSIONS);
  expect((await app.request("/api/session/" + ids[0] + "/state")).status).toBe(404);
  for (const id of ids.slice(1)) expect((await app.request("/api/session/" + id + "/state")).status).toBe(200);
  expect(await (await app.request("/api/session/" + ids[1], { method: "DELETE" })).json()).toEqual({ ok: true });
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
    expect(response.status).toBe(200);
    const turn = TurnResultSchema.parse(await response.json());
    expect(turn.intentType).toBe("SECRET_DISCLOSURE");
    expect(turn.userUtterance).toContain("[비공개]");
    expect(turn.userUtterance).not.toContain("900");
    expect(JSON.stringify(app.sessions.get(id)?.exportHistory().map(row => row.text))).not.toContain("900");
  }
});
