import { workspaceText } from "./workspace-language.ts";
import { timing } from "./perf.ts";
// ① 마이크 녹음과 핸즈프리 VAD. 받아쓰기는 서버의 음성 API가 맡는다.
import { getSpeechLang, audioContext } from "./audio.ts";
import clapWorkletUrl from "./clap-worklet.ts?worker&url";
import pcmWorkletUrl from "./pcm-worklet.ts?worker&url";
import { isSpeakingOnDevice, onSpeaking } from "./speaker.ts";

/** 실시간 받아쓰기 연결 하나(api.liveAudio). 보낸 소리의 받아쓰기는 서버에 남고 여기에는 영수증만 온다. */
export interface LiveAudio {
  append(frame: ArrayBuffer): void;
  commit(): Promise<string>;
  cancel(): void;
}
export type OpenLive = () => LiveAudio;

interface PcmInput {
  analyser: AnalyserNode;
  onFrame?: ((frame: ArrayBuffer) => void) | undefined;
  flush(): Promise<void>;
  close(): void;
}

// The hardware stream is resampled by Web Audio before the worklet packs it for Realtime.
async function pcmInput(stream: MediaStream, captureChanged?: () => void): Promise<PcmInput> {
  const context = new AudioContext({ sampleRate: 24000 });
  // Mute at capture so dictation, barge-in pre-roll, and existing uploads all receive silence.
  const syncMic = () => {
    for (const track of stream.getAudioTracks()) track.enabled = !isSpeakingOnDevice();
    captureChanged?.();
  };
  const stopWatching = onSpeaking(syncMic);
  syncMic();
  try {
    await context.audioWorklet.addModule(pcmWorkletUrl);
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const node = new AudioWorkletNode(context, "microphone-pcm", {
      numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit",
    });
    source.connect(analyser);
    source.connect(node);
    let flushed: (() => void) | undefined;
    const mic: PcmInput = {
      analyser,
      flush() {
        return new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 150);
          flushed = () => { clearTimeout(timer); resolve(); };
          node.port.postMessage("flush");
        });
      },
      close() {
        stopWatching();
        flushed?.();
        node.port.onmessage = null;
        node.port.close();
        node.disconnect();
        source.disconnect();
        void context.close();
      },
    };
    node.port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (data === "flushed") flushed?.();
      else if (data instanceof ArrayBuffer) mic.onFrame?.(data);
    };
    return mic;
  } catch (error) {
    stopWatching();
    await context.close();
    throw error;
  }
}

async function openMicrophone(deviceId: string | undefined, audio: MediaTrackConstraints = {}) {
  const request = timing?.mark("microphone-requested");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId !== undefined && deviceId.length > 0 ? { ...audio, deviceId: { exact: deviceId } } : Object.keys(audio).length > 0 ? audio : true,
  });
  if (request !== undefined && stream.getAudioTracks().some(track => track.readyState === "live")) timing?.measure(request, "track-live");
  return stream;
}

export interface Recording {
  stop(): Promise<LiveAudio>;
  cancel(): void;
}

export async function startRecording(openLive: OpenLive, deviceId: string | undefined, onMax: () => void,
  acquired?: (stream: MediaStream) => boolean, captureChanged?: () => void): Promise<Recording> {
  const stream = await openMicrophone(deviceId);
  if (acquired?.(stream) === false) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error("stopped");
  }
  for (const track of stream.getAudioTracks()) {
    track.onmute = track.onunmute = track.onended = () => captureChanged?.();
  }
  let mic: PcmInput | undefined;
  let live: LiveAudio;
  try {
    mic = await pcmInput(stream, captureChanged);
    live = openLive();
  } catch (error) {
    mic?.close();
    stream.getTracks().forEach(track => track.stop());
    throw error;
  }
  const input = mic;
  input.onFrame = frame => live.append(frame);
  const timer = setTimeout(onMax, 15000);
  let closed = false;
  function release() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    input.close();
    stream.getTracks().forEach(track => track.stop());
    captureChanged?.();
  }
  return {
    async stop() { clearTimeout(timer); await input.flush(); release(); return live; },
    cancel() { live.cancel(); release(); },
  };
}

export class VoiceLoop {
  /** 말 끝 판단: 짧은 말은 빨리, 길게 말하는 중에는 잠깐 쉬어도 끊지 않는다. */
  // 말 끝 판단: 한국어는 말 중간에 "음…" 하고 쉬는 일이 많아 넉넉히 기다린다(급하면 스페이스·"지금 말하기"로 바로 보냄)
  static SILENCE_SHORT_MS = 1500;
  static SILENCE_LONG_MS = 2000;
  static MIN_SPEECH_MS = 200;
  static MAX_UTTERANCE_MS = 25000;

  openLive: OpenLive;
  noiseFloor = 0.01;
  stopped = false;
  stream: MediaStream | undefined;
  mic: PcmInput | undefined;
  analyser: AnalyserNode | undefined;
  /** 청음이 말하는 동안은 앞 소리(pre-roll)를 모으지 않는다. */
  ignore: (() => boolean) | undefined;
  onTrouble: ((reason: "ended" | "muted" | "unmuted") => void) | undefined;
  captureChanged?: () => void;
  abort: (() => void) | undefined;
  finishNow: (() => boolean) | undefined;
  bargeFrames: ArrayBuffer[] | undefined;
  clapSession: AbortController | undefined;

  constructor(openLive: OpenLive) {
    this.openLive = openLive;
  }
  async start(deviceId?: string) {
    this.stopped = false;
    const stream = await openMicrophone(deviceId, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    if (this.stopped) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error("stopped");
    }
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (track !== undefined) {
      track.onended = () => this.onTrouble?.("ended");
      track.onmute = () => this.onTrouble?.("muted");
      track.onunmute = () => this.onTrouble?.("unmuted");
    }
    const mic = await pcmInput(stream, this.captureChanged);
    if (this.stopped) { mic.close(); throw new Error("stopped"); }
    this.mic = mic;
    this.analyser = mic.analyser;
    this.noiseFloor = await this.measure(400);
  }
  /** 지금 쓰는 마이크 이름(권한을 받은 뒤에만 알 수 있음) */
  get deviceLabel() {
    return this.stream?.getAudioTracks()[0]?.label ?? "";
  }
  /** 마이크에서 아무 소리도 안 들어오는지(완전한 0) — 연결 끊김의 흔한 증상 */
  async isSilent(ms = 600) {
    return (await this.measure(ms)) === 0;
  }
  level() {
    if (this.analyser === undefined) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  }
  async measure(ms: number) {
    const samples: number[] = [];
    const end = Date.now() + ms;
    while (Date.now() < end) {
      samples.push(this.level());
      await new Promise((r) => setTimeout(r, 30));
    }
    return samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  }
  // Keep a short local pre-roll. Send audio only after the user starts speaking.
  listenOnce(onSpeechStart?: () => void, preRoll: ArrayBuffer[] = []): Promise<LiveAudio | null> {
    if (this.mic === undefined) return Promise.resolve(null);
    const mic = this.mic;
    const threshold = Math.max(0.01, this.noiseFloor * 2.5);
    return new Promise(resolve => {
      let live: LiveAudio | undefined;
      let loudMs = 0, silenceMs = 0, spokenMs = 0, startedAt = 0;
      const begin = () => {
        const opened = this.openLive();
        live = opened;
        startedAt = Date.now();
        for (const frame of preRoll) opened.append(frame);
        preRoll.length = 0;
        onSpeechStart?.();
      };
      mic.onFrame = frame => {
        if (live !== undefined) live.append(frame);
        else if (this.ignore?.() !== true) {
          preRoll.push(frame);
          if (preRoll.length > 12) preRoll.shift();
        }
      };
      const finish = (send: boolean) => {
        clearInterval(timer);
        mic.onFrame = undefined;
        this.abort = this.finishNow = undefined;
        if (!send) live?.cancel();
        resolve(send ? live ?? null : null);
      };
      const timer = setInterval(() => {
        if (live === undefined && this.ignore?.() === true) { preRoll.length = 0; loudMs = 0; return; }
        const level = this.level();
        if (live === undefined) {
          loudMs = level > threshold ? loudMs + 50 : Math.max(0, loudMs - 50);
          if (loudMs >= VoiceLoop.MIN_SPEECH_MS) begin();
          return;
        }
        if (level > threshold) spokenMs += 50;
        silenceMs = level > threshold * 0.6 ? 0 : silenceMs + 50;
        const needed = spokenMs > 2500 ? VoiceLoop.SILENCE_LONG_MS : VoiceLoop.SILENCE_SHORT_MS;
        if (silenceMs >= needed || Date.now() - startedAt >= VoiceLoop.MAX_UTTERANCE_MS) finish(true);
      }, 50);
      this.abort = () => finish(false);
      this.finishNow = () => { if (live === undefined) return false; finish(true); return true; };
      if (preRoll.length > 0) begin();
    });
  }

  watchBargeIn(onBargeIn: () => void) {
    if (this.mic === undefined) return () => {};
    let bleed = this.noiseFloor, loudMs = 0, heard = false;
    const mic = this.mic;
    const ring: ArrayBuffer[] = [];
    this.bargeFrames = undefined;
    mic.onFrame = frame => { ring.push(frame); if (ring.length > 12) ring.shift(); };
    const timer = setInterval(() => {
      const level = this.level();
      if (level > Math.max(0.02, bleed * 2.2, this.noiseFloor * 4)) loudMs += 50;
      else { loudMs = Math.max(0, loudMs - 50); bleed = bleed * 0.9 + level * 0.1; }
      if (loudMs >= 300) {
        heard = true;
        clearInterval(timer);
        onBargeIn();
      }
    }, 50);
    return () => {
      clearInterval(timer);
      mic.onFrame = undefined;
      this.bargeFrames = heard ? ring : undefined;
    };
  }

  async listenAfterBarge(_maxMs: number, onSpeechStart?: () => void) {
    const frames = this.bargeFrames;
    this.bargeFrames = undefined;
    return frames !== undefined && frames.length > 0 ? this.listenOnce(onSpeechStart, frames) : null;
  }
  /** 사용자가 말을 마쳤다고 알림 → 바로 보낸다. 말을 시작하기 전이면 false */
  endUtterance() {
    return this.finishNow?.() ?? false;
  }
  /**
   * 박수 두 번 감지. 소음 제거가 박수를 지우므로 별도의 원음 스트림을 쓴다.
   * 짧고 큰 소리(봉우리)가 0.15~0.8초 간격으로 두 번이면 onDoubleClap.
   */
  async startClapDetector(onDoubleClap: () => void, deviceId?: string) {
    this.clapSession?.abort();
    const session = new AbortController();
    this.clapSession = session;
    let stream: MediaStream | undefined, source: MediaStreamAudioSourceNode | undefined, node: AudioWorkletNode | undefined;
    const release = () => {
      if (node !== undefined) {
        node.port.onmessage = null;
        node.port.postMessage("stop");
        node.port.close();
        node.disconnect();
      }
      source?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
    };
    try {
      const context = audioContext();
      await context.audioWorklet.addModule(clapWorkletUrl);
      if (session.signal.aborted) return;
      stream = await openMicrophone(deviceId, { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
      if (session.signal.aborted) {
        release();
        return;
      }
      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, "double-clap", {
        numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit",
      });
      node.port.onmessage = ({ data: at }: MessageEvent<unknown>) => {
        if (!session.signal.aborted && typeof at === "number" && context.currentTime - at < 0.8) onDoubleClap();
      };
      source.connect(node);
      session.signal.addEventListener("abort", release, { once: true });
    } catch {
      release(); // 박수 감지는 보조 기능: 실패해도 대화는 계속
    }
  }
  cancelListening() {
    this.abort?.();
  }
  stop() {
    this.stopped = true;
    this.cancelListening();
    this.clapSession?.abort();
    this.clapSession = undefined;
    this.mic?.close();
    this.mic = undefined;
    this.bargeFrames = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.analyser = undefined;
  }
}
/** 마이크 목록. 아이폰 연속성 마이크처럼 끊기기 쉬운 장치보다 내장 마이크를 기본 추천한다. */
export async function listMicrophones() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d) => ({ id: d.deviceId, label: d.label.length > 0 ? d.label : workspaceText("이름 없는 마이크", getSpeechLang()) }));
}
export interface Microphone { id: string; label: string }
export function preferredMicrophone(mics: Microphone[]) {
  const builtIn = mics.find((m) => /(macbook|내장|built-?in|internal)/i.test(m.label));
  const notPhone = mics.find((m) => !/(iphone|휴대폰|phone|continuity)/i.test(m.label));
  return (builtIn ?? notPhone ?? mics[0])?.id;
}
