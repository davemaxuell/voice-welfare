import { VoiceNotSupportedError, VoiceProviderError } from "./errors.ts";
import type { VoiceEndpoint } from "./stt.ts";

/** pace: 사용자의 말 빠르기 설정(보통=1). 설정한 기본 속도에 곱한다. */
interface SpeechOptions { language: string; signal?: AbortSignal; pace?: number }
export interface TtsProvider {
  readonly name: string; readonly supported: boolean;
  readonly baseUrl?: string; readonly speed?: number;
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
  readonly #options: Options;
  constructor(options: Options) {
    if (options.apiKey.length === 0) throw new Error("음성 합성 API 키가 필요합니다.");
    this.#options = options;
    this.baseUrl = options.baseUrl;
    this.speed = options.speed;
    this.name = "openai(" + options.model + ", " + options.voice + ")";
  }
  async synthesize(text: string, { language, signal, pace }: SpeechOptions) {
    const opts = this.#options;
    const body: Record<string, string | number> = { model: opts.model, voice: opts.voice, input: text, response_format: "mp3" };
    // 말투 지시는 한국어용이라 다른 언어에서는 쓰지 않는다
    if (opts.instructions !== undefined && opts.instructions.length > 0 && language === "ko") body.instructions = opts.instructions;
    const speed = Math.min(4, Math.max(0.25, nonZero(opts.speed) * nonZero(pace)));
    if (Math.abs(speed - 1) > 1e-9) body.speed = speed;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
    const response = await (opts.fetch ?? fetch)(opts.baseUrl + "/audio/speech", {
      method: "POST", headers: { Authorization: "Bearer " + opts.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: signal === undefined ? timeout : AbortSignal.any([signal,timeout]),
    });
    if (response.status < 200 || response.status >= 300) throw new VoiceProviderError(response.status);
    return { audio: new Uint8Array(await response.arrayBuffer()), mimeType: "audio/mpeg" };
  }
}
function nonZero(value: number | undefined) {
  return value === undefined || value === 0 || Number.isNaN(value) ? 1 : value;
}
