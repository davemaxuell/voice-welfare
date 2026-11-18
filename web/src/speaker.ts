import type { Lang, SessionState, SpeechPrefs } from "../../src/core/turn.ts";
import { raceAbort } from "../../src/core/abort.ts";
import type { ProgressReport } from "./api.ts";
type Tone = { f: number; to?: number; glide?: number; dur: number; type?: OscillatorType; gain?: number; attack?: number; partials?: [number, number][] };
type Synth = (context: BaseAudioContext, out: AudioNode, start: number) => number;
// ⑥ 말하기: 브라우저 음성 합성, 서버 TTS를 문장 단위로 받아 이어 재생, 신호음.
import { audioContext, BCP47, getSpeechLang } from './audio.ts';

/** 말하기 설정(세션 TurnResult·snapshot의 speechPrefs). 기본은 예전 고정값과 같다. */
export const speechPrefs: {rate: number; voice: string | null} = { rate: 1.25, voice: null };

export function applySpeechPrefs(p: SpeechPrefs) {
    if (typeof p.rate === 'number' && p.rate > 0) speechPrefs.rate = p.rate;
    speechPrefs.voice = p.voice === undefined || p.voice.length === 0 ? null : p.voice;
}

function pickVoice(lang: Lang) {
    if (speechPrefs.voice === null || speechPrefs.voice.length === 0 || !('speechSynthesis' in window)) return undefined;
    const want = speechPrefs.voice.toLowerCase();
    const voices = window.speechSynthesis.getVoices();
    const tag = BCP47[lang].toLowerCase();
    const match = voices.find(v => v.name.toLowerCase().includes(want) && v.lang.toLowerCase().startsWith(tag.slice(0, 2)));
    return match ?? voices.find(v => v.name.toLowerCase().includes(want));
}

function utter(text: string) {
    const u = new SpeechSynthesisUtterance(text);
    const lang = getSpeechLang();
    u.lang = BCP47[lang];
    u.rate = speechPrefs.rate;
    const v = pickVoice(lang);
    if (v) u.voice = v;
    return u;
}

let browserTimer: ReturnType<typeof setTimeout> | undefined;
let finishBrowser: (() => void) | undefined;

export const browserTts = {
    supported: typeof window !== 'undefined' && 'speechSynthesis' in window,
    speak(text: string) {
        void this.speakAndWait(text);
    },
    speakAndWait(text: string): Promise<void> {
        if (!this.supported) return Promise.resolve();
        const synth = window.speechSynthesis;
        const busy = synth.speaking || synth.pending;
        this.cancel();
        const line = utter(text);
        return new Promise(resolve => {
            const finish = () => {
                if (finishBrowser === finish) finishBrowser = undefined;
                resolve();
            };
            finishBrowser = finish;
            line.onend = line.onerror = finish;
            // Chrome은 cancel() 직후의 speak()를 무시할 수 있다.
            browserTimer = setTimeout(() => {
                browserTimer = undefined;
                synth.speak(line);
            }, busy ? 80 : 0);
        });
    },
    cancel() {
        clearTimeout(browserTimer);
        browserTimer = undefined;
        finishBrowser?.();
        if (this.supported) window.speechSynthesis.cancel();
    },
};

let source: AudioBufferSourceNode | undefined;
/** 긴 안내를 문장 단위로 나눈다(첫 문장을 먼저 합성해 바로 들려주기 위함). */
export function splitForSpeech(text: string, max = 140) {
    const sentences = text
        .replace(/\s+/g, ' ')
        // 중국어·일본어 문장부호(。！？)는 뒤에 띄어쓰기가 없어도 나눈다
        .split(/(?<=[.!?。]|다\.|요\.)\s+|(?<=[。！？])/)
        .map((s) => s.trim())
        .filter(Boolean);
    const chunks: string[] = [];
    for (const s of sentences) {
        const last = chunks[chunks.length - 1];
        // 첫 조각은 짧게 두어 빨리 시작하고, 이후 짧은 문장은 합쳐 요청 수를 줄인다.
        if (last !== undefined && chunks.length > 1 && last.length + s.length + 1 <= max)
            chunks[chunks.length - 1] = `${last} ${s}`;
        else
            chunks.push(s);
    }
    return chunks;
}
async function playBuffer(c: AudioContext, data: ArrayBuffer, signal: AbortSignal) {
    if (c.state === 'suspended') await c.resume().catch(() => undefined);
    signal.throwIfAborted();
    if (c.state !== 'running') return 'blocked';
    const buffer = await c.decodeAudioData(data);
    signal.throwIfAborted();
    const node = c.createBufferSource();
    node.buffer = buffer;
    node.connect(c.destination);
    source = node;
    const cleanup = new AbortController();
    try {
        await new Promise<void>((resolve, reject) => {
            node.onended = () => resolve();
            signal.addEventListener('abort', () => { node.stop(); resolve(); }, { once: true, signal: cleanup.signal });
            try { node.start(); } catch (error) { reject(error); }
        });
        return 'played';
    } finally {
        cleanup.abort();
        node.disconnect();
        if (source === node) source = undefined;
    }
}

type SpeechPosition = {text: string; fromChunk: number; kind: 'server'};
let playback: { controller: AbortController; position: SpeechPosition } | undefined;
let interrupted: SpeechPosition | null = null;

export const serverTts = {
    async speak(text: string, fetchAudio: (chunk: string, signal: AbortSignal) => Promise<Blob>, fromChunk = 0) {
        this.cancel();
        interrupted = null;
        const controller = new AbortController();
        const position: SpeechPosition = { text, fromChunk, kind: 'server' };
        playback = { controller, position };
        const signal = controller.signal;
        const chunks = splitForSpeech(text);
        const load = (i: number) => {
            const chunk = chunks[i];
            if (chunk === undefined) return undefined;
            const promise = fetchAudio(chunk, signal).then(b => b.arrayBuffer());
            // 다음 문장이 재생 대기 중에 실패해도 미처리 거절을 내지 않는다.
            void promise.catch(() => undefined);
            return promise;
        };
        try {
            return await raceAbort(async () => {
                const c = audioContext();
                let next = load(fromChunk);
                for (let i = fromChunk; next !== undefined; i++) {
                    position.fromChunk = i;
                    const data = await next;
                    signal.throwIfAborted();
                    next = load(i + 1);
                    const result = await playBuffer(c, data, signal);
                    signal.throwIfAborted();
                    if (result === 'blocked') return 'blocked' as const;
                }
                return 'played' as const;
            }, signal);
        } catch {
            return signal.aborted ? 'cancelled' as const : 'failed' as const;
        } finally {
            if (playback?.controller === controller) playback = undefined;
            controller.abort();
        }
    },
    cancel() {
        if (playback === undefined) return;
        interrupted = { ...playback.position };
        playback.controller.abort();
        playback = undefined;
    },
};
/** 끼어들기 직후: 멈춘 안내를 이어 말할 수 있으면 그 상태, 없으면 null. */
export function takeInterruptedSpeech() {
    const s = interrupted;
    interrupted = null;
    return s;
}
/** 지금 안내 소리를 내는 중인지(진행 안내가 다른 말 위에 겹치지 않게) */
export function isSpeaking() {
    return source !== undefined || (browserTts.supported && window.speechSynthesis.speaking);
}
const PROGRESS_GAP_MS = 15000;
/**
 * 진행 안내: 서버가 알려 준 목표 수행 단계 가운데 가장 최근 것을 15초에 한 번까지만 말한다.
 * 사용자가 말하는 중이거나 이미 안내 중이면 이번에는 건너뛴다. 일을 시작하고 15초 안에는 말하지 않는다(금방 끝나는 일은 답만 듣게).
 */
export const progressVoice = {
    seen: 0,
    at: 0,
    start() {
        this.at = Date.now();
    },
    /** p = GET /api/session/{id}/progress. 지금 말할 문장(없으면 undefined). quiet = 사용자가 말하는 중이거나 다른 안내 중 */
    pick(p: ProgressReport, quiet: boolean) {
        if (!p.running || !p.spoken || (p.latest?.length ?? 0) === 0 || p.seq <= this.seen)
            return undefined;
        if (quiet || isSpeaking() || Date.now() - this.at < PROGRESS_GAP_MS)
            return undefined;
        this.seen = p.seq;
        this.at = Date.now();
        return p.latest;
    },
};
/** 신호음 종류: start 대화시작 · listen 이제말하세요 · done 다들었어요 · thinking 생각중 · working 일하는중 · approve 승인필요 · handoff 직접해주세요 · success 모의접수완료 · problem 문제 · stopped 멈춤 · end 대화끝 · reminder 기한알림 */
export const CUE_KINDS = [
    'start',
    'listen',
    'done',
    'thinking',
    'working',
    'approve',
    'handoff',
    'success',
    'problem',
    'stopped',
    'end',
    'reminder',
] as const;
export type CueKind = typeof CUE_KINDS[number];
/** 마이크가 열려 있을 때 나는 신호음(멈춤 듣기·박수 감지기에 조심) */
export const MIC_OPEN_CUES = ['done', 'thinking', 'working', 'stopped'];
const FILE_CUES: Partial<Record<CueKind, string>> = {
    start: '/cues/start.ogg',
    listen: '/cues/listen.ogg',
    done: '/cues/done.ogg',
    working: '/cues/working.ogg',
    approve: '/cues/notification.ogg',
    reminder: '/cues/notification.ogg',
    stopped: '/cues/stopped.ogg',
};
const cueBuffers = new Map<string, AudioBuffer>();
let preloadPromise: Promise<void> | undefined;
/** 파일 신호음을 미리 받아 풀어 둔다(여러 번 불러도 한 번만). */
export function preloadCues() {
    if (preloadPromise)
        return preloadPromise;
    const urls = [...new Set(Object.values(FILE_CUES))];
    preloadPromise = (async () => {
        const c = audioContext();
        await Promise.all(urls.map(async (url) => {
            if (cueBuffers.has(url))
                return;
            const res = await fetch(url);
            if (!res.ok)
                throw new Error(`신호음 파일을 못 읽었습니다: ${url}`);
            const buf = await c.decodeAudioData(await res.arrayBuffer());
            cueBuffers.set(url, buf);
        }));
    })().catch((e) => {
        preloadPromise = undefined;
        throw e;
    });
    return preloadPromise;
}
const N = { Fs4: 369.99, A4: 440, C5: 523.25, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5 };
const BELL: [number, number][] = [
    [2, 0.2],
    [3, 0.05],
];
function tone(c: BaseAudioContext, out: AudioNode, t: number, { f, to, glide, dur, type = 'sine', gain = 0.22, attack = 0.02, partials = [] }: Tone) {
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    for (const [ratio, rel] of [[1, 1] as const, ...partials]) {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(f * ratio, t);
        if (to !== undefined)
            o.frequency.exponentialRampToValueAtTime(to * ratio, t + (glide ?? dur));
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
    lp.type = 'lowpass';
    lp.frequency.value = 2500;
    const fb = c.createGain();
    fb.gain.value = feedback;
    input.connect(out);
    input.connect(d);
    d.connect(lp).connect(fb);
    fb.connect(d);
    fb.connect(out);
    if (!(typeof OfflineAudioContext !== 'undefined' && c instanceof OfflineAudioContext)) {
        setTimeout(() => {
            fb.disconnect();
            d.disconnect();
        }, (life + 1.5) * 1000);
    }
    return input;
}
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
        tone(c, out, t, { f: N.A4, dur: 0.16, type: 'triangle', gain: 0.2 });
        return tone(c, out, t + 0.15, { f: N.Fs4, dur: 0.26, type: 'triangle', gain: 0.2 });
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
        if (!buf)
            return t;
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.connect(dest);
        node.start(t);
        return t + buf.duration;
    }
    const synth = SYNTH[kind];
    return synth ? synth(ctx, dest, t) : t;
}
/**
 * 화면을 보지 않아도 알 수 있는 짧은 신호음.
 * AudioContext가 잠겨 있으면 바로 끝난다.
 */
export async function earcon(kind: CueKind, active = () => true) {
    let c: AudioContext;
    try {
        c = audioContext();
        if (c.state !== 'running' || !active()) return;
        await preloadCues();
    }
    catch (e) {
        console.warn('[cue] 신호음 파일을 불러오지 못했습니다', e);
        return;
    }
    if (!active()) return;
    const start = c.currentTime + 0.01;
    const end = renderCue(kind, c, c.destination, start);
    const ms = Math.max(0, (end - c.currentTime) * 1000) + 40;
    await new Promise((r) => setTimeout(r, ms));
}
/** 결과 상태가 바뀌었을 때만 신호음 종류를 돌려준다. */
export function transitionCue(prev: SessionState, next: SessionState): CueKind | undefined {
    if (prev === next)
        return undefined;
    if (next === 'WAITING_FOR_USER_CONFIRMATION')
        return 'approve';
    if (next === 'AUTH_HANDOFF')
        return 'handoff';
    if (next === 'MOCK_SUBMITTED')
        return 'success';
    if (next === 'RECOVERING' || next === 'VALIDATION_ERROR')
        return 'problem';
    if (next === 'STOPPED')
        return 'stopped';
    return undefined;
}
