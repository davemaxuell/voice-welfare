import { z } from "zod";
import { strip } from "../core/text.ts";
import { VoiceNotSupportedError, VoiceProviderError } from "./errors.ts";

export interface VoiceInput { language: string; mimeType: string; signal?: AbortSignal }
export interface SttProvider {
  readonly name: string;
  readonly supported: boolean;
  readonly localLanguages?: readonly string[];
  transcribe(audio: Uint8Array, input: VoiceInput): Promise<{ text: string }>;
  warm?(): Promise<void>;
  close?(): Promise<void>;
}
export class UnsupportedSttProvider implements SttProvider {
  readonly name = "browser-only";
  readonly supported = false;
  async transcribe(_audio: Uint8Array, _input: VoiceInput): Promise<{text: string}> {
    throw new VoiceNotSupportedError("서버 STT가 설정되지 않았습니다. 브라우저 음성 인식이나 텍스트 입력을 사용하세요.");
  }
}
const extensions = new Map([["audio/webm","webm"],["audio/ogg","ogg"],["audio/mp4","mp4"],["audio/mpeg","mp3"],
  ["audio/wav","wav"],["audio/x-wav","wav"],["audio/m4a","m4a"]]);
export function audioExtension(mime: string) { return extensions.get(strip(mime.split(";")[0] ?? "")) ?? "webm"; }
export const STT_PROMPT = "장애인연금 신청 대화. 성명, 주민등록 주소, 실거주지, 연락처, 소득·재산 신고, 가구원 수, 모의접수, 다음으로, 이전으로, 멈춰, 청음아.";
export const sttPatterns = {
  spaces: /\p{White_Space}+/gu,
  promptBoundary: /[.,]\p{White_Space}*/u,
  leading: /^[\p{White_Space}.!?。~,]+/u,
  trailing: /[\p{White_Space}.!?。~,]+(?=\n?$)/u,
  hallucination: /^(시청\p{White_Space}*해\p{White_Space}*주셔서\p{White_Space}*감사합니다|시청\p{White_Space}*감사합니다|구독(과|이랑)?\p{White_Space}*좋아요(\p{White_Space}*(부탁|눌러)[^.!]*)?|좋아요(와|랑)?\p{White_Space}*구독(\p{White_Space}*(부탁|눌러)[^.!]*)?|다음\p{White_Space}*(영상|시간)에\p{White_Space}*(서\p{White_Space}*)?(만나요|뵙겠습니다|만나겠습니다)|MBC\p{White_Space}*뉴스\p{White_Space}*\P{White_Space}*입니다|[^\n]{0,10}\p{White_Space}*뉴스\p{White_Space}*\P{White_Space}{2,4}입니다|자막\p{White_Space}*(제공|by)[^.!]*|Thanks?\p{White_Space}*(you\p{White_Space}*)?for\p{White_Space}*watching)(?=\n?$)/iu,
  englishTerms: [/pension application/iu, /resident registration/iu, /actual residence/iu, /contact information/iu,
    /income and property/iu, /household members/iu, /mock application/iu],
};
const terms = STT_PROMPT.split(sttPatterns.promptBoundary).map(t => t.replace(sttPatterns.spaces, "")).filter(t => t.length >= 2);
export function isPromptEcho(text: string) {
  const compact = text.replace(sttPatterns.spaces, "");
  return terms.filter(t => compact.includes(t)).length >= 4 || sttPatterns.englishTerms.filter(p => p.test(text)).length >= 3;
}
export function isHallucination(text: string) {
  const normalized = text.replace(sttPatterns.leading, "").replace(sttPatterns.trailing, "");
  return normalized.length > 0 && sttPatterns.hallucination.test(normalized);
}
export interface VoiceEndpoint { apiKey: string; baseUrl: string; model: string; timeoutMs?: number; fetch?: typeof fetch }
export class OpenAISttProvider implements SttProvider {
  readonly name: string;
  readonly supported = true;
  readonly #options: VoiceEndpoint;
  constructor(options: VoiceEndpoint) {
    this.#options = options;
    this.name = options.apiKey.length > 0 ? "openai(" + options.model + ")" : "local(" + options.baseUrl + ")";
  }
  async transcribe(audio: Uint8Array, input: VoiceInput) {
    const first = await this.#request(audio, input, input.language);
    if (!isPromptEcho(first)) return { text: first };
    const retry = await this.#request(audio, input);
    return { text: isPromptEcho(retry) ? "" : retry };
  }
  async #request(audio: Uint8Array, input: VoiceInput, language?: string) {
    const opts = this.#options;
    const mime = strip(input.mimeType.split(";")[0] ?? "");
    const form = new FormData();
    form.set("model", opts.model);
    form.set("response_format", "json");
    if (language !== undefined && language.length > 0) form.set("language", language);
    if (language === "ko") form.set("prompt", STT_PROMPT);
    form.set("file", new Blob([Uint8Array.from(audio)], { type: mime.length > 0 ? mime : "audio/webm" }), "speech." + audioExtension(mime));
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
    const res = await (opts.fetch ?? fetch)(opts.baseUrl + "/audio/transcriptions", { method: "POST", body: form,
      headers: opts.apiKey.length > 0 ? { Authorization: "Bearer " + opts.apiKey } : {},
      signal: input.signal === undefined ? timeout : AbortSignal.any([timeout,input.signal]) });
    if (!res.ok) throw new VoiceProviderError(res.status);
    const reply = z.object({ text: z.string().nullish() }).parse(await res.json());
    return strip(reply.text ?? "");
  }
}
