// 앱에서 사용하는 받아쓰기와 음성 합성은 같은 인증된 API를 쓴다.
import { OPENAI_BASE_URL } from "../core/llm.ts";
import { STACK } from "../core/model_stack.ts";
import { rstripChars } from "../core/text.ts";
import { LIVE_MODEL, LiveTranscriber, connectSocket, type SocketConnect } from "./live.ts";
import { OpenAISttProvider, UnsupportedSttProvider, type SttProvider } from "./stt.ts";
import { OpenAITtsProvider, UnsupportedTtsProvider, type TtsProvider } from "./tts.ts";
import { VOICE_PROFILE } from "../core/voice_profile.ts";

export const DEFAULT_SPEED = VOICE_PROFILE.speed;

export interface VoiceConfig {
  apiKey?: string; baseUrl?: string; sttModel?: string; ttsModel?: string; ttsVoice?: string;
  ttsInstructions?: string; ttsSpeed?: number; liveModel?: string;
}
export const VOICE_DEFAULTS = {
  baseUrl: OPENAI_BASE_URL, sttModel: STACK.transcription, ttsModel: VOICE_PROFILE.model, ttsVoice: VOICE_PROFILE.voice,
  ttsInstructions: VOICE_PROFILE.instructions,
  ttsSpeed: DEFAULT_SPEED, liveModel: STACK.voice,
} as const;

export function createVoiceProviders(cfg: VoiceConfig, fetcher: typeof fetch = fetch, connect: SocketConnect = connectSocket): [SttProvider, TtsProvider] {
  const apiKey = cfg.apiKey ?? "";
  if (apiKey.length === 0) return [new UnsupportedSttProvider(), new UnsupportedTtsProvider()];
  const base = rstripChars(cfg.baseUrl ?? VOICE_DEFAULTS.baseUrl, "/");
  const sttModel = cfg.sttModel ?? VOICE_DEFAULTS.sttModel;
  const liveModel = cfg.liveModel ?? VOICE_DEFAULTS.liveModel;
  const stt = new OpenAISttProvider({
    apiKey, baseUrl: base, model: sttModel === LIVE_MODEL ? VOICE_DEFAULTS.sttModel : sttModel, fetch: fetcher,
    live: new LiveTranscriber(base, apiKey, connect),
    // Live sessions use a different protocol from Realtime transcription.
    edgeModel: base === OPENAI_BASE_URL && liveModel !== LIVE_MODEL ? liveModel : undefined,
  });
  const tts = new OpenAITtsProvider({
    apiKey, baseUrl: base, model: cfg.ttsModel ?? VOICE_DEFAULTS.ttsModel, voice: cfg.ttsVoice ?? VOICE_DEFAULTS.ttsVoice,
    instructions: cfg.ttsInstructions ?? VOICE_PROFILE.instructions, speed: cfg.ttsSpeed ?? VOICE_DEFAULTS.ttsSpeed, fetch: fetcher,
  });
  return [stt, tts];
}
