// Stream one microphone utterance to the keyed Realtime transcription service.
import { WebSocket } from "ws";
import { strip, rstripChars } from "../core/text.ts";
import { VoiceProviderError } from "./errors.ts";
import { PROMPT_TERMS, isHallucination, isPromptEcho, type LiveTranscription } from "./stt.ts";

export const LIVE_MODEL = "gpt-live-transcribe";
export const SAMPLE_RATE = 24_000;

/** asyncio.timeout과 같다: 기한을 넘기면 이 오류로 끝난다. */
export class DeadlineExceeded extends Error {
  override readonly name = "TimeoutError";
}
export async function withDeadline<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineExceeded("deadline")), ms); });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** 업스트림 웹소켓이 101이 아닌 HTTP 상태로 거절했다. */
export class HandshakeRejected extends Error {
  readonly status: number;
  constructor(status: number) { super("websocket handshake rejected (HTTP " + status + ")"); this.status = status; }
}
/** 닫힌 연결에서 받거나 보내려 했다. 정상 종료(1000·1001)면 반복은 오류 없이 끝난다. */
export class SocketClosed extends Error {
  readonly code: number;
  constructor(code: number) { super("websocket closed (" + code + ")"); this.code = code; }
}
export interface UpstreamSocket extends AsyncIterable<string> {
  send(text: string): Promise<void>;
  recv(): Promise<string>;
  close(): Promise<void>;
}
export interface ConnectOptions { headers: Record<string, string>; openTimeoutMs: number; closeTimeoutMs: number; maxSize?: number }
export type SocketConnect = (url: string, options: ConnectOptions) => Promise<UpstreamSocket>;

// Python websockets의 기본 최대 메시지 크기
const DEFAULT_MAX_SIZE = 2 ** 20;

function text(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

export const connectSocket: SocketConnect = (url, options) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, {
    headers: options.headers, handshakeTimeout: options.openTimeoutMs, maxPayload: options.maxSize ?? DEFAULT_MAX_SIZE,
  });
  const inbox: string[] = [];
  const waiting: Array<{ resolve: (value: string) => void; reject: (error: unknown) => void }> = [];
  let ended: SocketClosed | undefined;
  let opened = false;
  const finish = (code: number) => {
    ended ??= new SocketClosed(code);
    for (const waiter of waiting.splice(0)) waiter.reject(ended);
  };
  socket.on("unexpected-response", (_request, response) => {
    reject(new HandshakeRejected(response.statusCode ?? 0));
    socket.terminate();
  });
  socket.on("error", (error) => { if (!opened) reject(error); });
  socket.on("message", (data) => {
    const message = text(data);
    const waiter = waiting.shift();
    if (waiter === undefined) inbox.push(message);
    else waiter.resolve(message);
  });
  socket.on("close", (code) => finish(code));
  const recv = () => {
    const message = inbox.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (ended !== undefined) return Promise.reject(ended);
    return new Promise<string>((resolveMessage, rejectMessage) => { waiting.push({ resolve: resolveMessage, reject: rejectMessage }); });
  };
  const upstream: UpstreamSocket = {
    recv,
    send: (message) => new Promise<void>((sent, failed) => {
      if (socket.readyState !== WebSocket.OPEN) { failed(ended ?? new SocketClosed(1006)); return; }
      socket.send(message, (error) => { if (error === undefined || error === null) sent(); else failed(error); });
    }),
    close: () => new Promise<void>((closed) => {
      if (socket.readyState === WebSocket.CLOSED) { closed(); return; }
      const timer = setTimeout(() => { socket.terminate(); closed(); }, options.closeTimeoutMs);
      socket.once("close", () => { clearTimeout(timer); closed(); });
      socket.close();
    }),
    async *[Symbol.asyncIterator]() {
      for (;;) {
        try {
          yield await recv();
        } catch (error) {
          if (error instanceof SocketClosed && (error.code === 1000 || error.code === 1001)) return;
          throw error;
        }
      }
    },
  };
  socket.on("open", () => { opened = true; resolve(upstream); });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function liveEvent(message: string): Record<string, unknown> {
  const event: unknown = JSON.parse(message);
  if (!isRecord(event)) throw new TypeError("live event is not an object");
  if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed") {
    throw VoiceProviderError.fromBody(event);
  }
  return event;
}

function splitUrl(url: string) {
  const parts = /^([^:/?#]+):\/\/([^/?#]*)([^?#]*)/u.exec(url);
  return parts === null ? { scheme: "", netloc: "", path: "" } : { scheme: (parts[1] ?? "").toLowerCase(), netloc: parts[2] ?? "", path: parts[3] ?? "" };
}

export class LiveTranscriber implements LiveTranscription {
  readonly model = LIVE_MODEL;
  readonly url: string;
  readonly #key: string;
  readonly #connect: SocketConnect;
  constructor(baseUrl: string, apiKey: string, connect: SocketConnect = connectSocket) {
    const { scheme, netloc, path } = splitUrl(baseUrl);
    this.url = (scheme === "https" ? "wss" : "ws") + "://" + netloc + rstripChars(path, "/") + "/realtime?intent=transcription";
    this.#key = apiKey;
    this.#connect = connect;
  }

  async transcribe(frames: AsyncIterable<Uint8Array>, language: string): Promise<string> {
    const inputs = {
      format: { type: "audio/pcm", rate: SAMPLE_RATE }, turn_detection: null,
      transcription: { model: this.model, delay: "low", keywords: [...PROMPT_TERMS], languages: [...new Set([language, "ko", "en", "zh", "ja"])] },
    };
    let socket: UpstreamSocket;
    try {
      socket = await this.#connect(this.url, { headers: { Authorization: "Bearer " + this.#key }, openTimeoutMs: 8000, closeTimeoutMs: 1000, maxSize: 128_000 });
    } catch (error) {
      if (error instanceof HandshakeRejected) throw new VoiceProviderError(error.status);
      throw error;
    }
    let stopped = false;
    try {
      await withDeadline(8000, (async () => {
        await socket.send(JSON.stringify({ type: "session.update", session: { type: "transcription", audio: { input: inputs } } }));
        while (liveEvent(await socket.recv()).type !== "session.updated") { /* 설정이 반영될 때까지 다른 알림은 넘긴다 */ }
      })());
      const sendAudio = async () => {
        let count = 0;
        for await (const frame of frames) {
          if (stopped) return false;
          count += frame.length;
          await socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.from(frame).toString("base64") }));
        }
        if (count < Math.floor(SAMPLE_RATE / 5)) return false; // 16비트 모노 100ms
        await socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        return true;
      };
      const receiveFinal = async () => {
        let item: unknown;
        for (;;) {
          const event = liveEvent(await socket.recv());
          if (!("type" in event)) throw new TypeError("live event without type");
          if (event.type === "input_audio_buffer.committed") {
            item = event.item_id;
          } else if (isTruthy(item) && event.type === "conversation.item.input_audio_transcription.completed" && event.item_id === item) {
            const raw = event.transcript;
            if (raw !== undefined && raw !== null && raw !== "" && typeof raw !== "string") throw new TypeError("transcript is not text");
            const transcript = typeof raw === "string" ? strip(raw) : "";
            return isHallucination(transcript) || isPromptEcho(transcript) ? "" : transcript;
          }
        }
      };
      const sender = sendAudio();
      const receiver = receiveFinal();
      // 진 쪽은 연결을 닫을 때 끝난다. 그 거절은 이미 볼 일이 없다.
      sender.catch(() => {});
      receiver.catch(() => {});
      const first = await Promise.race([
        receiver.then(() => "receiver" as const, () => "receiver" as const),
        sender.then(() => "sender" as const, () => "sender" as const),
      ]);
      if (first === "receiver") return await receiver;
      if (!await sender) return "";
      return await withDeadline(15_000, receiver);
    } finally {
      stopped = true;
      await socket.close();
    }
  }
}

function isTruthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && value !== 0 && value !== false;
}
