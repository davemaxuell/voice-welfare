import { z } from "zod";
import profile from "./voice_profile.json" with { type: "json" };

/** 대화·짧은 안내·첫 설정 녹음과 Python 서버가 함께 쓰는 목소리다. */
export const VOICE_PROFILE = Object.freeze(z.strictObject({
  model: z.string().min(1), voice: z.string().min(1), instructions: z.string().min(1), speed: z.number().min(0.25).max(4),
  normalRate: z.number().min(0.5).max(2),
}).parse(profile));

export interface SpeechProfile { readonly voice: string; readonly instructions: string }

// 저장된 말 빠르기 선호값에서 1.25가 보통이다. 실제 속도는 기기의 설정을 기준으로 한다.
export const NORMAL_SPEECH_RATE = VOICE_PROFILE.normalRate;
export function speechPace(rate: unknown): number | undefined {
  return typeof rate === "number" && rate >= 0.5 && rate <= 2 ? rate / NORMAL_SPEECH_RATE : undefined;
}
export function speechSpeed(base: number, pace = 1): number {
  return Math.min(4, Math.max(0.25, base * pace));
}
