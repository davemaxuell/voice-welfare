import { workspaceText } from "./workspace-language.ts";
// 마이크(mic.ts)와 스피커(speaker.ts)가 함께 쓰는 것: 대화 언어와 AudioContext 하나.
// 끼어들기 감시가 같은 채널에서 나오는 안내 소리를 기준으로 재므로 AudioContext는 하나만 둔다.
import { LangSchema, type Lang } from "../../src/core/turn.ts";

/** 음성 API에 전달할 대화 언어. */
export const BCP47 = { ko: "ko-KR", en: "en-US", zh: "zh-CN", ja: "ja-JP" } as const;
let speechLang: Lang = "ko";
let context: AudioContext | undefined;
export function setSpeechLang(lang: unknown) {
  const parsed = LangSchema.safeParse(lang);
  speechLang = parsed.success ? parsed.data : "ko";
}
export function getSpeechLang() { return speechLang; }
export function audioContext() {
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (Context === undefined) throw new Error(workspaceText("이 브라우저는 웹 오디오를 지원하지 않습니다.", getSpeechLang()));
  return context ??= new Context();
}
/**
 * 브라우저 자동재생 정책: 소리는 사용자 동작(클릭·키 입력) 안에서 한 번 "잠금 해제"해야 한다.
 * 서버 음성은 응답을 기다린 뒤 재생되므로, 첫 동작 때 AudioContext를 깨워 두고 그 채널로만 재생한다.
 */
export function unlockAudio() {
  if (window.AudioContext === undefined && window.webkitAudioContext === undefined) return;
  const c = audioContext();
  if (c.state === "suspended") void c.resume().catch(() => undefined);
}
