import { workspaceText } from "./workspace-language.ts";
// WebRTC carries native microphone and speaker audio. The loopback websocket
// authenticates the offer and delivers results from the application's worker.
import { z } from "zod";
import { api, ApiError } from "./api.ts";
import { timing } from "./perf.ts";
import { getSpeechLang, audioContext } from "./audio.ts";
import { isPrivateReadback, isSpeaking, reserveSpeech, serverTts } from "./speaker.ts";
import { liveClosure, recoverVoice, VoiceFault, voiceFault } from "../../src/voice/recovery.ts";
import type { Phase } from "./view.ts";

// 청음이 읽는 동안 GPT-Live로 가는 마이크는 꺼 둔다(청음 자신의 목소리가 요청이 되면 안 된다).
// 그래서 읽는 말을 끊는 소리는 mic.ts watchBargeIn처럼 여기서 판단한다: 스피커 소리보다 큰 소리가 300ms.
export class BargeDetector {
  floor = 0.01;
  bleed = this.floor;
  loudMs = 0;

  feed(level: number, speaking: boolean, ms = 50) {
    if (!speaking) {
      if (level < this.floor * 2) this.floor = this.floor * 0.95 + level * 0.05;
      this.bleed = this.floor;
      this.loudMs = 0;
      return false;
    }
    if (level > Math.max(0.02, this.bleed * 2.2, this.floor * 4)) this.loudMs += ms;
    else {
      this.loudMs = Math.max(0, this.loudMs - ms);
      this.bleed = this.bleed * 0.9 + level * 0.1;
    }
    if (this.loudMs < 300) return false;
    this.loudMs = 0;
    return true;
  }
}

export interface Caption { delta?: string; start_ms: number; end_ms: number }
const ChannelEventSchema = z.object({
  type: z.string(), reason: z.string().optional(), delta: z.string().optional(), start_ms: z.number().default(0), end_ms: z.number().default(0),
});
const SocketMessageSchema = z.object({
  error: z.string().optional(), message: z.string().optional(), sdp: z.string().optional(),
  status: z.number().optional(), retryAfterMs: z.number().nonnegative().optional(),
  result: z.unknown().optional(), exact: z.boolean().optional(), activity: z.string().optional(),
});

export interface LiveCallbacks {
  offer(socket: WebSocket, sdp: string): void;
  phase(phase: Phase): void;
  notice(message: string): void;
  caption(event: Caption): void;
  result(result: unknown, exact: boolean | undefined): Promise<void>;
  failure(error: VoiceFault): void;
  recovered?(): void;
  activity?(text: string): void;
  captureChanged?(): void;
}

const LIVE_LANGS = ["ko", "en", "ja", "zh"];

export class LiveConversation {
  sessionId: string;
  callbacks: LiveCallbacks;
  audio = new Audio();
  enabled = true;
  localSpeech = isSpeaking() || isPrivateReadback();
  paused = false;
  closed = false;
  interrupted = false;
  language: string | undefined;
  speed: number | undefined;
  peer: RTCPeerConnection | undefined;
  abort: AbortController | undefined;
  stream: MediaStream | undefined;
  channel: RTCDataChannel | undefined;
  socket: WebSocket | undefined;
  phaseTimer: ReturnType<typeof setTimeout> | undefined;
  stopBargeIn: (() => void) | undefined;
  readonly lifetime = new AbortController();
  private deviceId: string | undefined;
  private established = false;
  private nativeSpeech: (() => void) | undefined;

  get hasNativeSpeech() { return this.nativeSpeech !== undefined; }

  constructor(sessionId: string, callbacks: LiveCallbacks) {
    this.sessionId = sessionId;
    this.callbacks = callbacks;
    this.audio.autoplay = true;
  }

  async start(deviceId?: string) {
    this.deviceId = deviceId;
    await this.connect();
  }

  private async connect(disconnected?: VoiceFault) {
    let interrupted = disconnected !== undefined;
    let prior = disconnected;
    await recoverVoice("conversation", this.lifetime.signal, async () => {
      this.release();
      if (prior !== undefined) { const fault = prior; prior = undefined; throw fault; }
      await this.open(this.deviceId);
    }, () => { interrupted = true; this.release(); });
    if (interrupted && !this.closed) this.callbacks.recovered?.();
  }

  private async open(deviceId?: string) {
    const peer = this.peer = new RTCPeerConnection();
    const signal = (this.abort = new AbortController()).signal;
    const request = timing?.mark("microphone-requested");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, ...(deviceId !== undefined && deviceId.length > 0 && { deviceId: { exact: deviceId } }),
    } });
    if (signal.aborted) {
      stream.getTracks().forEach(track => track.stop());
      throw signal.reason;
    }
    this.stream = stream;
    if (request !== undefined && stream.getAudioTracks().some(track => track.readyState === "live")) timing?.measure(request, "track-live");
    for (const track of stream.getAudioTracks()) {
      peer.addTrack(track, stream);
      track.onended = () => this.disconnected(new VoiceFault("MIC_LOST", true), signal);
      track.onmute = track.onunmute = () => this.callbacks.captureChanged?.();
    }
    this.updateAudio();
    this.watchBargeIn(stream);
    peer.ontrack = ({ track }) => {
      if (signal.aborted) return;
      this.audio.srcObject = new MediaStream([track]);
      this.audio.play().catch(() => {
        if (!this.closed) this.callbacks.notice(workspaceText("실시간 음성을 재생하려면 대화 시작을 다시 선택해 주세요.", getSpeechLang()));
      });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") this.disconnected(new VoiceFault("WEBRTC_FAILED", true), signal);
    };
    const channel = this.channel = peer.createDataChannel("oai-events");
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (signal.aborted) return;
      let event;
      try { event = ChannelEventSchema.parse(JSON.parse(String(data))); } catch { return; }
      if (event.type === "session.closed") {
        this.finishNativeSpeech();
        const fault = liveClosure(event.reason);
        if (fault !== undefined) this.disconnected(fault, signal);
      } else if (event.type === "session.input_transcript.delta") {
        this.interrupted = false;
        this.updateAudio();
        this.phase("hearing");
      } else if (event.type === "session.output_transcript.delta" && !this.localSpeech && !this.paused && !this.interrupted) {
        this.phase("speaking");
        this.callbacks.caption(event);
      } else if (event.type === "session.delegation.created") this.phase("thinking");
    };
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== "complete") {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          peer.removeEventListener("icegatheringstatechange", check);
          signal.removeEventListener("abort", done);
          if (signal.aborted) reject(signal.reason);
          else resolve();
        };
        const check = () => { if (peer.iceGatheringState === "complete") done(); };
        const timer = setTimeout(done, 3500);
        peer.addEventListener("icegatheringstatechange", check);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done(); else check();
      });
    }
    signal.throwIfAborted();
    const socket = this.socket = api.conversationSocket(this.sessionId);
    await new Promise<void>((resolve, reject) => {
      const deadline = () => setTimeout(() => fail(new VoiceFault("VOICE_TIMEOUT", true)), 25000);
      let timer = deadline();
      let ready = false;
      const fail = (error: VoiceFault) => {
        clearTimeout(timer);
        if (!ready) reject(error); else this.disconnected(error, signal);
      };
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      socket.onopen = () => this.callbacks.offer(socket, peer.localDescription?.sdp ?? "");
      channel.onopen = () => {
        if (signal.aborted) return;
        clearTimeout(timer);
        ready = true;
        this.established = true;
        resolve();
      };
      channel.onclose = () => fail(new VoiceFault("DATA_CHANNEL_CLOSED", true));
      socket.onmessage = async ({ data }: MessageEvent<unknown>) => {
        try {
          const msg = SocketMessageSchema.parse(JSON.parse(String(data)));
          if (signal.aborted) return;
          if (msg.error !== undefined && msg.error.length > 0) { fail(voiceFault(new ApiError("server", msg.error, msg.status ?? 502, msg.retryAfterMs))); return; }
          if (msg.sdp !== undefined && msg.sdp.length > 0) {
            clearTimeout(timer);
            timer = deadline(); // 공급자 제안이 도착한 뒤부터 실제 오디오 채널 연결을 기다린다.
            await peer.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          }
          if (signal.aborted) return;
          if (msg.activity !== undefined && msg.activity.length > 0) this.callbacks.activity?.(msg.activity);
          if (msg.result != null && !this.closed) {
            if (msg.exact !== true && !this.audio.muted) {
              // The sideband will ask Live to say this answer. Its first caption may arrive later.
              clearTimeout(this.phaseTimer);
              this.nativeSpeech ??= reserveSpeech(signal);
            }
            const release = reserveSpeech(signal);
            try { await this.callbacks.result(msg.result, msg.exact); } finally { release(); }
          }
        } catch { fail(new VoiceFault("SIGNAL_PROTOCOL", false)); }
      };
      socket.onerror = () => fail(new VoiceFault("SIGNAL_CONNECTION", true));
      socket.onclose = event => fail(new VoiceFault("SIGNAL_CLOSED_" + event.code, true));
    });
  }

  watchBargeIn(stream: MediaStream) {
    // GPT-Live 쪽 원래 트랙을 꺼도 복제본으로 계속 잰다.
    const track = stream.getAudioTracks()[0]?.clone();
    if (track === undefined) return;
    const ctx = audioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const detector = new BargeDetector();
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      if (detector.feed(Math.sqrt(sum / samples.length), this.localSpeech)) serverTts.cancel();
    }, 50);
    this.stopBargeIn = () => {
      clearInterval(timer);
      source.disconnect();
      track.stop();
    };
  }

  phase(value: Phase) {
    if (this.closed) return;
    clearTimeout(this.phaseTimer);
    if (value === "speaking" && !this.audio.muted) this.nativeSpeech ??= reserveSpeech(this.abort?.signal);
    else this.finishNativeSpeech();
    this.callbacks.phase(value);
    if (value !== "thinking") this.phaseTimer = setTimeout(() => {
      this.finishNativeSpeech();
      this.callbacks.phase("listening");
    }, 1200);
  }

  private finishNativeSpeech() {
    this.nativeSpeech?.();
    this.nativeSpeech = undefined;
  }

  updateAudio() {
    this.audio.muted = !this.enabled || this.paused || this.interrupted || this.localSpeech || isPrivateReadback();
    if (this.audio.muted) this.finishNativeSpeech();
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !this.paused && !this.localSpeech && !isPrivateReadback();
    this.callbacks.captureChanged?.();
  }

  setLanguage(lang: string, speed?: number) {
    if ((this.language === lang && this.speed === speed) || this.channel?.readyState !== "open" || !LIVE_LANGS.includes(lang)) return;
    this.language = lang;
    this.speed = speed;
    this.channel.send(JSON.stringify({ type: "session.instructions.append", event_id: crypto.randomUUID(),
      delegation_id: null, content: "The application selected reply language " + lang + ". Use it for subsequent speech."
        + (speed === undefined ? "" : " Speak at " + speed + " times normal speed.") }));
  }

  interrupt() {
    this.interrupted = true;
    this.updateAudio();
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify({
      type: "session.instructions.append", event_id: crypto.randomUUID(), delegation_id: null,
      content: "Stop speaking immediately and listen to the user.",
    }));
    this.phase("listening");
  }

  private disconnected(fault: VoiceFault, signal: AbortSignal) {
    if (this.closed || signal.aborted) return;
    if (!this.established) {
      this.abort?.abort(fault);
      return;
    }
    void this.connect(fault).catch((error: unknown) => {
      if (!this.closed) this.callbacks.failure(voiceFault(error));
    });
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    this.release();
  }

  private release() {
    this.established = false;
    clearTimeout(this.phaseTimer);
    this.finishNativeSpeech();
    this.abort?.abort();
    this.abort = undefined;
    this.stopBargeIn?.();
    this.stopBargeIn = undefined;
    this.stream?.getTracks().forEach(track => track.stop());
    this.socket?.close();
    this.channel?.close();
    this.peer?.close();
    this.stream = this.channel = this.socket = this.peer = undefined;
    this.audio.pause();
    this.audio.srcObject = null;
  }
}
