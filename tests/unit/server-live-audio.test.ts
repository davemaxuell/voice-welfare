import { expect, it } from "vitest";
import { LiveAudio, TranscriptTooLong, turnTranscript, type ServerSocket, type SocketMessage } from "../../src/server/live_audio.ts";
import { RequestConflict, RequestLedger } from "../../src/server/recovery.ts";
import type { LiveTranscription, SttProvider } from "../../src/voice/stt.ts";

function fakeSocket(messages: SocketMessage[]) {
  const sent: unknown[] = [];
  let closed = false;
  const socket: ServerSocket = {
    receive: async () => messages.shift() ?? { type: "disconnect" },
    sendJson: async value => { sent.push(value); },
    close: async () => { closed = true; },
    get disconnected() { return false; },
  };
  return { socket, sent, closed: () => closed };
}
function liveStt(reply = " 정부24 열어줘 ") {
  const heard: number[] = [];
  const live: LiveTranscription = {
    model: "gpt-live-transcribe",
    transcribe: async frames => {
      for await (const frame of frames) heard.push(frame.length);
      return reply;
    },
  };
  const stt: SttProvider = { name: "fake", supported: true, live, transcribe: async () => ({ text: "" }) };
  return { stt, heard };
}
const hello = (writer: unknown): SocketMessage => ({ type: "text", text: JSON.stringify({ writer }) });
const pcm = (size: number): SocketMessage => ({ type: "bytes", bytes: new Uint8Array(size) });
const commit: SocketMessage = { type: "text", text: "commit" };

function setup(session = { consentStatus: "granted", dialogue: { authWaiting: false }, generation: 3, lang: "ko" }, stt = liveStt().stt) {
  const ledger = new RequestLedger();
  const ledgers = new Map([["s1", ledger]]);
  const deps = {
    audio: { stt }, sessions: { ledgers }, port: 8787,
    accessWriter: (sid: string, writer: string) => sid === "s1" && writer === "w" ? session : new Response(null, { status: 403 }),
    voiceError: (error: unknown) => ({ error: error instanceof TranscriptTooLong ? "TRANSCRIPT_TOO_LONG" : "VOICE_PROVIDER" }),
  };
  return { deps, ledger, ledgers };
}
const receiptOf = (sent: unknown[]) => {
  const [first] = sent;
  return typeof first === "object" && first !== null && "receipt" in first ? first.receipt : undefined;
};

it("a spoken final becomes a one-use receipt for this session, ledger and generation", async () => {
  const live = new LiveAudio();
  const { stt, heard } = liveStt();
  const { deps, ledger } = setup(undefined, stt);
  const { socket, sent, closed } = fakeSocket([hello("w"), pcm(4800), pcm(4800), commit]);
  await live.microphone(socket, "s1", deps);
  expect(heard).toEqual([4800, 4800]);
  const receipt = receiptOf(sent);
  expect(typeof receipt).toBe("string");
  expect(closed()).toBe(true);
  expect(() => live.take(receipt, "s1", ledger, 4)).toThrow(RequestConflict);
  expect(() => live.take(receipt, "s1", new RequestLedger(), 3)).toThrow(RequestConflict);
  expect(live.take(receipt, "s1", ledger, 3)).toBe("정부24 열어줘");
  expect(() => live.take(receipt, "s1", ledger, 3)).toThrow(RequestConflict);
  expect(() => live.take(42, "s1", ledger, 3)).toThrow(RequestConflict);
});

it("refuses bad frames, foreign writers and missing consent, and reports a missing live service", async () => {
  const cases: Array<[SocketMessage[], unknown, ReturnType<typeof setup>["deps"]?]> = [
    [[hello("w"), pcm(3)], "REQUEST_CONFLICT"],
    [[hello("w"), pcm(65538)], "REQUEST_CONFLICT"],
    [[hello("w"), { type: "text", text: "hello" }], "REQUEST_CONFLICT"],
    [[hello("intruder")], "REQUEST_CONFLICT"],
    [[hello(null)], "REQUEST_CONFLICT"],
    [[{ type: "text", text: "not json" }], "REQUEST_CONFLICT"],
    [[pcm(2)], "VOICE_PROVIDER"],
    [[hello("w"), commit], "REQUEST_CONFLICT", setup({ consentStatus: "pending", dialogue: { authWaiting: false }, generation: 3, lang: "ko" }).deps],
    [[hello("w")], "NOT_SUPPORTED", setup(undefined, { name: "x", supported: true, transcribe: async () => ({ text: "" }) }).deps],
  ];
  for (const [messages, code, deps] of cases) {
    const { socket, sent } = fakeSocket([...messages]);
    await new LiveAudio().microphone(socket, "s1", deps ?? setup().deps);
    const [reply] = sent;
    expect(typeof reply === "object" && reply !== null && "error" in reply ? reply.error : reply, JSON.stringify(messages).slice(0, 80)).toBe(code);
  }
  const { socket, sent } = fakeSocket([hello("w"), { type: "disconnect" }]);
  await new LiveAudio().microphone(socket, "s1", setup().deps);
  expect(sent).toEqual([]);
});

it("keeps short transcripts and refuses long ones that are not a stop", () => {
  expect(turnTranscript("  다음으로  ")).toBe("다음으로");
  expect(turnTranscript("가".repeat(500))).toBe("가".repeat(500));
  expect(() => turnTranscript("가".repeat(501))).toThrow(TranscriptTooLong);
});
