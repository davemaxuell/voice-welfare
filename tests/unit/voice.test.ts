import { createServer, type Server } from "node:http";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createVoiceProviders, VOICE_DEFAULTS } from "../../src/voice/config.ts";
import { VoiceProviderError } from "../../src/voice/errors.ts";
import { HandshakeRejected, LiveTranscriber, SAMPLE_RATE, SocketClosed, connectSocket, type SocketConnect, type UpstreamSocket } from "../../src/voice/live.ts";
import { STT_PROMPT, audioExtension, isPromptEcho, isHallucination, OpenAISttProvider, sttPatterns } from "../../src/voice/stt.ts";
import { OpenAITtsProvider } from "../../src/voice/tts.ts";
import { fakeFetch } from "../helpers.ts";

const cfg = { apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "stt-model" };
const audio = new Uint8Array(500);
const ko = { language: "ko", mimeType: "audio/webm;codecs=opus" };
const en = { ...ko, language: "en" };
const ECHO = "정부24, 주민등록등본, 국민신문고, 민원, 한국장학재단, 국가장학금.";
function remote(replies: string[], model = cfg.model) {
  const fetcher = fakeFetch(() => Response.json({ text: replies.shift() ?? "" }));
  return { calls: fetcher.calls, stt: new OpenAISttProvider({ ...cfg, model, fetch: fetcher }) };
}

it("test_stt_sends_model_language_extension", async () => {
  const { stt, calls } = remote([" 다음으로 "]);
  expect(await stt.transcribe(audio, ko)).toEqual({ text: "다음으로" });
  const req = calls[0]!, form = await req.formData();
  expect(req.url).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(req.headers.get("authorization")).toBe("Bearer sk-test");
  expect([form.get("model"), form.get("language")]).toEqual(["stt-model", "ko"]);
  const part = form.get("file");
  expect(part instanceof File ? part.name : part).toBe("speech.webm");
});
it("test_stt_prompt_echo_retries_without_language", async () => {
  const { stt, calls } = remote([ECHO, "Korean please"]);
  expect(await stt.transcribe(audio, ko)).toEqual({ text: "Korean please" });
  const second = await calls[1]!.formData();
  expect([second.has("language"), second.has("prompt")]).toEqual([false, false]);
});
it("test_stt_echo_twice_returns_empty", async () => {
  expect(await remote([ECHO, ECHO]).stt.transcribe(audio, ko)).toEqual({ text: "" });
});
it("test_stt_no_korean_prompt_for_other_languages", async () => {
  const { stt, calls } = remote(["Open Naver"]);
  await stt.transcribe(audio, en);
  const form = await calls[0]!.formData();
  expect(form.get("language")).toBe("en");
  expect(form.has("prompt")).toBe(false);
});
it("gpt-transcribe gets languages and keywords instead of one language and a prompt", async () => {
  const { stt, calls } = remote(["다음으로"], "gpt-transcribe");
  await stt.transcribe(audio, { ...ko, language: "en" });
  const form = await calls[0]!.formData();
  expect(form.getAll("languages[]")).toEqual(["en", "ko", "zh", "ja"]);
  expect(form.getAll("keywords[]")).toEqual(["청음아", "정부24", "주민등록등본", "국민신문고", "민원", "한국장학재단", "국가장학금",
    "고용24", "홈택스", "복지로", "장애인연금", "다음으로", "이전으로", "멈춰"]);
  expect([form.has("language"), form.has("prompt")]).toEqual([false, false]);
  const korean = remote(["다음으로"], "other-model");
  await korean.stt.transcribe(audio, ko);
  expect((await korean.calls[0]!.formData()).get("prompt")).toBe(STT_PROMPT);
});
it("test_tts_body_and_mp3", async () => {
  const fetcher = fakeFetch(() => new Response(new Uint8Array([1, 2, 3])));
  const tts = new OpenAITtsProvider({ ...cfg, model: "tts-model", voice: "coral", instructions: "천천히", fetch: fetcher });
  expect(await tts.synthesize("안녕하세요", ko)).toEqual({ audio: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" });
  expect(await fetcher.calls[0]!.json()).toEqual({ model: "tts-model", voice: "coral", input: "안녕하세요", response_format: "mp3", instructions: "천천히" });
});
function speedOf(body: unknown) {
  return typeof body === "object" && body !== null && "speed" in body ? body.speed : undefined;
}
it("test_server_tts_follows_saved_pace", async () => {
  const fetcher = fakeFetch(() => new Response(new Uint8Array([1])));
  const tts = new OpenAITtsProvider({ ...cfg, model: "m", voice: "coral", speed: 1.1, fetch: fetcher });
  await tts.synthesize("안녕하세요", { language: "ko", pace: 0.9 / 1.25 });
  await tts.synthesize("안녕하세요", { language: "ko" });
  const [slow, normal] = await Promise.all(fetcher.calls.map(async call => speedOf(await call.json())));
  expect(slow).toBeCloseTo(1.1 * 0.72);
  expect(normal).toBeCloseTo(1.1);
});
it("test_provider_error_status_only", async () => {
  const fetcher = fakeFetch(() => new Response('{"error":"bad"}', { status: 401 }));
  await expect(new OpenAISttProvider({ ...cfg, fetch: fetcher }).transcribe(audio, ko)).rejects.toMatchObject({ status: 401, message: "voice provider error (HTTP 401)" });
  await expect(new OpenAITtsProvider({ ...cfg, voice: "coral", fetch: fetcher }).synthesize("음성", ko)).rejects.toBeInstanceOf(VoiceProviderError);
});
it("test_one_key_enables_both_api_providers", () => {
  expect(createVoiceProviders({}).map(p => p.supported)).toEqual([false, false]);
  expect(createVoiceProviders({ apiKey: "sk" }).map(p => p.supported)).toEqual([true, true]);
});
it("test_edge_selection_is_endpoint_and_key_specific", () => {
  const cases: Array<[{ apiKey?: string; liveModel?: string; baseUrl?: string }, string | undefined]> = [
    [{}, undefined], [{ apiKey: "dummy" }, "gpt-live-1.1"], [{ apiKey: "dummy", liveModel: "gpt-live-transcribe" }, undefined],
    [{ apiKey: "dummy", baseUrl: "https://custom.example/v1" }, undefined],
  ];
  for (const [config, expected] of cases) {
    const [stt] = createVoiceProviders(config);
    expect(stt.edgeModel).toBe(expected);
    if (config.apiKey !== undefined) expect([stt instanceof OpenAISttProvider ? stt.model : "", stt.live?.model]).toEqual(["gpt-transcribe", "gpt-live-transcribe"]);
  }
});
it("legacy local settings use only the authenticated API with the shared base URL", () => {
  const [stt, tts] = createVoiceProviders({ apiKey: "sk-test", baseUrl: "https://api.openai.com/v1/", sttModel: "gpt-live-transcribe" });
  expect(stt).toBeInstanceOf(OpenAISttProvider);
  expect([stt.baseUrl, tts.baseUrl, tts.speed]).toEqual([VOICE_DEFAULTS.baseUrl, VOICE_DEFAULTS.baseUrl, 1.35]);
  expect(stt instanceof OpenAISttProvider ? stt.model : "").toBe("gpt-transcribe");
  expect(() => new OpenAISttProvider({ ...cfg, apiKey: "" })).toThrow("받아쓰기 API 키가 필요합니다.");
  expect(() => new OpenAITtsProvider({ ...cfg, apiKey: "", voice: "coral" })).toThrow("음성 합성 API 키가 필요합니다.");
});
it("test_audio_extension", () => {
  // Python audio_extension으로 계산한 값
  const expected: Record<string, string> = { "audio/mp4": "mp4", "audio/ogg;codecs=opus": "ogg", "weird/type": "webm", "audio/x-m4a": "m4a",
    "audio/flac": "flac", "audio/aac": "aac", " audio/aac ; x": "aac", "AUDIO/AAC": "webm", "": "webm" };
  for (const [mime, extension] of Object.entries(expected)) expect(audioExtension(mime), mime).toBe(extension);
});
it("test_prompt_echo_detection", () => {
  expect(isPromptEcho("Government24, resident registration, civil complaint, student aid foundation, national scholarship, stop.")).toBe(true);
  expect(isPromptEcho(ECHO)).toBe(true);
  expect(isPromptEcho("주소는 부산광역시 예시구 예시로 10, 다음으로")).toBe(false);
  expect(isPromptEcho("English please")).toBe(false);
});
it("prompt echo matches Python on a table of mixed requests", () => {
  const expected: Record<string, boolean> = { "": false, [STT_PROMPT]: true,
    "정부24 홈택스 복지로 고용24 열고 국가장학금이랑 장애인연금 신청 방법도 비교해서 알려줘": false, "정부24 홈택스 복지로 고용24": true,
    "정부24 홈택스 복지로 고용24 열어": true, "정부24 홈택스 복지로 고용24 다 열어 줘요": true,
    "Government 24, hometax, bokjiro, employment24": true, "Government 24, hometax, bokjiro": false, "１２３": false, "123": false };
  for (const [text, echo] of Object.entries(expected)) expect(isPromptEcho(text), text).toBe(echo);
});
it("English hint patterns match Python, including İ, NBSP and fullwidth digits", () => {
  // Python PROMPT_TERMS_EN 각각의 search 결과
  const T = true, F = false;
  const expected: Record<string, boolean[]> = {
    "": [F, F, F, F, F, F, F, F], "Government24": [T, F, F, F, F, F, F, F], "government 24": [T, F, F, F, F, F, F, F],
    "GOVERNMENT  24": [T, F, F, F, F, F, F, F], "government​24": [F, F, F, F, F, F, F, F],
    "government\x1c24": [F, F, F, F, F, F, F, F], "government﻿24": [F, F, F, F, F, F, F, F], "employment ２４": [F, F, F, F, F, F, F, F],
    "employment24": [F, F, F, F, F, T, F, F], "HomeTax": [F, F, F, F, F, F, T, F], "HOMETAX": [F, F, F, F, F, F, T, F],
    "hometaх": [F, F, F, F, F, F, F, F], "bokjiro": [F, F, F, F, F, F, F, T], "BOKJİRO": [F, F, F, F, F, F, F, T],
    "bokjıro": [F, F, F, F, F, F, F, F], "boKjiro": [F, F, F, F, F, F, F, T], "reſident regiſtration": [F, T, F, F, F, F, F, F],
    "resident registration": [F, T, F, F, F, F, F, F], "RESIDENT REGISTRATION": [F, T, F, F, F, F, F, F], "resident  registration": [F, F, F, F, F, F, F, F],
    "civil petition": [F, F, T, F, F, F, F, F], "Civil Complaint": [F, F, T, F, F, F, F, F], "cİvİl petİtİon": [F, F, T, F, F, F, F, F],
    "civil  complaint": [F, F, F, F, F, F, F, F], "student aid foundation": [F, F, F, T, F, F, F, F], "natİonal scholarshİp": [F, F, F, F, T, F, F, F],
    "national scholarship": [F, F, F, F, T, F, F, F], "정부24": [F, F, F, F, F, F, F, F], "고용24 열어줘": [F, F, F, F, F, F, F, F],
  };
  for (const [text, row] of Object.entries(expected)) expect(sttPatterns.englishTerms.map(p => p.test(text)), JSON.stringify(text)).toEqual(row);
});
it("test_hallucination_keeps_real_utterances", () => {
  expect(["시청해주셔서 감사합니다", "감사합니다", "뉴스 읽어줘", "구독 서비스 알려줘"].map(isHallucination)).toEqual([true, false, false, false]);
  const expected: Record<string, boolean> = { "": false, "  시청 감사합니다.!": true, "MBC 뉴스 이덕영입니다.": true, "Thank you for watching": true,
    "thanks for watching!!": true, "다음 영상에서 만나요~": true, "구독과 좋아요 부탁드립니다": true, "자막 제공 및 광고": true,
    "１２３ 뉴스 김철수입니다": true, "가나다라마바사아자차카 뉴스 김철수입니다": false, "가나다라마바사아자차 뉴스 김철수입니다": true,
    "시청 감사합니다\n": true, "시청 감사합니다\n\n": true };
  for (const [text, made] of Object.entries(expected)) expect(isHallucination(text), JSON.stringify(text)).toBe(made);
});

function fakeUpstream(script: (sent: unknown) => string[]) {
  const inbox: string[] = [];
  const waiting: Array<(message: string) => void> = [];
  const sent: unknown[] = [];
  let closed = false;
  const push = (message: string) => { const waiter = waiting.shift(); if (waiter === undefined) inbox.push(message); else waiter(message); };
  const socket: UpstreamSocket = {
    send: async (message) => { const parsed: unknown = JSON.parse(message); sent.push(parsed); for (const reply of script(parsed)) push(reply); },
    recv: () => {
      const message = inbox.shift();
      if (message !== undefined) return Promise.resolve(message);
      return closed ? Promise.reject(new SocketClosed(1000)) : new Promise(resolve => { waiting.push(resolve); });
    },
    close: async () => { closed = true; },
    async *[Symbol.asyncIterator]() { for (;;) yield await socket.recv(); },
  };
  return { socket, sent, isClosed: () => closed };
}
function typed(value: unknown) {
  return typeof value === "object" && value !== null && "type" in value ? value.type : undefined;
}
async function* pcm(...sizes: number[]) { for (const size of sizes) yield new Uint8Array(size); }

it("live transcription opens the keyed realtime socket and returns the committed final", async () => {
  const upstream = fakeUpstream(message => {
    if (typed(message) === "session.update") return [JSON.stringify({ type: "session.created" }), JSON.stringify({ type: "session.updated" })];
    if (typed(message) === "input_audio_buffer.commit") return [JSON.stringify({ type: "input_audio_buffer.committed", item_id: "i1" }),
      JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: " 정부24 열어줘 " })];
    return [];
  });
  const seen: Array<[string, Record<string, string>, number | undefined]> = [];
  const connect: SocketConnect = async (url, options) => { seen.push([url, options.headers, options.maxSize]); return upstream.socket; };
  const live = new LiveTranscriber("https://api.openai.com/v1/", "sk-test", connect);
  expect(await live.transcribe(pcm(SAMPLE_RATE / 5), "en")).toBe("정부24 열어줘");
  expect(seen).toEqual([["wss://api.openai.com/v1/realtime?intent=transcription", { Authorization: "Bearer sk-test" }, 128_000]]);
  expect(upstream.sent.map(typed)).toEqual(["session.update", "input_audio_buffer.append", "input_audio_buffer.commit"]);
  expect(JSON.stringify(upstream.sent[0])).toContain('"languages":["en","ko","zh","ja"]');
  expect(upstream.isClosed()).toBe(true);
  expect(new LiveTranscriber("http://127.0.0.1:9/v1", "k", connect).url).toBe("ws://127.0.0.1:9/v1/realtime?intent=transcription");
});
it("live transcription drops short audio, silence phrases and maps provider errors", async () => {
  const ready = (message: unknown) => typed(message) === "session.update" ? [JSON.stringify({ type: "session.updated" })] : [];
  const short = fakeUpstream(ready);
  expect(await new LiveTranscriber("https://x/v1", "k", async () => short.socket).transcribe(pcm(100), "ko")).toBe("");
  expect(short.sent.map(typed)).toEqual(["session.update", "input_audio_buffer.append"]);
  const silence = fakeUpstream(message => typed(message) === "input_audio_buffer.commit"
    ? [JSON.stringify({ type: "input_audio_buffer.committed", item_id: "a" }),
      JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "시청해 주셔서 감사합니다." })]
    : ready(message));
  expect(await new LiveTranscriber("https://x/v1", "k", async () => silence.socket).transcribe(pcm(SAMPLE_RATE), "ko")).toBe("");
  const quota = fakeUpstream(() => [JSON.stringify({ type: "error", error: { code: "insufficient_quota" } })]);
  await expect(new LiveTranscriber("https://x/v1", "k", async () => quota.socket).transcribe(pcm(10), "ko")).rejects.toMatchObject({ status: 429 });
  const rejected: SocketConnect = async () => { throw new HandshakeRejected(401); };
  await expect(new LiveTranscriber("https://x/v1", "k", rejected).transcribe(pcm(10), "ko")).rejects.toMatchObject({ status: 401 });
});

async function listen(server: Server): Promise<number> {
  for (;;) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const bound = await new Promise<boolean>(resolve => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (bound) return port;
  }
}
it("the upstream socket sends the key, reports a rejected handshake and ends on a clean close", async () => {
  const server = createServer((_request, response) => { response.writeHead(401).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url === "/denied") { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return; }
    sockets.handleUpgrade(request, socket, head, client => {
      client.send(JSON.stringify({ auth: request.headers.authorization ?? null }));
      client.on("message", data => { client.send(String(data)); client.close(1000); });
    });
  });
  const port = await listen(server);
  try {
    const options = { headers: { Authorization: "Bearer sk-test" }, openTimeoutMs: 2000, closeTimeoutMs: 500 };
    await expect(connectSocket(`ws://127.0.0.1:${port}/denied`, options)).rejects.toMatchObject({ status: 401 });
    const upstream = await connectSocket(`ws://127.0.0.1:${port}/live`, options);
    expect(JSON.parse(await upstream.recv())).toEqual({ auth: "Bearer sk-test" });
    await upstream.send("echo");
    const rest: string[] = [];
    for await (const message of upstream) rest.push(message);
    expect(rest).toEqual(["echo"]);
    await expect(upstream.recv()).rejects.toBeInstanceOf(SocketClosed);
    await upstream.close();
  } finally {
    sockets.close();
    await new Promise(resolve => server.close(resolve));
  }
});
