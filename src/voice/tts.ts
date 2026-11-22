import { VoiceNotSupportedError, VoiceProviderError } from "./errors.ts";
import type { VoiceEndpoint } from "./stt.ts";
import { speechSpeed, VOICE_PROFILE, type SpeechProfile } from "../core/voice_profile.ts";

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
type Options = VoiceEndpoint & { voice: string; instructions?: string; speed?: number };
/** OpenAI /audio/speech. */
export class OpenAITtsProvider implements TtsProvider {
  readonly name: string;
  readonly supported = true;
  readonly baseUrl: string;
  readonly speed?: number;
  readonly profile: SpeechProfile;
  readonly #options: Options;
  constructor(options: Options) {
    if (options.apiKey.length === 0) throw new Error("음성 합성 API 키가 필요합니다.");
    this.#options = options;
    this.baseUrl = options.baseUrl;
    this.speed = options.speed;
    this.profile = { voice: options.voice, instructions: options.instructions ?? VOICE_PROFILE.instructions };
    this.name = "openai(" + options.model + ", " + options.voice + ")";
  }
  async synthesize(text: string, { signal, pace }: SpeechOptions) {
    const opts = this.#options;
    const body: Record<string, string | number> = { model: opts.model, voice: opts.voice, input: text, response_format: "mp3" };
    body.instructions = this.profile.instructions;
    const speed = speechSpeed(nonZero(opts.speed), nonZero(pace));
    if (Math.abs(speed - 1) > 1e-9) body.speed = speed;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
    const response = await (opts.fetch ?? fetch)(opts.baseUrl + "/audio/speech", {
      method: "POST", headers: { Authorization: "Bearer " + opts.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: signal === undefined ? timeout : AbortSignal.any([signal,timeout]),
    });
    if (!response.ok) throw await VoiceProviderError.fromResponse(response);
    return { audio: new Uint8Array(await response.arrayBuffer()), mimeType: "audio/mpeg" };
  }
}
function nonZero(value: number | undefined) {
  return value === undefined || value === 0 || Number.isNaN(value) ? 1 : value;
}
