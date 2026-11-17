// ⑥ 말하기: 브라우저 음성 합성, 서버 TTS를 문장 단위로 받아 이어 재생, 신호음.
import { audioContext, BCP47, getSpeechLang } from './audio.js';
export const browserTts = {
    supported: typeof window !== 'undefined' && 'speechSynthesis' in window,
    speak(text) {
        if (!this.supported)
            return;
        const synth = window.speechSynthesis;
        const busy = synth.speaking || synth.pending;
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = BCP47[getSpeechLang()];
        u.rate = 1.25;
        // Chrome은 cancel() 직후의 speak()를 무시하는 경우가 있어 잠깐 뒤에 말한다.
        setTimeout(() => synth.speak(u), busy ? 80 : 0);
    },
    /** 말이 끝날 때까지 기다린다(대화 모드). */
    speakAndWait(text) {
        if (!this.supported)
            return Promise.resolve();
        return new Promise((resolve) => {
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            u.lang = BCP47[getSpeechLang()];
            u.rate = 1.25;
            u.onend = () => resolve();
            u.onerror = () => resolve();
            window.speechSynthesis.speak(u);
        });
    },
    cancel() {
        if (this.supported)
            window.speechSynthesis.cancel();
    },
};
let source;
let playToken = 0;
/** 긴 안내를 문장 단위로 나눈다(첫 문장을 먼저 합성해 바로 들려주기 위함). */
export function splitForSpeech(text, max = 140) {
    const sentences = text
        .replace(/\s+/g, ' ')
        // 중국어·일본어 문장부호(。！？)는 뒤에 띄어쓰기가 없어도 나눈다
        .split(/(?<=[.!?。]|다\.|요\.)\s+|(?<=[。！？])/)
        .map((s) => s.trim())
        .filter(Boolean);
    const chunks = [];
    for (const s of sentences) {
        const last = chunks[chunks.length - 1];
        // 첫 조각은 짧게 두어 빨리 시작하고, 이후 짧은 문장은 합쳐 요청 수를 줄인다.
        if (last && chunks.length > 1 && last.length + s.length + 1 <= max)
            chunks[chunks.length - 1] = `${last} ${s}`;
        else
            chunks.push(s);
    }
    return chunks;
}
async function playBuffer(c, data, token) {
    if (token !== playToken)
        return 'cancelled';
    if (c.state === 'suspended')
        await c.resume().catch(() => undefined);
    if (c.state !== 'running')
        return 'blocked';
    const buffer = await c.decodeAudioData(data);
    if (token !== playToken)
        return 'cancelled';
    const node = c.createBufferSource();
    node.buffer = buffer;
    node.connect(c.destination);
    source = node;
    // 끝까지 재생되거나 cancel()로 멈출 때 resolve (대화 모드는 말이 끝난 뒤에 다시 듣는다)
    await new Promise((resolve) => {
        node.onended = () => resolve();
        node.start();
    });
    return token === playToken ? 'played' : 'cancelled';
}
/** 서버 TTS 재생. 문장 단위로 다음 조각을 미리 받아 두며 이어서 재생한다. */
export const serverTts = {
    async speak(text, fetchAudio) {
        this.cancel();
        const token = playToken;
        const chunks = splitForSpeech(text);
        try {
            const c = audioContext();
            const load = (i) => (i < chunks.length ? fetchAudio(chunks[i]).then((b) => b.arrayBuffer()) : undefined);
            let next = load(0);
            for (let i = 0; i < chunks.length && next; i++) {
                const data = await next;
                next = load(i + 1); // 재생하는 동안 다음 문장 합성
                const r = await playBuffer(c, data, token);
                if (r !== 'played') {
                    next?.catch(() => undefined);
                    return r;
                }
            }
            return 'played';
        }
        catch (e) {
            console.warn('[tts] 서버 음성 재생 실패', e);
            return token === playToken ? 'failed' : 'cancelled';
        }
    },
    cancel() {
        playToken++;
        try {
            source?.stop();
        }
        catch {
            /* 이미 끝남 */
        }
        source = undefined;
    },
};
/** 화면을 보지 않아도 알 수 있는 짧은 신호음: listen = 이제 말하세요(높은 두 음), done = 들었어요(낮은 음) */
export function earcon(kind) {
    const c = audioContext();
    if (c.state !== 'running')
        return Promise.resolve();
    const tones = kind === 'listen' ? [660, 990] : [520];
    return new Promise((resolve) => {
        let t = c.currentTime;
        tones.forEach((f, i) => {
            const o = c.createOscillator();
            const g = c.createGain();
            o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
            o.connect(g).connect(c.destination);
            o.start(t);
            o.stop(t + 0.13);
            if (i === tones.length - 1)
                o.onended = () => resolve();
            t += 0.14;
        });
    });
}
