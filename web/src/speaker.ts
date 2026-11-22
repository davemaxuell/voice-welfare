import { workspaceText } from "./workspace-language.ts";
import { timing, type TimingPoint } from "./perf.ts";
// ⑥ 말하기: 서버 TTS를 문장 단위로 받아 이어 재생, 신호음.
import type { SessionState } from "../../src/core/turn.ts";
import { getSpeechLang, audioContext } from "./audio.ts";

/** 말하기 설정(세션 TurnResult·snapshot의 speechPrefs). 기본은 예전 고정값과 같다. */
export const speechPrefs: { rate: number; voice: string | null } = { rate: 1.25, voice: null };

export function applySpeechPrefs(p: { rate?: number; voice?: string | null } | null | undefined) {
  if (p == null) return;
  if (typeof p.rate === "number" && p.rate > 0) speechPrefs.rate = p.rate;
  speechPrefs.voice = p.voice !== undefined && p.voice !== null && p.voice.length > 0 ? p.voice : null;
}

// 실제로 소리가 나기 시작하고 그칠 때만 알린다(합성 요청을 기다리는 동안은 말하는 중이 아니다). 아바타 입 모양이 이것을 따른다.
const speakingListeners = new Set<(speaking: boolean) => void>();
let speakingNow = false;
function notifySpeaking() {
  const now = isSpeaking();
  if (now === speakingNow) return;
  speakingNow = now;
  for (const cb of speakingListeners) cb(now);
}
export function onSpeaking(cb: (speaking: boolean) => void) {
  speakingListeners.add(cb);
  return () => { speakingListeners.delete(cb); };
}

let source: AudioBufferSourceNode | undefined;
let playToken = 0;
/** 긴 안내를 문장 단위로 나눈다(첫 문장을 먼저 합성해 바로 들려주기 위함). */
export function splitForSpeech(text: string, max = 140) {
  const sentences = text
    .replace(/\s+/g, " ")
    // 중국어·일본어 문장부호(。！？)는 뒤에 띄어쓰기가 없어도 나눈다
    .split(/(?<=[.!?。]|다\.|요\.)\s+|(?<=[。！？])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const chunks: string[] = [];
  for (const s of sentences) {
    const last = chunks[chunks.length - 1];
    // 첫 조각은 짧게 두어 빨리 시작하고, 이후 짧은 문장은 합쳐 요청 수를 줄인다.
    if (last !== undefined && last.length > 0 && chunks.length > 1 && last.length + s.length + 1 <= max) chunks[chunks.length - 1] = `${last} ${s}`;
    else chunks.push(s);
  }
  return chunks;
}
export type PlayResult = "played" | "cancelled" | "blocked";
async function playBuffer(c: AudioContext, data: ArrayBuffer, token: number, request?: TimingPoint): Promise<PlayResult> {
  if (token !== playToken) return "cancelled";
  if (c.state === "suspended") await c.resume().catch(() => undefined);
  if (c.state !== "running") return "blocked";
  const buffer = await c.decodeAudioData(data);
  if (token !== playToken) return "cancelled";
  const node = c.createBufferSource();
  node.buffer = buffer;
  node.connect(c.destination);
  source = node;
  utterance = token;
  // 끝까지 재생되거나 cancel()로 멈출 때 resolve (대화 모드는 말이 끝난 뒤에 다시 듣는다)
  await new Promise<void>((resolve) => {
    node.onended = () => resolve();
    node.start();
    timing?.measure(request, "first-audio");
    notifySpeaking();
  });
  if (source === node) source = undefined;
  notifySpeaking();
  return token === playToken ? "played" : "cancelled";
}
/** 끼어들기로 멈춘 안내를 이어 말할 때 쓴다(문장 조각 번호). */
export interface InterruptedSpeech { text: string; fromChunk: number; kind: "server" }
let interrupted: InterruptedSpeech | null = null;
let cancelDeviceSpeech: (() => void) | undefined;
export function isSpeakingOnDevice() {
  return cancelDeviceSpeech !== undefined;
}
// 문장 조각 사이(다음 조각을 받는 틈)도 한 번의 말로 본다: 첫 조각이 소리 나기 시작한 speak()의 번호
let utterance: number | null = null;

export type FetchAudio = (chunk: string, rate: number) => Promise<Blob>;

/** 서버 TTS 재생. 문장 단위로 다음 조각을 미리 받아 두며 이어서 재생한다. */
export const serverTts = {
  async speak(text: string, fetchAudio: FetchAudio, fromChunk = 0, rate = speechPrefs.rate): Promise<PlayResult> {
    this.cancel();
    interrupted = null;
    const token = playToken;
    const request = timing?.mark("speech-requested");
    const chunks = splitForSpeech(text);
    try {
      const c = audioContext();
      // 서버 음성도 말 빠르기 설정을 따르게 설정값을 함께 넘긴다
      const load = (i: number) => {
        const chunk = chunks[i];
        if (chunk === undefined || token !== playToken) return undefined;
        const pending = fetchAudio(chunk, rate).then((b) => b.arrayBuffer());
        // 미리 받은 조각이 재생 대기 중 실패해도 처리되지 않은 거부가 남지 않게 한다.
        pending.catch(() => undefined);
        return pending;
      };
      let next = load(fromChunk);
      for (let i = fromChunk; i < chunks.length && next !== undefined; i++) {
        const data = await next;
        next = load(i + 1); // 재생하는 동안 다음 문장 합성
        const r = await playBuffer(c, data, token, i === fromChunk ? request : undefined);
        if (r !== "played") {
          next?.catch(() => undefined);
          // 끼어들기로 멈춘 자리(이 조각부터 다시)
          if (token !== playToken) interrupted = { text, fromChunk: i, kind: "server" };
          return r;
        }
      }
      return "played";
    } catch (e) {
      if (token !== playToken) return "cancelled";
      throw e;
    } finally {
      if (utterance === token) {
        utterance = null;
        notifySpeaking();
      }
    }
  },
  cancel() {
    playToken++;
    cancelDeviceSpeech?.();
    utterance = null;
    try {
      source?.stop();
    } catch {
      /* 이미 끝남 */
    }
    source = undefined;
    notifySpeaking();
  },
};

export type DeviceSpeech = "played" | "cancelled" | "unavailable";
export async function speakOnDevice(text: string, lang: string, rate = speechPrefs.rate): Promise<DeviceSpeech> {
  serverTts.cancel();
  const request = timing?.mark("speech-requested");
  interrupted = null;
  const token = playToken;
  const synth = "speechSynthesis" in window ? window.speechSynthesis : undefined;
  if (synth === undefined || !("SpeechSynthesisUtterance" in window)) return "unavailable";
  if (synth.getVoices().length === 0) {
    await new Promise<void>(resolve => {
      const ready = () => {
        clearTimeout(timer);
        synth.removeEventListener("voiceschanged", ready);
        resolve();
      };
      const timer = setTimeout(ready, 1000);
      synth.addEventListener("voiceschanged", ready);
    });
  }
  if (playToken !== token) return "cancelled";
  const voice = synth.getVoices().find(v =>
    v.localService && v.lang.toLowerCase().split(/[-_]/)[0] === lang);
  if (voice === undefined) return "unavailable";
  const line = new SpeechSynthesisUtterance(text);
  line.voice = voice;
  line.lang = voice.lang;
  line.rate = rate;
  return new Promise<DeviceSpeech>(resolve => {
    const finish = (status: DeviceSpeech) => {
      if (cancelDeviceSpeech !== cancel) return;
      cancelDeviceSpeech = undefined;
      utterance = null;
      notifySpeaking();
      resolve(status);
    };
    const cancel = () => {
      line.onend = line.onerror = null;
      try {
        synth.cancel();
      } finally {
        finish("cancelled");
      }
    };
    cancelDeviceSpeech = cancel;
    if (request !== undefined) line.onstart = () => { timing?.measure(request, "first-audio"); };
    line.onend = () => finish("played");
    line.onerror = () => finish("unavailable");
    // Mute the microphone before the operating system starts speaking.
    utterance = token;
    notifySpeaking();
    try {
      synth.speak(line);
    } catch {
      finish("unavailable");
    }
  });
}

/** 끼어들기 직후: 멈춘 안내를 이어 말할 수 있으면 그 상태, 없으면 null. */
export function takeInterruptedSpeech() {
  const s = interrupted;
  interrupted = null;
  return s;
}
/** 지금 안내 소리를 내는 중인지(진행 안내가 다른 말 위에 겹치지 않게) */
export function isSpeaking() {
  return source !== undefined || utterance !== null;
}
/** 신호음 종류: start 대화시작 · listen 이제말하세요 · done 다들었어요 · thinking 생각중 · working 일하는중 · approve 승인필요 · handoff 직접해주세요 · success 모의접수완료 · problem 문제 · stopped 멈춤 · end 대화끝 · reminder 기한알림 */
export const CUE_KINDS = [
  "start",
  "listen",
  "done",
  "thinking",
  "working",
  "approve",
  "handoff",
  "success",
  "problem",
  "stopped",
  "end",
  "reminder",
] as const;
export type CueKind = typeof CUE_KINDS[number];
/** 마이크가 열려 있을 때 나는 신호음(멈춤 듣기·박수 감지기에 조심) */
export const MIC_OPEN_CUES: readonly string[] = ["done", "thinking", "working", "stopped"];
const FILE_CUES: Partial<Record<CueKind, string>> = {
  start: "/cues/start.ogg",
  listen: "/cues/listen.ogg",
  done: "/cues/done.ogg",
  working: "/cues/working.ogg",
  approve: "/cues/notification.ogg",
  reminder: "/cues/notification.ogg",
  stopped: "/cues/stopped.ogg",
};
const cueBuffers = new Map<string, AudioBuffer>();
let preloadPromise: Promise<void> | undefined;
/** 파일 신호음을 미리 받아 풀어 둔다(여러 번 불러도 한 번만). */
export function preloadCues() {
  if (preloadPromise !== undefined) return preloadPromise;
  const urls = [...new Set(Object.values(FILE_CUES))];
  preloadPromise = (async () => {
    const c = audioContext();
    await Promise.all(urls.map(async (url) => {
      if (cueBuffers.has(url)) return;
      const res = await fetch(url);
      if (!res.ok) throw new Error(workspaceText("신호음 파일을 못 읽었습니다: {name}", getSpeechLang(), { name: url }));
      const buf = await c.decodeAudioData(await res.arrayBuffer());
      cueBuffers.set(url, buf);
    }));
  })().catch((e: unknown) => {
    preloadPromise = undefined;
    throw e;
  });
  return preloadPromise;
}
const N = { Fs4: 369.99, A4: 440, C5: 523.25, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5 };
type Partials = [number, number][];
const BELL: Partials = [
  [2, 0.2],
  [3, 0.05],
];
interface Tone { f: number; to?: number; glide?: number; dur: number; type?: OscillatorType; gain?: number; attack?: number; partials?: Partials }
function tone(c: BaseAudioContext, out: AudioNode, t: number, { f, to, glide, dur, type = "sine", gain = 0.22, attack = 0.02, partials = [] }: Tone) {
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(out);
  const all: Partials = [[1, 1], ...partials];
  for (const [ratio, rel] of all) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f * ratio, t);
    if (to !== undefined && to !== 0) o.frequency.exponentialRampToValueAtTime(to * ratio, t + (glide ?? dur));
    const pg = c.createGain();
    pg.gain.value = rel;
    o.connect(pg).connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  return t + dur;
}
function echo(c: BaseAudioContext, out: AudioNode, life: number, delay = 0.12, feedback = 0.22) {
  const input = c.createGain();
  const d = c.createDelay(1);
  d.delayTime.value = delay;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2500;
  const fb = c.createGain();
  fb.gain.value = feedback;
  input.connect(out);
  input.connect(d);
  d.connect(lp).connect(fb);
  fb.connect(d);
  fb.connect(out);
  if (!(typeof OfflineAudioContext !== "undefined" && c instanceof OfflineAudioContext)) {
    setTimeout(() => {
      fb.disconnect();
      d.disconnect();
    }, (life + 1.5) * 1000);
  }
  return input;
}
type Synth = (c: BaseAudioContext, out: AudioNode, t: number) => number;
const SYNTH: Partial<Record<CueKind, Synth>> = {
  thinking: (c, out, t) => tone(c, out, t, { f: 330, to: 700, glide: 0.1, dur: 0.15, partials: [[2, 0.1]] }),
  handoff: (c, out, t) => {
    const o = echo(c, out, 1.1);
    tone(c, o, t, { f: N.E5, dur: 0.5, gain: 0.2, partials: [
      [2, 0.25],
      [3, 0.08],
    ] });
    return tone(c, o, t + 0.32, { f: N.C5, dur: 0.75, gain: 0.2, partials: [
      [2, 0.25],
      [3, 0.08],
    ] });
  },
  success: (c, out, t) => {
    const o = echo(c, out, 0.8);
    tone(c, o, t, { f: N.C5, dur: 0.14 });
    tone(c, o, t + 0.07, { f: N.E5, dur: 0.14 });
    tone(c, o, t + 0.14, { f: N.G5, dur: 0.14 });
    return tone(c, o, t + 0.21, { f: N.C6, dur: 0.55, partials: BELL });
  },
  problem: (c, out, t) => {
    tone(c, out, t, { f: N.A4, dur: 0.16, type: "triangle", gain: 0.2 });
    return tone(c, out, t + 0.15, { f: N.Fs4, dur: 0.26, type: "triangle", gain: 0.2 });
  },
  end: (c, out, t) => {
    tone(c, out, t, { f: N.A5, to: N.A4, dur: 0.16, gain: 0.18 });
    return tone(c, out, t + 0.12, { f: N.A4, dur: 0.3, partials: BELL });
  },
};
/** 신호음 하나를 스케줄하고 끝나는 시각(초)을 돌려준다. 파일 종류는 preloadCues 뒤여야 한다. */
export function renderCue(kind: CueKind, ctx: BaseAudioContext, dest: AudioNode, t: number) {
  const url = FILE_CUES[kind];
  if (url !== undefined) {
    const buf = cueBuffers.get(url);
    if (buf === undefined) return t;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(dest);
    node.start(t);
    return t + buf.duration;
  }
  const synth = SYNTH[kind];
  return synth !== undefined ? synth(ctx, dest, t) : t;
}
/**
 * 화면을 보지 않아도 알 수 있는 짧은 신호음.
 * AudioContext가 잠겨 있으면 바로 끝난다.
 */
export async function earcon(kind: CueKind) {
  const c = audioContext();
  if (c.state !== "running") return;
  try {
    await preloadCues();
  } catch {
    return;
  }
  const start = c.currentTime + 0.01;
  const end = renderCue(kind, c, c.destination, start);
  const ms = Math.max(0, (end - c.currentTime) * 1000) + 40;
  await new Promise((r) => setTimeout(r, ms));
}
/** 결과 상태가 바뀌었을 때만 신호음 종류를 돌려준다. */
export function transitionCue(prev: SessionState, next: SessionState): CueKind | undefined {
  if (prev === next) return undefined;
  if (next === "WAITING_FOR_USER_CONFIRMATION") return "approve";
  if (next === "AUTH_HANDOFF") return "handoff";
  if (next === "MOCK_SUBMITTED") return "success";
  if (next === "RECOVERING" || next === "VALIDATION_ERROR") return "problem";
  if (next === "STOPPED") return "stopped";
  return undefined;
}
