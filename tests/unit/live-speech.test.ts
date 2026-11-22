import { expect, it } from "vitest";
import { SocketClosed, type SocketConnect, type UpstreamSocket } from "../../src/voice/live.ts";
import { LiveSpeechProvider } from "../../src/voice/live_speech.ts";
import { createVoiceProviders } from "../../src/voice/config.ts";

interface ScriptedMessage {
  type?: string;
  content?: string;
  delegation_id?: string | null;
  session?: unknown;
  [key: string]: unknown;
}

function scripted(script: (message: ScriptedMessage) => unknown[]) {
  const inbox: string[] = [];
  const waiting: Array<(message: string) => void> = [];
  const sent: ScriptedMessage[] = [];
  const seen: Array<[string, Record<string, string>]> = [];
  let closed = false;
  const push = (message: string) => {
    const waiter = waiting.shift();
    if (waiter === undefined) inbox.push(message);
    else waiter(message);
  };
  const socket: UpstreamSocket = {
    send: async (message) => {
      const parsed: unknown = JSON.parse(message);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("live event is not an object");
      const record = parsed as ScriptedMessage;
      sent.push(record);
      for (const reply of script(record)) push(JSON.stringify(reply));
    },
    recv: () => {
      const message = inbox.shift();
      if (message !== undefined) return Promise.resolve(message);
      return closed ? Promise.reject(new SocketClosed(1000)) : new Promise(resolve => { waiting.push(resolve); });
    },
    close: async () => { closed = true; },
    async *[Symbol.asyncIterator]() { for (;;) yield await socket.recv(); },
  };
  const connect: SocketConnect = async (url, options) => {
    seen.push([url, options.headers]);
    return socket;
  };
  return { connect, sent, seen, isClosed: () => closed };
}

it("selects GPT Live for read-aloud and conversation even with legacy model settings", () => {
  const [input, reader] = createVoiceProviders({ apiKey: "test", ttsModel: "gpt-4o-mini-tts", liveModel: "old-voice-model" });
  expect(reader).toBeInstanceOf(LiveSpeechProvider);
  expect(reader.name).toBe("gpt-live-1.1(coral)");
  expect(input.edgeModel).toBe("gpt-live-1.1");
  expect(createVoiceProviders({ apiKey: "custom-server-key", baseUrl: "https://voice.example.org/v1" })[1].supported).toBe(false);
});

const quiet = Buffer.alloc(24_000 * 2 * 2);
const voiced = Buffer.alloc(4_800, 16);
function delta(data: Buffer) { return { type: "session.output_audio.delta", delta: data.toString("base64") }; }
const started = { type: "session.started" };
function speechEvents(transcript: string) {
  return [delta(quiet), delta(voiced), { type: "session.output_transcript.delta", delta: transcript }, delta(quiet)];
}

it("seeds the exact wording, clocks the socket with silence, and returns verified speech without the silent lead-in", async () => {
  const upstream = scripted(event => event.type === "session.start" ? [started] :
    event.type === "session.input_audio.append" ? speechEvents("안녕하세요.") : []);
  const [, reader] = createVoiceProviders({apiKey: "test", ttsSpeed: 1.1, ttsInstructions: "Warm voice."}, () => {
    throw new Error("Unexpected HTTP speech request");
  }, upstream.connect);
  const result = await reader.synthesize("안녕하세요!", {language: "ko", pace: 0.72});
  expect(upstream.seen[0]).toEqual(["wss://api.openai.com/v1/live/sessions", {Authorization: "Bearer test"}]);
  expect(upstream.sent[0]?.session).toMatchObject({
    model: "gpt-live-1.1", store: false, audio: {output: {voice: "coral"}}, instructions: expect.stringContaining("Warm voice."),
    input: [{role: "developer", content: [{type: "input_text", text: expect.stringMatching(/ko[\s\S]*0\.792[\s\S]*<say>안녕하세요!<\/say>/u)}]}],
  });
  expect(upstream.sent[1]?.audio).toBe(Buffer.alloc(4_800).toString("base64"));
  expect(upstream.sent.at(-1)?.type).toBe("session.close");
  expect(result.mimeType).toBe("audio/wav");
  const audio = Buffer.from(result.audio);
  expect(audio.toString("ascii", 0, 4)).toBe("RIFF");
  expect(audio.readUInt32LE(24)).toBe(24_000);
  expect(audio.includes(voiced)).toBe(true);
  expect(audio.length).toBeLessThan(quiet.length);
  expect(upstream.isClosed()).toBe(true);
});

it.each(["", "125 dollars", "Refund approved"])("withholds incomplete or materially different speech (%s)", async transcript => {
  const upstream = scripted(e => e.type === "session.start" ? [started] :
    e.type === "session.input_audio.append" ? [...speechEvents(transcript), {type: "session.closed"}] : []);
  const reader = new LiveSpeechProvider({apiKey: "test", baseUrl: "https://api.openai.com/v1", connect: upstream.connect});
  await expect(reader.synthesize("1.25 dollars", {language: "en"})).rejects.toThrow();
  expect(upstream.isClosed()).toBe(true);
});

it.each([
  ["en", "Would you like me to open the second page?", "Would you like me to open the second page?"],
  ["zh", "个人电脑请按1，共用电脑请按2。", "个人电脑请按一，共用电脑请按二。"],
])("reads the full sentence at the saved speed in %s", async (language, line, transcript) => {
  const upstream = scripted(e => e.type === "session.start" ? [started] : e.type === "session.input_audio.append"
    ? [...speechEvents(transcript), {type: "session.closed"}] : []);
  const reader = new LiveSpeechProvider({apiKey: "test", baseUrl: "https://api.openai.com/v1", connect: upstream.connect});
  expect((await reader.synthesize(line, {language})).transcript).toBe(transcript);
});

it("cancels a read that has only produced silent audio", async () => {
  const stop = new AbortController();
  const upstream = scripted(e => {
    if (e.type === "session.start") return [started];
    if (e.type === "session.input_audio.append") { setTimeout(() => stop.abort(), 5); return [delta(quiet)]; }
    return [];
  });
  const reader = new LiveSpeechProvider({apiKey: "test", baseUrl: "https://api.openai.com/v1", connect: upstream.connect});
  await expect(reader.synthesize("Read this", {language: "en", signal: stop.signal})).rejects.toMatchObject({name: "AbortError"});
  expect(upstream.isClosed()).toBe(true);
});

it("continues a read when Live delegates before speaking", async () => {
  const upstream = scripted(e => e.type === "session.start" ? [started] :
    e.type === "session.input_audio.append" ? [{type: "session.delegation.created", delegation: {id: "read"}}] :
    e.type === "session.thinking.append" ? speechEvents("English, press 2.") : []);
  const reader = new LiveSpeechProvider({apiKey: "test", baseUrl: "https://api.openai.com/v1", connect: upstream.connect});
  const result = await reader.synthesize("English, press 2.", {language: "en", signal: AbortSignal.timeout(1000)});
  expect(result.transcript).toBe("English, press 2.");
  expect(upstream.sent.find(e => e.type === "session.thinking.append")?.delegation_id).toBe("read");
});
