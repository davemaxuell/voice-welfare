import type { Lang } from "../../src/core/turn.ts";

export const BCP47 = { ko: "ko-KR", en: "en-US", zh: "zh-CN", ja: "ja-JP" } as const;
let speechLang: Lang = "ko";
let context: AudioContext | undefined;
export function setSpeechLang(lang?: Lang) { speechLang = lang ?? "ko"; }
export function getSpeechLang() { return speechLang; }
export function audioContext() {
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (Context === undefined) throw new Error("이 브라우저는 웹 오디오를 지원하지 않습니다.");
  return context ??= new Context();
}
export function unlockAudio() {
  if (window.AudioContext === undefined && window.webkitAudioContext === undefined) return;
  const c = audioContext();
  if (c.state === "suspended") void c.resume().catch(() => undefined);
}
