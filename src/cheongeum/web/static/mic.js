// ① 듣기: 브라우저 음성 인식, 누르고 말하기 녹음, 핸즈프리 VAD 루프(끼어들기·박수 두 번), 마이크 고르기.
import { audioContext, BCP47, getSpeechLang } from './audio.js';
const Recognition = typeof window !== 'undefined'
    ? (window.SpeechRecognition ??
        window.webkitSpeechRecognition)
    : undefined;
export const browserStt = {
    supported: !!Recognition,
    listen(onText, onError, onEnd) {
        if (!Recognition) {
            onError('이 브라우저는 음성 인식을 지원하지 않습니다. 텍스트로 입력해 주세요.');
            onEnd();
            return () => undefined;
        }
        const r = new Recognition();
        r.lang = BCP47[getSpeechLang()];
        r.interimResults = false;
        r.maxAlternatives = 1;
        r.onresult = (e) => onText(e.results[0]?.[0]?.transcript ?? '');
        r.onerror = (e) => onError(`음성 인식 오류: ${e.error}`);
        r.onend = onEnd;
        r.start();
        return () => r.stop();
    },
};
/** 서버 STT용 녹음(누르고 말하기). 최대 길이에 도달하면 자동으로 멈춘다. */
export async function startRecording(maxMs = 15000) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    const finished = new Promise((resolve) => {
        recorder.onstop = () => {
            stream.getTracks().forEach((t) => t.stop());
            resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        };
    });
    recorder.start();
    const timer = setTimeout(() => recorder.state === 'recording' && recorder.stop(), maxMs);
    return {
        stop() {
            clearTimeout(timer);
            if (recorder.state === 'recording')
                recorder.stop();
            return finished;
        },
        cancel() {
            clearTimeout(timer);
            chunks.length = 0;
            if (recorder.state === 'recording')
                recorder.stop();
        },
    };
}
/**
 * 핸즈프리 듣기: 마이크 음량으로 말의 시작과 끝을 감지(VAD)해 한 발화씩 녹음한다.
 * AI가 말하는 동안에는 듣지 않는다(스피커 소리를 다시 인식하는 것 방지).
 */
export class VoiceLoop {
    constructor() {
        this.noiseFloor = 0.01;
    }
    async start(deviceId) {
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            },
        });
        const track = this.stream.getAudioTracks()[0];
        track.onended = () => this.onTrouble?.('ended');
        track.onmute = () => this.onTrouble?.('muted');
        const c = audioContext();
        if (c.state === 'suspended')
            await c.resume();
        this.sourceNode = c.createMediaStreamSource(this.stream);
        this.analyser = c.createAnalyser();
        this.analyser.fftSize = 1024;
        this.sourceNode.connect(this.analyser);
        this.noiseFloor = await this.measure(400);
    }
    /** 지금 쓰는 마이크 이름(권한을 받은 뒤에만 알 수 있음) */
    get deviceLabel() {
        return this.stream?.getAudioTracks()[0]?.label ?? '';
    }
    /** 마이크에서 아무 소리도 안 들어오는지(완전한 0) — 연결 끊김의 흔한 증상 */
    async isSilent(ms = 600) {
        return (await this.measure(ms)) === 0;
    }
    level() {
        if (!this.analyser)
            return 0;
        const buf = new Float32Array(this.analyser.fftSize);
        this.analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf)
            sum += v * v;
        return Math.sqrt(sum / buf.length);
    }
    async measure(ms) {
        const samples = [];
        const end = Date.now() + ms;
        while (Date.now() < end) {
            samples.push(this.level());
            await new Promise((r) => setTimeout(r, 30));
        }
        return samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
    }
    /** 한 발화를 녹음해 돌려준다. stop()이 불리면 null. */
    listenOnce(onSpeechStart) {
        if (!this.stream)
            return Promise.resolve(null);
        const stream = this.stream;
        const threshold = Math.max(0.01, this.noiseFloor * 2.5); // 조용한 노트북 마이크도 감지되도록
        return new Promise((resolve) => {
            let recorder;
            let chunks = [];
            let speechMs = 0;
            let silenceMs = 0;
            let started = false;
            let spokenMs = 0;
            let startedAt = Date.now();
            let done = false;
            const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
            const begin = () => {
                const own = []; // 녹음기마다 별도 버퍼(재시작 시 이전 녹음 데이터가 섞이지 않게)
                chunks = own;
                recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
                recorder.ondataavailable = (e) => e.data.size > 0 && own.push(e.data);
                recorder.start(250);
                startedAt = Date.now();
                speechMs = 0;
                silenceMs = 0;
                started = false;
            };
            const finish = (send) => {
                if (done)
                    return;
                done = true;
                clearInterval(timer);
                this.abort = undefined;
                this.finishNow = undefined;
                recorder.onstop = () => resolve(send ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }) : null);
                if (recorder.state !== 'inactive')
                    recorder.stop();
                else
                    resolve(send ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }) : null);
            };
            begin();
            const tick = 50;
            const timer = setInterval(() => {
                const loud = this.level() > threshold;
                if (!started) {
                    speechMs = loud ? speechMs + tick : Math.max(0, speechMs - tick);
                    if (speechMs >= VoiceLoop.MIN_SPEECH_MS) {
                        started = true;
                        onSpeechStart?.();
                    }
                    else if (Date.now() - startedAt > VoiceLoop.IDLE_RESTART_MS) {
                        // 오래 조용하면 녹음을 새로 시작해 파일이 커지지 않게 한다.
                        recorder.onstop = null;
                        recorder.stop();
                        begin();
                    }
                    return;
                }
                // 말하기 시작한 뒤에는 더 낮은 기준으로 본다(작게 끝나는 말꼬리를 침묵으로 오인해 자르지 않게)
                const still = this.level() > threshold * 0.6;
                silenceMs = still ? 0 : silenceMs + tick;
                if (loud)
                    spokenMs += tick;
                const needed = spokenMs > 2500 ? VoiceLoop.SILENCE_LONG_MS : VoiceLoop.SILENCE_SHORT_MS;
                if (silenceMs >= needed || Date.now() - startedAt > VoiceLoop.MAX_UTTERANCE_MS)
                    finish(true);
            }, tick);
            this.abort = () => finish(false);
            // 말을 시작한 뒤에만 '말 끝' 신호를 받는다(시작 전이면 무시).
            this.finishNow = () => {
                if (!started)
                    return false;
                finish(true);
                return true;
            };
        });
    }
    /** 현재 듣기를 취소(녹음 버림). */
    /**
     * 끼어들기 감시: AI가 말하는 동안 사용자가 말하면 onBargeIn. 스피커 소리가 마이크로 새어 드는 수준을
     * 계속 따라가며 재고, 그보다 확실히 큰 소리가 0.3초 이상 이어질 때 사람 말로 본다.
     * 반환값을 호출하면 감시를 멈춘다.
     */
    watchBargeIn(onBargeIn) {
        if (!this.analyser)
            return () => undefined;
        // 스피커에서 새어 드는 소리(bleed)는 안내 소리가 실제로 나오기 시작한 뒤에도 계속 바뀌므로,
        // 사람 말로 보이지 않는 동안의 소리로 기준을 천천히 따라간다(처음 한 번만 재면 TTS가 늦게 시작할 때 틀어짐).
        let bleed = this.noiseFloor;
        let loudMs = 0;
        const timer = setInterval(() => {
            const lv = this.level();
            const threshold = Math.max(0.02, bleed * 2.2, this.noiseFloor * 4);
            if (lv > threshold) {
                loudMs += 50;
            }
            else {
                loudMs = Math.max(0, loudMs - 50);
                bleed = bleed * 0.9 + lv * 0.1;
            }
            if (loudMs >= 300) {
                clearInterval(timer);
                onBargeIn();
            }
        }, 50);
        return () => clearInterval(timer);
    }
    /** 사용자가 말을 마쳤다고 알림 → 바로 보낸다. 말을 시작하기 전이면 false */
    endUtterance() {
        return this.finishNow?.() ?? false;
    }
    /**
     * 박수 두 번 감지. 소음 제거가 박수를 지우므로 별도의 원음 스트림을 쓴다.
     * 짧고 큰 소리(봉우리)가 0.15~0.8초 간격으로 두 번이면 onDoubleClap.
     */
    async startClapDetector(onDoubleClap, deviceId) {
        try {
            this.clapStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
            });
        }
        catch {
            return; // 박수 감지는 보조 기능: 실패해도 대화는 계속
        }
        const c = audioContext();
        const src = c.createMediaStreamSource(this.clapStream);
        const an = c.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        const buf = new Float32Array(an.fftSize);
        let avg = 0.01;
        let lastPeakAt = 0;
        let firstClapAt = 0;
        this.clapTimer = setInterval(() => {
            an.getFloatTimeDomainData(buf);
            let peak = 0;
            let sum = 0;
            for (const v of buf) {
                peak = Math.max(peak, Math.abs(v));
                sum += v * v;
            }
            const rms = Math.sqrt(sum / buf.length);
            const now = Date.now();
            // 박수: 평소 소리보다 훨씬 큰 순간 봉우리(최소 0.3)이고 직전 봉우리와 120ms 이상 떨어짐
            const isClap = peak > Math.max(0.3, avg * 8) && peak / Math.max(rms, 1e-4) > 4 && now - lastPeakAt > 120;
            if (isClap) {
                lastPeakAt = now;
                const gap = now - firstClapAt;
                if (firstClapAt && gap >= 150 && gap <= 800) {
                    firstClapAt = 0;
                    onDoubleClap();
                }
                else {
                    firstClapAt = now;
                }
            }
            avg = avg * 0.95 + rms * 0.05;
        }, 20);
    }
    cancelListening() {
        this.abort?.();
    }
    stop() {
        this.cancelListening();
        if (this.clapTimer)
            clearInterval(this.clapTimer);
        this.clapStream?.getTracks().forEach((t) => t.stop());
        this.clapStream = undefined;
        this.sourceNode?.disconnect();
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = undefined;
        this.analyser = undefined;
    }
}
/** 말 끝 판단: 짧은 말은 빨리, 길게 말하는 중에는 잠깐 쉬어도 끊지 않는다. */
// 말 끝 판단: 한국어는 말 중간에 "음…" 하고 쉬는 일이 많아 넉넉히 기다린다(급하면 스페이스·"지금 말하기"로 바로 보냄)
VoiceLoop.SILENCE_SHORT_MS = 1500;
VoiceLoop.SILENCE_LONG_MS = 2000;
VoiceLoop.MIN_SPEECH_MS = 200;
VoiceLoop.MAX_UTTERANCE_MS = 25000;
VoiceLoop.IDLE_RESTART_MS = 10000;
/** 마이크 목록. 아이폰 연속성 마이크처럼 끊기기 쉬운 장치보다 내장 마이크를 기본 추천한다. */
export async function listMicrophones() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
        .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d) => ({ id: d.deviceId, label: d.label || '이름 없는 마이크' }));
}
export function preferredMicrophone(mics) {
    const builtIn = mics.find((m) => /(macbook|내장|built-?in|internal)/i.test(m.label));
    const notPhone = mics.find((m) => !/(iphone|휴대폰|phone|continuity)/i.test(m.label));
    return (builtIn ?? notPhone ?? mics[0])?.id;
}
