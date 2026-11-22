// Relay microphone audio. A one-use receipt lets existing turn and Stop endpoints consume the final privately.
import { randomBytes } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { UpgradeWebSocket, WSContext, WSEvents } from "hono/ws";
import { strip } from "../core/text.ts";
import { redactText } from "../safety/privacy.ts";
import { isStopUtterance } from "../understanding/rules.ts";
import { SAMPLE_RATE, SocketClosed, withDeadline } from "../voice/live.ts";
import { recoverVoice, TRANSCRIPTION_DEADLINE_MS, voiceFault, VoiceFault } from "../voice/recovery.ts";
import type { SttProvider } from "../voice/stt.ts";
import { RequestConflict, type RequestLedger } from "./recovery.ts";
import { TURN_TEXT_LIMIT, originRefusal, type HeaderList } from "./request_policy.ts";

export class TranscriptTooLong extends Error {
  constructor() { super("transcript too long"); }
}
/** Starlette's WebSocketDisconnect: the browser went away. */
export class SocketDisconnected extends Error {
  constructor() { super("websocket disconnected"); }
}
/** Python ValueError on this socket: a malformed hello or frame. */
export class InvalidAudio extends Error {}

export function turnTranscript(text: string): string {
  const trimmed = strip(text);
  if (Array.from(trimmed).length <= TURN_TEXT_LIMIT) return trimmed;
  if (isStopUtterance(redactText(trimmed))) return "멈춰";
  throw new TranscriptTooLong();
}

export type SocketMessage = { type: "text"; text: string } | { type: "bytes"; bytes: Uint8Array } | { type: "disconnect" };
/** The parts of Starlette's WebSocket these handlers use, after accept. */
export interface ServerSocket {
  receive(): Promise<SocketMessage>;
  sendJson(value: unknown): Promise<void>;
  close(code?: number): Promise<void>;
  readonly disconnected: boolean;
}

/** Turns Hono's WebSocket callbacks into a ServerSocket and runs the handler once the socket opens. */
export function socketEvents(run: (socket: ServerSocket) => Promise<void>): WSEvents {
  const inbox: Array<Promise<SocketMessage>> = [];
  const waiting: Array<(message: Promise<SocketMessage>) => void> = [];
  let disconnected = false;
  const push = (message: Promise<SocketMessage>) => {
    const waiter = waiting.shift();
    if (waiter === undefined) inbox.push(message);
    else waiter(message);
  };
  return {
    onOpen(_event, ws: WSContext) {
      const socket: ServerSocket = {
        receive: async () => await (inbox.shift() ?? new Promise<Promise<SocketMessage>>(resolve => { waiting.push(resolve); })),
        sendJson: async value => {
          if (disconnected) throw new SocketDisconnected();
          ws.send(JSON.stringify(value));
        },
        close: async code => { if (!disconnected) ws.close(code); },
        get disconnected() { return disconnected; },
      };
      void run(socket).catch(() => {});
    },
    onMessage(event) {
      const data = event.data;
      if (typeof data === "string") push(Promise.resolve({ type: "text", text: data }));
      else if (data instanceof Blob) push(data.arrayBuffer().then(buffer => ({ type: "bytes", bytes: new Uint8Array(buffer) })));
      else push(Promise.resolve({ type: "bytes", bytes: new Uint8Array(data) }));
    },
    onClose() {
      disconnected = true;
      push(Promise.resolve({ type: "disconnect" }));
    },
  };
}

/** The handshake check runs before the upgrade: Starlette answers a socket closed before accept with HTTP 403. */
export function refuseForeignOrigin(port: number | undefined, headersOf: (c: Context) => HeaderList): MiddlewareHandler {
  return async (c, next) => {
    const scheme = new URL(c.req.url).protocol === "https:" || new URL(c.req.url).protocol === "wss:" ? "https" : "http";
    if (originRefusal(headersOf(c), scheme, port, { required: true }) !== undefined) return c.body(null, 403);
    await next();
    return undefined;
  };
}

export interface LiveSession {
  readonly consentStatus: string;
  readonly dialogue: { readonly authWaiting: boolean };
  readonly generation: number;
  readonly lang: string;
}
export interface LiveSessions { readonly ledgers: ReadonlyMap<string, RequestLedger> }
export interface AudioServices { readonly stt: SttProvider }
export type AccessWriter<S> = (sid: string, writer: string) => S | Response;
/** The app's voice_error: the JSON body it would send for this error. */
export type VoiceErrorBody = (error: unknown) => unknown;

const LISTENING_ENDED = { error: "REQUEST_CONFLICT", message: "듣기가 끝났어요. 다시 말씀해 주세요." };
const MAX_FRAME = 65536;
const MAX_UTTERANCE = SAMPLE_RATE * 2 * 30;

interface Receipt { sid: string; ledger: RequestLedger; generation: number; text: string }
const tokenUrlsafe = (bytes: number) => randomBytes(bytes).toString("base64url");
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class LiveAudio {
  readonly #receipts = new Map<string, Receipt>();
  readonly #active = new Map<string, number>();

  take(token: unknown, sid: string, ledger: RequestLedger, generation: number): string {
    const record = typeof token === "string" ? this.#receipts.get(token) : undefined;
    if (typeof token !== "string" || record === undefined || record.sid !== sid || record.ledger !== ledger || record.generation !== generation) {
      throw new RequestConflict();
    }
    this.#receipts.delete(token);
    return record.text;
  }

  register<S extends LiveSession>(app: Hono, upgradeWebSocket: UpgradeWebSocket, deps: MicrophoneDeps<S>, headersOf: (c: Context) => HeaderList): void {
    app.get("/api/session/:sid/audio/live", refuseForeignOrigin(deps.port, headersOf),
      upgradeWebSocket(c => socketEvents(socket => this.microphone(socket, c.req.param("sid") ?? "", deps))));
  }

  /** After the origin check and accept. Mirrors the body of Python's microphone handler. */
  async microphone<S extends LiveSession>(socket: ServerSocket, sid: string, deps: MicrophoneDeps<S>): Promise<void> {
    const { audio, sessions, accessWriter, voiceError } = deps;
    let active = false;
    try {
      const helloMessage = await withDeadline(5000, socket.receive());
      if (helloMessage.type === "disconnect") throw new SocketDisconnected();
      if (helloMessage.type !== "text") throw new TypeError("expected a text message");
      let hello: unknown;
      try {
        hello = JSON.parse(helloMessage.text);
      } catch {
        throw new InvalidAudio("hello is not JSON");
      }
      const writer = isRecord(hello) ? ("writer" in hello ? hello.writer : "") : undefined;
      if (typeof writer !== "string" || Array.from(writer).length > 128) throw new RequestConflict();
      const session = accessWriter(sid, writer);
      if (session instanceof Response || session.consentStatus !== "granted" || session.dialogue.authWaiting) throw new RequestConflict();
      const upstream = audio.stt.live;
      if (upstream === undefined) {
        await socket.sendJson({ error: "NOT_SUPPORTED", message: "이용 설정에서 음성 API 키를 확인해 주세요." });
        return;
      }
      const ledger = sessions.ledgers.get(sid);
      if (ledger === undefined) throw new RangeError(sid);
      const generation = session.generation;
      if ((this.#active.get(sid) ?? 0) >= 2) throw new RequestConflict();
      this.#active.set(sid, (this.#active.get(sid) ?? 0) + 1);
      active = true;

      const current = () => {
        if (sessions.ledgers.get(sid) !== ledger || session.generation !== generation || session.consentStatus !== "granted"
          || session.dialogue.authWaiting || audio.stt.live !== upstream) {
          throw new RequestConflict();
        }
      };
      async function* frames(): AsyncGenerator<Uint8Array> {
        let size = 0;
        for (;;) {
          const message = await socket.receive();
          if (message.type === "disconnect") throw new SocketDisconnected();
          current();
          if (message.type === "text" && message.text === "commit") return;
          const frame = message.type === "bytes" ? message.bytes : undefined;
          if (frame === undefined || frame.length === 0 || frame.length % 2 !== 0 || frame.length > MAX_FRAME) throw new InvalidAudio("invalid PCM frame");
          size += frame.length;
          if (size > MAX_UTTERANCE) throw new InvalidAudio("utterance too long");
          yield frame;
        }
      }
      // 같은 녹음·동의·세대에 대해서만 받아쓰기를 재시도한다. 동작은 영수증을 소비할 때 한 번만 실행한다.
      const lifetime = new AbortController();
      const input = frames();
      const buffered: Uint8Array[] = [];
      let reading: Promise<void> | undefined;
      let finished = false;
      async function* recording() {
        for (let i = 0; ; i++) {
          lifetime.signal.throwIfAborted();
          current();
          if (socket.disconnected) throw new SocketDisconnected();
          if (i === buffered.length && !finished) {
            reading ??= input.next().then(next => {
              if (next.done === true) finished = true;
              else buffered.push(next.value);
            }).finally(() => { reading = undefined; });
            await reading;
          }
          const frame = buffered[i];
          if (frame === undefined) return;
          yield frame;
        }
      }
      let recovered = false, text: string;
      try {
        text = turnTranscript(await withDeadline(TRANSCRIPTION_DEADLINE_MS, recoverVoice("transcription", lifetime.signal, () => {
          current();
          if (socket.disconnected) throw new SocketDisconnected();
          return upstream.transcribe(recording(), session.lang);
        }, () => { recovered = true; }, undefined, e => e instanceof SocketClosed ? new VoiceFault("UPSTREAM_CLOSED_" + e.code, true) : voiceFault(e))));
      } finally { lifetime.abort(); }
      current();
      // Only the server holds the final. A dropped recording cannot dispatch an action.
      const mine = [...this.#receipts].filter(([, row]) => row.sid === sid).map(([key]) => key);
      for (const old of mine.slice(0, -1)) this.#receipts.delete(old);
      const token = tokenUrlsafe(24);
      this.#receipts.set(token, { sid, ledger, generation, text });
      setTimeout(() => { this.#receipts.delete(token); }, 30_000).unref();
      await socket.sendJson(recovered ? { receipt: token, voiceRecovered: true } : { receipt: token });
    } catch (error) {
      if (error instanceof SocketDisconnected) return;
      if (error instanceof InvalidAudio || error instanceof RequestConflict) await socket.sendJson(LISTENING_ENDED).catch(() => {});
      else await socket.sendJson(voiceError(error)).catch(() => {});
    } finally {
      if (active) {
        const left = (this.#active.get(sid) ?? 1) - 1;
        if (left === 0) this.#active.delete(sid);
        else this.#active.set(sid, left);
      }
      if (!socket.disconnected) await socket.close().catch(() => {});
    }
  }
}

export interface MicrophoneDeps<S> {
  readonly audio: AudioServices;
  readonly sessions: LiveSessions;
  readonly accessWriter: AccessWriter<S>;
  readonly voiceError: VoiceErrorBody;
  readonly port: number | undefined;
}
