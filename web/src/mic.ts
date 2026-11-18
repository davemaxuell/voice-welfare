// ① 듣기: 브라우저 음성 인식, 누르고 말하기 녹음, 핸즈프리 VAD 루프(끼어들기·박수 두 번), 마이크 고르기.
import { audioContext, BCP47, getSpeechLang } from './audio.ts';
const Recognition = typeof window !== 'undefined'
    ? (window.SpeechRecognition ??
        window.webkitSpeechRecognition)
    : undefined;
export const browserStt = {
    supported: Recognition !== undefined,
    /**
     * onText(최종 글). onPartial이 있으면 중간 결과도 넘긴다(규칙으로 미리 멈춤·승인만 본다).
     * 말이 바뀌면 중간 결과는 버리고, 최종에서만 턴을 확정한다.
     */
    listen(onText: (text: string) => void, onError: (message: string) => void, onEnd: () => void, onPartial?: (partial: string) => void) {
        if (Recognition === undefined) {
            onError('이 브라우저는 음성 인식을 지원하지 않습니다. 텍스트로 입력해 주세요.');
            onEnd();
            return () => undefined;
        }
        const r = new Recognition();
        r.lang = BCP47[getSpeechLang()];
        r.interimResults = typeof onPartial === 'function';
        r.maxAlternatives = 1;
        r.onresult = (e) => {
            let interim = '';
            let final = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const t = e.results[i]?.[0]?.transcript ?? '';
                if (e.results[i]?.isFinal === true)
                    final += t;
                else
                    interim += t;
            }
            if (final.length > 0)
                onText(final);
            else if (interim.length > 0 && onPartial !== undefined)
                onPartial(interim);
        };
        r.onerror = (e) => onError(`음성 인식 오류: ${e.error}`);
        r.onend = onEnd;
        r.start();
        return () => r.stop();
    },
};
function stopStream(stream?: MediaStream) {
    for (const track of stream?.getTracks() ?? []) track.stop();
}

function recordStream(stream: MediaStream) {
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, mimeType === undefined ? undefined : { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start(250);
    return { recorder, chunks };
}

/** 서버 STT용 녹음(누르고 말하기). 권한 창이 닫히기 전에 취소할 수도 있다. */
export async function startRecording(maxMs = 15000, signal?: AbortSignal) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
        signal?.throwIfAborted();
        const { recorder, chunks } = recordStream(stream);
        const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
        const timer = setTimeout(stop, maxMs);
        const cancel = () => { chunks.length = 0; stop(); stopStream(stream); };
        signal?.addEventListener('abort', cancel, { once: true });
        const finished = new Promise<Blob>(resolve => {
            recorder.onstop = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                stopStream(stream);
                resolve(new Blob(chunks, { type: recorder.mimeType.length > 0 ? recorder.mimeType : 'audio/webm' }));
            };
        });
        return { stop: () => { stop(); return finished; }, cancel };
    } catch (error) {
        stopStream(stream);
        throw error;
    }
}
/**
 * 핸즈프리 듣기: 마이크 음량으로 말의 시작과 끝을 감지(VAD)해 한 발화씩 녹음한다.
 * AI가 말하는 동안에는 듣지 않는다(스피커 소리를 다시 인식하는 것 방지).
 */
export class VoiceLoop {
    private version = 0;
    private noiseFloor = 0.01;
    private stream?: MediaStream;
    private sourceNode?: MediaStreamAudioSourceNode;
    private analyser?: AnalyserNode;
    private clapStream?: MediaStream;
    private clapSource?: MediaStreamAudioSourceNode;
    private bargeTimer?: ReturnType<typeof setInterval>;
    private clapTimer?: ReturnType<typeof setInterval>;
    private abort?: () => void;
    private finishNow?: () => boolean;
    private preroll?: ReturnType<typeof recordStream>;
    onTrouble?: (reason: "ended" | "muted") => void;
    static readonly SILENCE_SHORT_MS = 1500;
    static readonly SILENCE_LONG_MS = 2000;
    static readonly MIN_SPEECH_MS = 200;
    static readonly MAX_UTTERANCE_MS = 25000;
    static readonly IDLE_RESTART_MS = 10000;
    async start(deviceId?: string) {
        const version = ++this.version;
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                ...(deviceId !== undefined && deviceId.length > 0 ? { deviceId: { exact: deviceId } } : {}),
            },
        });
        if (version !== this.version) { stopStream(stream); return; }
        this.stream = stream;
        const track = stream.getAudioTracks()[0];
        if (track === undefined) { this.stop(); throw new Error('마이크를 찾을 수 없습니다.'); }
        track.onended = () => this.onTrouble?.('ended');
        track.onmute = () => this.onTrouble?.('muted');
        try {
            const c = audioContext();
            if (c.state === 'suspended') await c.resume();
            if (version !== this.version) return;
            this.sourceNode = c.createMediaStreamSource(stream);
            this.analyser = c.createAnalyser();
            this.analyser.fftSize = 1024;
            this.sourceNode.connect(this.analyser);
            const noiseFloor = await this.measure(400);
            if (version === this.version) this.noiseFloor = noiseFloor;
        } catch (error) {
            if (version === this.version) this.stop();
            throw error;
        }
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
    async measure(ms: number) {
        const samples = [];
        const version = this.version;
        const end = Date.now() + ms;
        while (Date.now() < end && this.version === version) {
            samples.push(this.level());
            await new Promise((r) => setTimeout(r, 30));
        }
        return samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
    }
    /** 한 발화를 녹음해 돌려준다. stop()이 불리면 null. */
    listenOnce(onSpeechStart?: () => void): Promise<Blob | null> {
        return this.listen(onSpeechStart);
    }
    private listen(onSpeechStart?: () => void, startWithinMs?: number, prefix?: ReturnType<typeof recordStream>): Promise<Blob | null> {
        if (!this.stream)
            return Promise.resolve(null);
        this.cancelListening();
        const stream = this.stream;
        const threshold = Math.max(0.01, this.noiseFloor * 2.5); // 조용한 노트북 마이크도 감지되도록
        return new Promise((resolve) => {
            let recorder: MediaRecorder;
            let chunks: Blob[] = [];
            let speechMs = 0;
            let silenceMs = 0;
            let started = false;
            let spokenMs = 0;
            let startedAt = Date.now();
            let done = false;
            const begin = () => {
                const recording = prefix ?? recordStream(stream);
                prefix = undefined;
                chunks = recording.chunks;
                recorder = recording.recorder;
                startedAt = Date.now();
                speechMs = 0;
                silenceMs = 0;
                started = false;
            };
            const finish = (send: boolean) => {
                if (done)
                    return;
                done = true;
                clearInterval(timer);
                this.abort = undefined;
                this.finishNow = undefined;
                recorder.onstop = () => resolve(send ? new Blob(chunks, { type: recorder.mimeType.length > 0 ? recorder.mimeType : 'audio/webm' }) : null);
                if (recorder.state !== 'inactive')
                    recorder.stop();
                else
                    resolve(send ? new Blob(chunks, { type: recorder.mimeType.length > 0 ? recorder.mimeType : 'audio/webm' }) : null);
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
                    else if (startWithinMs !== undefined && Date.now() - startedAt >= startWithinMs) {
                        finish(false);
                    } else if (Date.now() - startedAt > VoiceLoop.IDLE_RESTART_MS) {
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
    /** 안내 중의 소리보다 큰 소리가 0.3초 이어지면 듣기로 전환한다. */
    watchBargeIn(onBargeIn: () => void) {
        const stream = this.stream;
        if (this.analyser === undefined || stream === undefined) return () => undefined;
        let bleed = this.noiseFloor;
        let loudMs = 0;
        let fired = false;
        let since = Date.now();
        const prepare = () => {
            this.discardPreroll();
            try { this.preroll = recordStream(stream); } catch { /* 녹음이 안 되면 일반 듣기로 전환 */ }
            since = Date.now();
        };
        prepare();
        const timer = setInterval(() => {
            const level = this.level();
            if (level > Math.max(0.02, bleed * 2.2, this.noiseFloor * 4)) {
                loudMs += 50;
            } else {
                loudMs = Math.max(0, loudMs - 50);
                bleed = bleed * 0.9 + level * 0.1;
                // 한 녹음기의 헤더와 음성 조각을 함께 보존한다. 말이 시작되면 교체하지 않는다.
                if (loudMs === 0 && Date.now() - since >= 1000) prepare();
            }
            if (loudMs >= 300) {
                fired = true;
                clearInterval(timer);
                onBargeIn();
            }
        }, 50);
        this.bargeTimer = timer;
        return () => {
            clearInterval(timer);
            if (this.bargeTimer !== timer) return;
            this.bargeTimer = undefined;
            if (!fired) this.discardPreroll();
        };
    }

    private discardPreroll() {
        const recorder = this.preroll?.recorder;
        if (recorder !== undefined && recorder.state !== 'inactive') recorder.stop();
        this.preroll = undefined;
    }

    /** 2초 안에 말을 시작하면 끝까지 같은 녹음기로 듣는다. */
    listenAfterBarge(maxMs = 2000, onSpeechStart?: () => void) {
        const prefix = this.preroll;
        this.preroll = undefined;
        return this.listen(onSpeechStart, maxMs, prefix);
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
        const version = this.version;
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(deviceId !== undefined && deviceId.length > 0 ? { deviceId: { exact: deviceId } } : {}) },
            });
        }
        catch {
            return; // 박수 감지는 보조 기능: 실패해도 대화는 계속
        }
        if (this.version !== version) { stopStream(stream); return; }
        this.clapStream = stream;
        let an: AnalyserNode;
        try {
            const c = audioContext();
            this.clapSource = c.createMediaStreamSource(stream);
            an = c.createAnalyser();
            an.fftSize = 512;
            this.clapSource.connect(an);
        } catch {
            this.clapSource?.disconnect();
            this.clapSource = undefined;
            stopStream(stream);
            this.clapStream = undefined;
            return;
        }
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
                if (firstClapAt > 0 && gap >= 150 && gap <= 800) {
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
        this.version++;
        this.cancelListening();
        clearInterval(this.bargeTimer);
        this.bargeTimer = undefined;
        this.discardPreroll();
        clearInterval(this.clapTimer);
        this.clapTimer = undefined;
        this.clapSource?.disconnect();
        this.clapSource = undefined;
        stopStream(this.clapStream);
        this.clapStream = undefined;
        this.sourceNode?.disconnect();
        this.sourceNode = undefined;
        for (const track of this.stream?.getAudioTracks() ?? []) {
            track.onended = null;
            track.onmute = null;
        }
        stopStream(this.stream);
        this.stream = undefined;
        this.analyser = undefined;
    }
}
/** 마이크 목록. 아이폰 연속성 마이크처럼 끊기기 쉬운 장치보다 내장 마이크를 기본 추천한다. */
export async function listMicrophones() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
        .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d) => ({ id: d.deviceId, label: d.label.length > 0 ? d.label : '이름 없는 마이크' }));
}
export function preferredMicrophone(mics: { id: string; label: string }[]) {
    const builtIn = mics.find((m) => /(macbook|내장|built-?in|internal)/i.test(m.label));
    const notPhone = mics.find((m) => !/(iphone|휴대폰|phone|continuity)/i.test(m.label));
    return (builtIn ?? notPhone ?? mics[0])?.id;
}
