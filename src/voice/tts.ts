import { VoiceNotSupportedError, VoiceProviderError } from "./errors.ts";
import type { VoiceEndpoint } from "./stt.ts";

interface SpeechOptions { language: string; signal?: AbortSignal }
export interface TtsProvider {
  readonly name: string; readonly supported: boolean;
  synthesize(text: string, input: SpeechOptions): Promise<{ audio: Uint8Array; mimeType: string }>;
}
export class UnsupportedTtsProvider implements TtsProvider {
  readonly name = "browser-only";
  readonly supported = false;
  async synthesize(_text: string, _input: SpeechOptions): Promise<{ audio: Uint8Array; mimeType: string }> {
    throw new VoiceNotSupportedError("서버 TTS가 설정되지 않았습니다. 브라우저 음성 합성을 사용하세요.");
  }
}
type Options = VoiceEndpoint & { voice: string; instructions?: string; speed?: number };
export class OpenAITtsProvider implements TtsProvider {
  readonly name: string;
  readonly supported = true;
  readonly #options: Options;
  constructor(options: Options) {
    this.#options = options;
    this.name = "openai(" + options.model + ", " + options.voice + ")";
  }
  async synthesize(text: string, { language, signal }: SpeechOptions) {
    const opts = this.#options;
    const body = { model: opts.model, voice: opts.voice, input: text, response_format: "mp3",
      instructions: language === "ko" && opts.instructions !== "" ? opts.instructions : undefined,
      speed: opts.speed === 0 || opts.speed === 1 ? undefined : opts.speed };
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
    const response = await (opts.fetch ?? fetch)(opts.baseUrl + "/audio/speech", {
      method: "POST", headers: { Authorization: "Bearer " + opts.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: signal === undefined ? timeout : AbortSignal.any([signal,timeout]),
    });
    if (!response.ok) throw new VoiceProviderError(response.status);
    return { audio: new Uint8Array(await response.arrayBuffer()), mimeType: "audio/mpeg" };
  }
}
