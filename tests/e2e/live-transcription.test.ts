import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { LIVE_MODEL, LiveTranscriber } from "../../src/voice/live.ts";
import { redactText } from "../../src/safety/privacy.ts";
import type { SttProvider } from "../../src/voice/stt.ts";
import { apiFixture, serveFixture } from "./runtime-http-fixture.ts";

it("test_streams_before_commit_and_uses_only_the_matching_final", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let firstFrame = () => {};
  const first = new Promise<void>(resolve => { firstFrame = resolve; });
  let size = 0;
  const metadata: unknown[] = [];
  upstream.on("connection", (ws, req) => {
    metadata.push(req.url, req.headers.authorization);
    const send = (packet: object) => ws.send(JSON.stringify(packet));
    ws.on("message", raw => {
      const event = z.object({ type: z.string(), audio: z.string().optional(), session: z.unknown().optional() }).parse(JSON.parse(String(raw)));
      if (event.type === "session.update") {
        metadata.push(event.session);
        send({ type: "session.updated" });
      } else if (event.type === "input_audio_buffer.append") {
        size += Buffer.from(event.audio ?? "", "base64").length;
        firstFrame();
      } else if (event.type === "input_audio_buffer.commit") {
        send({ type: "input_audio_buffer.committed", item_id: "mine" });
        send({ type: "conversation.item.input_audio_transcription.delta", item_id: "mine", delta: "로그인해" });
        send({ type: "conversation.item.input_audio_transcription.completed", item_id: "other", transcript: "멈춰" });
        send({ type: "conversation.item.input_audio_transcription.completed", item_id: "mine", transcript: "국가장학금 서류 알려줘" });
      }
    });
  });
  await once(upstream, "listening");
  const addr = upstream.address();
  if (addr === null || typeof addr === "string") throw new Error("No TCP listener");
  try {
    async function* frames() { yield new Uint8Array(4800); await first; yield new Uint8Array(4800); }
    const live = new LiveTranscriber("http://127.0.0.1:" + addr.port + "/v1", "test-key");
    expect(await live.transcribe(frames(), "ko")).toBe("국가장학금 서류 알려줘");
    expect(size).toBe(9600);
    expect(metadata).toEqual(["/v1/realtime?intent=transcription", "Bearer test-key", expect.objectContaining({ audio: { input: {
      turn_detection: null, format: { type: "audio/pcm", rate: 24000 },
      transcription: expect.objectContaining({ model: LIVE_MODEL, keywords: expect.arrayContaining(["정부24"]), languages: expect.arrayContaining(["ko"]) }),
    } } })]);
  } finally { await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

it("test_live_receipt_requires_consent_preserves_privacy_and_is_consumed_once", async () => {
  let text = "등본 발급 방법";
  const stt: SttProvider = { name: "fake", supported: true, live: { model: "dummy", async transcribe(frames) {
    let size = 0;
    for await (const frame of frames) size += frame.length;
    expect(size).toBe(6000);
    return text;
  } }, async transcribe() { throw new Error("unexpected uploaded recording"); } };
  const { api, rt, post, close } = apiFixture({ REQUIRE_CONSENT: "true", PRACTICE_MODE: "false", HEADLESS: "false" }, { stt });
  const service = await serveFixture(api);
  try {
    const s = await rt.createSession(), other = await rt.createSession(); api.sessions.add(s); api.sessions.add(other);
    const turn = vi.spyOn(s, "handleTurn").mockImplementation(async text => s.fixedReply(redactText(text), "네", "ko"));
    const path = "/api/session/" + s.id + "/audio/live";
    const record = () => service.packet(path, { writer: "" }, new Uint8Array(6000), "commit");
    expect(await service.packet(path, { writer: "" })).toMatchObject({ error: "REQUEST_CONFLICT" });
    await s.consentTo(true); await other.consentTo(true);
    const ws = await service.connect(path); ws.send(JSON.stringify({ writer: "" })); ws.send(new Uint8Array(3000)); ws.close(); await once(ws, "close");
    const receipt = z.strictObject({ receipt: z.string() }).parse(await record());
    expect(JSON.stringify(receipt)).not.toContain("등본");
    expect(turn).not.toHaveBeenCalled();
    const audioTurn = (body: unknown, id = s.id, headers = {}) => post("/api/audio/turn?sessionId=" + id, body, headers);
    expect((await audioTurn(receipt, other.id)).status).toBe(409);
    const headers = { "x-cheongeum-request": "1" };
    const result = await audioTurn(receipt, s.id, headers);
    expect(result.status).toBe(200);
    expect(await (await audioTurn(receipt, s.id, headers)).json()).toEqual(await result.json());
    expect(turn).toHaveBeenCalledExactlyOnceWith("등본 발급 방법", { approvalId: "", fromVoice: true });
    expect((await audioTurn(receipt)).status).toBe(409);
    const expired = await record(); await s.cancel();
    expect((await audioTurn(expired)).status).toBe(409);
    const stop = () => record().then(body => post("/api/audio/stop?sessionId=" + s.id, body));
    expect(await (await stop()).json()).toEqual({ stopped: false });
    text = "멈춰"; expect(await (await stop()).json()).toMatchObject({ stopped: true });
    text = "응" + "!".repeat(499) + " 지우지 마세요";
    expect(await record()).toMatchObject({ error: "TRANSCRIPT_TOO_LONG" });
  } finally { await service.closeServer(); await close(); }
});
