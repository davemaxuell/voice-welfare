import { LANGS } from "../core/turn.ts";
import { OpenAISttProvider, UnsupportedSttProvider, type SttProvider } from "./stt.ts";
import { LanguageRoutedStt, LocalWhisperStt } from "./stt_local.ts";
import { OpenAITtsProvider, UnsupportedTtsProvider, type TtsProvider } from "./tts.ts";

export interface VoiceConfig {
  stt?: string; tts?: string; apiKey?: string; baseUrl?: string; sttBaseUrl?: string; sttModel?: string;
  sttLocalModel?: string; sttLocalThreads?: number; sttLocalBeam?: number; sttLocalPrompt?: boolean;
  ttsModel?: string; ttsVoice?: string; ttsInstructions?: string; ttsSpeed?: number;
}
export async function createVoiceProviders(cfg: VoiceConfig, fetcher: typeof fetch = fetch): Promise<[SttProvider,TtsProvider]> {
  const baseUrl = (cfg.baseUrl === undefined || cfg.baseUrl.length === 0 ? "https://api.openai.com/v1" : cfg.baseUrl).replace(/\/+$/u,"");
  const endpoint = { apiKey: cfg.apiKey ?? "", baseUrl, fetch: fetcher };
  const remote = endpoint.apiKey !== "" && cfg.sttModel !== undefined && cfg.sttModel.length > 0
    ? new OpenAISttProvider({ ...endpoint, model: cfg.sttModel }) : undefined;
  let stt: SttProvider = new UnsupportedSttProvider();
  if (cfg.stt?.toLowerCase() === "local") {
    if (cfg.sttBaseUrl !== undefined && cfg.sttBaseUrl.length > 0) {
      stt = new OpenAISttProvider({ apiKey: "", baseUrl: cfg.sttBaseUrl.replace(/\/+$/u,""), model: cfg.sttModel ?? "whisper-1", fetch: fetcher });
    } else if (cfg.sttLocalModel !== undefined && LocalWhisperStt.available(cfg.sttLocalModel)) {
      const local = new LocalWhisperStt(cfg.sttLocalModel, { threads: cfg.sttLocalThreads, beamSize: cfg.sttLocalBeam, usePrompt: cfg.sttLocalPrompt });
      if (await local.probe()) stt = new LanguageRoutedStt(local, remote, ["ko"], LANGS);
      else await local.close();
    }
  } else if (cfg.stt?.toLowerCase() === "openai" && remote !== undefined) stt = remote;
  const tts = cfg.tts?.toLowerCase() === "openai" && cfg.ttsModel !== undefined && cfg.ttsModel.length > 0 && endpoint.apiKey !== ""
    ? new OpenAITtsProvider({ ...endpoint, model: cfg.ttsModel, voice: cfg.ttsVoice ?? "alloy", instructions: cfg.ttsInstructions, speed: cfg.ttsSpeed })
    : new UnsupportedTtsProvider();
  return [stt,tts];
}
