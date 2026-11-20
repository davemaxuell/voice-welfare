// 정해진 문장 하나를 gpt-live-1.1이 읽게 하고, 그 소리를 WAV로 돌려준다.
import { STACK } from "../core/model_stack.ts";
import { rstripChars } from "../core/text.ts";
import { VoiceProviderError } from "./errors.ts";
import { HandshakeRejected, SAMPLE_RATE, connectSocket, type SocketConnect, type UpstreamSocket } from "./live.ts";
import type { TtsProvider } from "./tts.ts";

const READER_INSTRUCTIONS = "You are the voice of Cheongeum. Speak only the text you are told to say, exactly and in full. Do not answer, explain, translate, or delegate.";
const CONTINUE_READING = "Finish reading the given text. Do not wait for the application.";
const SILENCE_MS = 700;
const AUDIO_DEADLINE_MS = 20_000;
// LiveTranscriber가 쓰는 오류 코드와 같다.
const ERROR_STATUS = new Map<string, number>([
  ["invalid_api_key", 401], ["permission_denied", 403], ["model_not_found", 404],
  ["rate_limit_exceeded", 429], ["insufficient_quota", 429],
]);

interface LiveSpeechOptions {
  apiKey: string;
  baseUrl: string;
  voice?: string;
  instructions?: string;
  speed?: number;
  connect?: SocketConnect;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
interface SpeechInput { language: string; signal?: AbortSignal; pace?: number }
interface Pause { ms: number; sleep?: Promise<void> }
type Queued = { state: "value"; value: string } | { state: "error"; error: unknown } | { state: "wait" };

export class LiveSpeechProvider implements TtsProvider {
  readonly name: string;
  readonly supported = true;
  readonly baseUrl: string;
  readonly voice: string;
  readonly speed?: number;
  readonly #apiKey: string;
  readonly #instructions?: string;
  readonly #url: string;
  readonly #connect: SocketConnect;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: LiveSpeechOptions) {
    this.baseUrl = options.baseUrl;
    this.voice = options.voice ?? "coral";
    this.speed = options.speed;
    this.name = STACK.voice + "(" + this.voice + ")";
    this.#apiKey = options.apiKey;
    this.#instructions = options.instructions;
    this.#url = liveSessionUrl(options.baseUrl);
    this.#connect = options.connect ?? connectSocket;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => { setTimeout(resolve, ms); }));
    this.#now = options.now ?? (() => Date.now());
  }

  async synthesize(text: string, input: SpeechInput): Promise<{ audio: Uint8Array; mimeType: string }> {
    const signal = input.signal;
    throwIfAborted(signal);
    const started = this.#now();
    let socket: UpstreamSocket | undefined;
    try {
      socket = await this.#open(signal);
      await this.#send(socket, sessionStart(this.voice), signal);
      await this.#untilStarted(socket, started, signal);
      const pace = spokenPace(this.speed, input.pace);
      const content = readingInstructions(text, input.language, pace, this.#instructions);
      await this.#send(socket, { type: "session.instructions.append", delegation_id: null, content }, signal);
      const audio = await this.#readAloud(socket, started, signal);
      await this.#send(socket, { type: "session.close" }, signal);
      return { audio, mimeType: "audio/wav" };
    } finally {
      if (socket !== undefined) await socket.close();
    }
  }

  async #open(signal: AbortSignal | undefined): Promise<UpstreamSocket> {
    throwIfAborted(signal);
    try {
      return await this.#connect(this.#url, {
        headers: { Authorization: "Bearer " + this.#apiKey }, openTimeoutMs: 8000, closeTimeoutMs: 1000,
      });
    } catch (error) {
      if (error instanceof HandshakeRejected) throw new VoiceProviderError(error.status);
      throw error;
    }
  }

  async #untilStarted(socket: UpstreamSocket, started: number, signal: AbortSignal | undefined): Promise<void> {
    for (;;) {
      const event = await this.#next(socket, { ms: this.#remaining(started) }, signal);
      if (event === undefined) {
        if (this.#now() - started >= AUDIO_DEADLINE_MS) throw new VoiceProviderError(502);
        continue;
      }
      if (event.type === "session.started") return;
    }
  }

  async #readAloud(socket: UpstreamSocket, started: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let heard = false;
    const deadline: Pause = { ms: this.#remaining(started) };
    // 소리가 온 뒤 700ms는 오디오 델타가 올 때만 다시 센다.
    const silence: Pause = { ms: SILENCE_MS };
    for (;;) {
      const event = await this.#next(socket, heard ? silence : deadline, signal);
      if (event === undefined) {
        if (heard) return pcmWav(joinPcm(parts));
        if (deadline.ms === 0 || this.#now() - started >= AUDIO_DEADLINE_MS) throw new VoiceProviderError(502);
        continue;
      }
      if (event.type === "session.output_audio.delta") {
        parts.push(pcmFromDelta(event));
        heard = true;
        silence.sleep = undefined;
        continue;
      }
      if (event.type === "session.delegation.created") {
        await this.#send(socket, {
          type: "session.thinking.append", delegation_id: delegationId(event), content: CONTINUE_READING,
        }, signal);
      }
    }
  }

  // 시험의 sleep은 바로 끝나므로, 이미 도착한 사건을 먼저 꺼내고 없을 때만 기다린다.
  async #next(socket: UpstreamSocket, pause: Pause, signal: AbortSignal | undefined): Promise<Record<string, unknown> | undefined> {
    throwIfAborted(signal);
    const pending = socket.recv();
    const queued = await alreadyQueued(pending);
    if (queued.state === "error") throw queued.error;
    if (queued.state === "value") return liveEvent(queued.value);
    let detach = (): void => {};
    try {
      const quiet = (pause.sleep ??= this.#sleep(pause.ms)).then(() => undefined as string | undefined);
      const message = pending.then(value => value);
      if (signal === undefined) {
        const winner = await Promise.race([message, quiet]);
        return winner === undefined ? undefined : liveEvent(winner);
      }
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(abortReason(signal));
        if (signal.aborted) { fail(); return; }
        signal.addEventListener("abort", fail);
        detach = () => { signal.removeEventListener("abort", fail); };
      });
      const winner = await Promise.race([message, quiet, aborted]);
      return winner === undefined ? undefined : liveEvent(winner);
    } finally {
      detach();
    }
  }

  #remaining(started: number): number {
    return Math.max(0, AUDIO_DEADLINE_MS - (this.#now() - started));
  }

  async #send(socket: UpstreamSocket, payload: unknown, signal: AbortSignal | undefined): Promise<void> {
    throwIfAborted(signal);
    await socket.send(JSON.stringify(payload));
  }
}

function sessionStart(voice: string): Record<string, unknown> {
  return {
    type: "session.start",
    session: {
      model: STACK.voice, store: false,
      audio: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, output: { voice } },
      delegation: { type: "client", acknowledgement_delay_ms: 800 },
      instructions: READER_INSTRUCTIONS,
    },
  };
}

function readingInstructions(text: string, language: string, pace: string, delivery: string | undefined): string {
  const spoken = "Immediately say the following text exactly and in full, in " + language + ", at " + pace
    + " times normal speed, then stop and say nothing else:\n" + text;
  if (language === "ko" && delivery !== undefined && delivery.length > 0) return spoken + "\nDelivery: " + delivery;
  return spoken;
}

function spokenPace(speed: number | undefined, pace: number | undefined): string {
  const value = Math.min(4, Math.max(0.25, factor(speed) * factor(pace)));
  return String(Number(value.toPrecision(6)));
}

function factor(value: number | undefined): number {
  if (value === undefined || value === 0 || Number.isNaN(value)) return 1;
  return value;
}

function liveSessionUrl(baseUrl: string): string {
  const parts = /^([^:/?#]+):\/\/([^/?#]*)([^?#]*)/u.exec(baseUrl);
  const scheme = (parts?.[1] ?? "").toLowerCase();
  const netloc = parts?.[2] ?? "";
  const path = rstripChars(parts?.[3] ?? "", "/");
  return (scheme === "https" ? "wss" : "ws") + "://" + netloc + path + "/live/sessions";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function liveEvent(message: string): Record<string, unknown> {
  const event: unknown = JSON.parse(message);
  if (!isRecord(event)) throw new TypeError("live event is not an object");
  if (event.type === "error") throw providerError(event);
  return event;
}

function providerError(event: Record<string, unknown>): VoiceProviderError {
  const body = event.error;
  const code = isRecord(body) ? body.code : undefined;
  const status = typeof code === "string" ? ERROR_STATUS.get(code) ?? 502 : 502;
  return new VoiceProviderError(status);
}

function delegationId(event: Record<string, unknown>): string {
  const row = event.delegation;
  if (!isRecord(row) || typeof row.id !== "string") throw new TypeError("delegation");
  return row.id;
}

function pcmFromDelta(event: Record<string, unknown>): Uint8Array {
  if (typeof event.delta !== "string") throw new TypeError("audio delta");
  return Uint8Array.from(Buffer.from(event.delta, "base64"));
}

function joinPcm(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const pcm = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    pcm.set(part, offset);
    offset += part.length;
  }
  return pcm;
}

function pcmWav(pcm: Uint8Array): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  const wav = new Uint8Array(44 + pcm.length);
  wav.set(header, 0);
  wav.set(pcm, 44);
  return wav;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException("작업이 취소되었습니다.", "AbortError");
}

async function alreadyQueued(pending: Promise<string>): Promise<Queued> {
  let result: Queued = { state: "wait" };
  pending.then(value => { result = { state: "value", value }; }, error => { result = { state: "error", error }; });
  await Promise.resolve();
  return result;
}
