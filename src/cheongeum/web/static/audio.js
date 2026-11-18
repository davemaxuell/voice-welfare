// 마이크(mic.js)와 스피커(speaker.js)가 함께 쓰는 것: 대화 언어와 AudioContext 하나.
// 끼어들기 감시가 같은 채널에서 나오는 안내 소리를 기준으로 재므로 AudioContext는 하나만 둔다.
/** 지금 대화 언어(서버 응답의 lang을 따른다). 브라우저 음성 인식·합성 언어에 쓴다. */
export const BCP47 = { ko: 'ko-KR', en: 'en-US', zh: 'zh-CN', ja: 'ja-JP' };
let speechLang = 'ko';
export function setSpeechLang(lang) {
    speechLang = lang && BCP47[lang] ? lang : 'ko';
}
export function getSpeechLang() {
    return speechLang;
}
let ctx;
export function audioContext() {
    const Ctor = (window.AudioContext ?? window.webkitAudioContext);
    ctx ?? (ctx = new Ctor());
    return ctx;
}
/**
 * 브라우저 자동재생 정책: 소리는 사용자 동작(클릭·키 입력) 안에서 한 번 "잠금 해제"해야 한다.
 * 서버 음성은 응답을 기다린 뒤 재생되므로, 첫 동작 때 AudioContext를 깨워 두고 그 채널로만 재생한다.
 */
export function unlockAudio() {
    const c = audioContext();
    if (c.state === 'suspended')
        void c.resume().catch(() => undefined);
}
