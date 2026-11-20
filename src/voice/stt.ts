import { z } from "zod";
import { strip, stripChars } from "../core/text.ts";
import { VoiceNotSupportedError, VoiceProviderError } from "./errors.ts";

export interface VoiceInput { language: string; mimeType: string; signal?: AbortSignal }
/** 마이크 한 발화를 실시간으로 받아쓴다. 프레임은 24kHz 16비트 모노 PCM이다. */
export interface LiveTranscription {
  readonly model: string;
  transcribe(frames: AsyncIterable<Uint8Array>, language: string): Promise<string>;
}
export interface SttProvider {
  readonly name: string;
  readonly supported: boolean;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly live?: LiveTranscription;
  /** GPT-Live 음성 대화 모델. 공식 OpenAI 주소일 때만 있다. */
  readonly edgeModel?: string;
  transcribe(audio: Uint8Array, input: VoiceInput): Promise<{ text: string }>;
}
export class UnsupportedSttProvider implements SttProvider {
  readonly name = "unconfigured";
  readonly supported = false;
  async transcribe(_audio: Uint8Array, _input: VoiceInput): Promise<{text: string}> {
    throw new VoiceNotSupportedError("음성 입력을 사용하려면 이용 설정에서 OpenAI API 키를 등록해 주세요.");
  }
}
const extensions = new Map([["audio/webm","webm"],["audio/ogg","ogg"],["audio/mp4","mp4"],["audio/mpeg","mp3"],
  ["audio/wav","wav"],["audio/x-wav","wav"],["audio/m4a","m4a"],["audio/x-m4a","m4a"],["audio/flac","flac"],["audio/aac","aac"]]);
export function audioExtension(mime: string) { return extensions.get(strip(mime.split(";")[0] ?? "")) ?? "webm"; }
// 복지 신청 용어 인식을 돕는 힌트. 사용자 발화가 아니라 고정 문구다.
export const STT_PROMPT = "청음아, 정부24, 주민등록등본, 국민신문고, 민원, 한국장학재단, 국가장학금, 고용24, 홈택스, 복지로, 장애인연금, 다음으로, 이전으로, 멈춰.";
export const PROMPT_TERMS: readonly string[] = STT_PROMPT.split(",").map(term => stripChars(term, " ."));
// Python의 대소문자 무시는 i에 İ도 맞춘다. JavaScript의 u 플래그는 맞추지 않아 자리마다 적는다.
export const sttPatterns = {
  spaces: /\p{White_Space}+/gu,
  leading: /^[\p{White_Space}.!?。~,]+/u,
  trailing: /[\p{White_Space}.!?。~,]+(?=\n?$)/u,
  hallucination: /^(시청\p{White_Space}*해\p{White_Space}*주셔서\p{White_Space}*감사합니다|시청\p{White_Space}*감사합니다|구독(과|이랑)?\p{White_Space}*좋아요(\p{White_Space}*(부탁|눌러)[^.!]*)?|좋아요(와|랑)?\p{White_Space}*구독(\p{White_Space}*(부탁|눌러)[^.!]*)?|다음\p{White_Space}*(영상|시간)에\p{White_Space}*(서\p{White_Space}*)?(만나요|뵙겠습니다|만나겠습니다)|MBC\p{White_Space}*뉴스\p{White_Space}*\P{White_Space}*입니다|[^\n]{0,10}\p{White_Space}*뉴스\p{White_Space}*\P{White_Space}{2,4}입니다|자막\p{White_Space}*(제공|by)[^.!]*|Thanks?\p{White_Space}*(you\p{White_Space}*)?for\p{White_Space}*watching)(?=\n?$)/iu,
  // 외국어로 말하면 힌트를 영어로 옮겨 내놓기도 한다
  englishTerms: [/government\p{White_Space}*24/iu, /res[iİ]dent reg[iİ]strat[iİ]on/iu, /c[iİ]v[iİ]l (?:pet[iİ]t[iİ]on|compla[iİ]nt)/iu,
    /student a[iİ]d foundat[iİ]on/iu, /nat[iİ]onal scholarsh[iİ]p/iu, /employment\p{White_Space}*24/iu, /hometax/iu, /bokj[iİ]ro/iu],
};
const codePoints = (text: string) => Array.from(text).length;
/** 받아쓴 글이 힌트 낱말을 여러 개 그대로(또는 영어로 옮겨) 담고 있으면 힌트를 되뱉은 것으로 본다. */
export function isPromptEcho(text: string) {
  const compact = text.replace(sttPatterns.spaces, "");
  const hits = PROMPT_TERMS.filter(term => compact.includes(term));
  // 여러 기관을 한 요청에 말할 수 있다. 힌트가 대부분을 차지하는 나열만 재시도한다.
  const covered = hits.reduce((total, term) => total + codePoints(term), 0);
  return (hits.length >= 4 && covered >= codePoints(compact) * 0.70)
    || sttPatterns.englishTerms.filter(pattern => pattern.test(text)).length >= 4;
}
/** 받아쓴 글이 무음에서 흔히 지어내는 문장 하나뿐인지(문장부호·공백 무시). */
export function isHallucination(text: string) {
  const normalized = text.replace(sttPatterns.leading, "").replace(sttPatterns.trailing, "");
  return normalized.length > 0 && sttPatterns.hallucination.test(normalized);
}
export interface VoiceEndpoint { apiKey: string; baseUrl: string; model: string; timeoutMs?: number; fetch?: typeof fetch }
const LIVE_LANGUAGES = ["ko", "en", "zh", "ja"];
/** OpenAI /audio/transcriptions. */
export class OpenAISttProvider implements SttProvider {
  readonly name: string;
  readonly supported = true;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly live?: LiveTranscription;
  readonly edgeModel?: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  constructor(options: VoiceEndpoint & { live?: LiveTranscription; edgeModel?: string }) {
    if (options.apiKey.length === 0) throw new Error("받아쓰기 API 키가 필요합니다.");
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.live = options.live;
    this.edgeModel = options.edgeModel;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#fetch = options.fetch ?? fetch;
    this.name = "openai(" + options.model + ")";
  }
  async transcribe(audio: Uint8Array, input: VoiceInput) {
    const text = await this.#request(audio, input, input.language);
    // 다른 언어로 말하거나 소리가 불분명하면 모델이 받아쓰기 힌트를 그대로 내놓는다. 언어 자동 감지로 한 번 더 받아쓴다.
    if (!isPromptEcho(text)) return { text };
    const retry = await this.#request(audio, input);
    return { text: isPromptEcho(retry) ? "" : retry };
  }
  async #request(audio: Uint8Array, input: VoiceInput, language?: string) {
    const stripped = strip(input.mimeType.split(";")[0] ?? "");
    const mime = stripped.length > 0 ? stripped : "audio/webm";
    const form = new FormData();
    form.set("model", this.model);
    form.set("response_format", "json");
    const spoken = language !== undefined && language.length > 0;
    if (spoken && this.model === "gpt-transcribe") {
      for (const code of new Set([language, ...LIVE_LANGUAGES])) form.append("languages[]", code);
      for (const term of PROMPT_TERMS) form.append("keywords[]", term);
    } else if (spoken) {
      form.set("language", language);
    }
    // 한국어 용어 힌트는 한국어로 받아쓸 때만(다른 언어에 섞으면 힌트를 그대로 내놓기 쉽다)
    if (language === "ko" && this.model !== "gpt-transcribe") form.set("prompt", STT_PROMPT);
    form.set("file", new Blob([Uint8Array.from(audio)], { type: mime }), "speech." + audioExtension(mime));
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const res = await this.#fetch(this.baseUrl + "/audio/transcriptions", { method: "POST", body: form,
      headers: { Authorization: "Bearer " + this.apiKey },
      signal: input.signal === undefined ? timeout : AbortSignal.any([timeout,input.signal]) });
    if (res.status < 200 || res.status >= 300) throw new VoiceProviderError(res.status);
    const reply = z.object({ text: z.string().nullish() }).parse(await res.json());
    return strip(reply.text ?? "");
  }
}
