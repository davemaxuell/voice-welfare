import { VoiceNotSupportedError } from "./errors.ts";
import type { SpeechProfile } from "../core/voice_profile.ts";

/** pace: 사용자의 말 빠르기 설정(보통=1). 설정한 기본 속도에 곱한다. */
interface SpeechOptions { language: string; signal?: AbortSignal; pace?: number }
export interface TtsProvider {
  readonly name: string; readonly supported: boolean;
  readonly baseUrl?: string; readonly speed?: number; readonly profile?: SpeechProfile;
  synthesize(text: string, input: SpeechOptions): Promise<{ audio: Uint8Array; mimeType: string }>;
}
export class UnsupportedTtsProvider implements TtsProvider {
  readonly name = "unconfigured";
  readonly supported = false;
  async synthesize(_text: string, _input: SpeechOptions): Promise<{ audio: Uint8Array; mimeType: string }> {
    throw new VoiceNotSupportedError("음성 안내를 사용하려면 이용 설정에서 OpenAI API 키를 등록해 주세요.");
  }
}
