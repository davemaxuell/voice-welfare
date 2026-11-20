import { expect, it } from "vitest";
import { SocketClosed, type SocketConnect, type UpstreamSocket } from "../../src/voice/live.ts";
import { LiveSpeechProvider } from "../../src/voice/live_speech.ts";

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

it("reads one sentence from gpt-live-1.1 and returns wav", async () => {
  const upstream = scripted(message => {
    if (message.type === "session.start") return [{ type: "session.started", session: { id: "s" } }];
    if (message.type === "session.instructions.append") return [
      { type: "session.output_audio.delta", delta: Buffer.from([1, 2, 3, 4]).toString("base64") },
      { type: "session.output_audio.delta", delta: Buffer.from([5, 6]).toString("base64") },
    ];
    return [];
  });
  const speech = new LiveSpeechProvider({
    apiKey: "sk-test", baseUrl: "https://api.openai.com/v1/", voice: "coral",
    instructions: "천천히", speed: 1.1, connect: upstream.connect, sleep: async () => {},
  });
  const out = await speech.synthesize("안녕하세요", { language: "ko", pace: 0.9 / 1.25 });
  expect(upstream.seen[0]).toEqual(["wss://api.openai.com/v1/live/sessions", { Authorization: "Bearer sk-test" }]);
  expect(upstream.sent[0]).toMatchObject({
    type: "session.start",
    session: {
      model: "gpt-live-1.1", store: false,
      audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "coral" } },
      delegation: { type: "client", acknowledgement_delay_ms: 800 },
      instructions: "You are the voice of Cheongeum. Speak only the text you are told to say, exactly and in full. Do not answer, explain, translate, or delegate.",
    },
  });
  expect(upstream.sent[1]).toMatchObject({
    type: "session.instructions.append", delegation_id: null,
    content: "Immediately say the following text exactly and in full, in ko, at 0.792 times normal speed, then stop and say nothing else:\n안녕하세요\nDelivery: 천천히",
  });
  expect(out.mimeType).toBe("audio/wav");
  expect(Buffer.from(out.audio.subarray(0, 4)).toString("ascii")).toBe("RIFF");
  expect(Buffer.from(out.audio.subarray(8, 12)).toString("ascii")).toBe("WAVE");
  expect(Buffer.from(out.audio.buffer, out.audio.byteOffset + 24, 4).readUInt32LE(0)).toBe(24000);
  expect([...out.audio.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6]);
  expect(upstream.sent.map(m => m.type)).toContain("session.close");
  expect(upstream.isClosed()).toBe(true);
});

it("a read that gets no audio fails instead of returning silence", async () => {
  const upstream = scripted(message => message.type === "session.start" ? [{ type: "session.started", session: { id: "s" } }] : []);
  let calls = 0;
  const speech = new LiveSpeechProvider({
    apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", connect: upstream.connect,
    sleep: async () => {}, now: () => calls++ === 0 ? 0 : 20_000,
  });
  await expect(speech.synthesize("안녕하세요", { language: "ko" })).rejects.toMatchObject({ status: 502 });
  expect(JSON.stringify(upstream.sent)).not.toContain("commentary");
});

it("a delegation during a read does not send the sentence back as commentary", async () => {
  const upstream = scripted(message => {
    if (message.type === "session.start") return [{ type: "session.started", session: { id: "s" } }];
    if (message.type === "session.instructions.append") return [{ type: "session.delegation.created", delegation: { id: "d1", target: "client" } }];
    if (message.type === "session.thinking.append") return [{ type: "session.output_audio.delta", delta: Buffer.from([9, 8]).toString("base64") }];
    return [];
  });
  const speech = new LiveSpeechProvider({
    apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", connect: upstream.connect, sleep: async () => {},
  });
  await speech.synthesize("다음으로", { language: "en" });
  expect(upstream.sent.some(m => m.type === "session.commentary.append")).toBe(false);
  expect(upstream.sent.find(m => m.type === "session.thinking.append")).toMatchObject({
    delegation_id: "d1", content: "Finish reading the given text. Do not wait for the application.",
  });
  expect(upstream.sent[1]?.content).not.toContain("Delivery:");
});
