import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createVoiceProviders } from "../../src/voice/config.ts";
import { LanguageRoutedStt, LocalWhisperStt } from "../../src/voice/stt_local.ts";
import { STT_PROMPT, audioExtension, isPromptEcho, isHallucination, OpenAISttProvider, UnsupportedSttProvider } from "../../src/voice/stt.ts";
import { VoiceProviderError } from "../../src/voice/errors.ts";
import { OpenAITtsProvider } from "../../src/voice/tts.ts";
import { fakeFetch } from "../helpers.ts";

const cfg = { apiKey: "test", baseUrl: "https://example.test/v1", model:"stt-model" };
const audio = new Uint8Array([1,2,3]);
const ko = { language:"ko", mimeType:"audio/webm;codecs=opus" };
const en = { ...ko, language:"en" };
const folders: string[] = [], children: LocalWhisperStt[] = [];
const folder = () => { const dir = mkdtempSync(join(tmpdir(),"cheongeum-stt-test-")); folders.push(dir); return dir; };
function voice(reply: string, usePrompt = false, ms = 0) {
  const journal = join(folder(), "requests");
  const local = new LocalWhisperStt("models/whisper-small-komixv2-ct2", { usePrompt, workerCommand: [
    process.execPath, fileURLToPath(new URL("../fixtures/voice/sidecar.mjs", import.meta.url)), journal, reply, String(ms),
  ] });
  children.push(local);
  const requests = () => readFileSync(journal, "utf8").trimEnd().split("\n").map(l => JSON.parse(l) as {
    language: string; prompt: string | null; audioPath: string; bytes: number[]; mode: number });
  return { local, requests, journal };
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(c => c.close()));
  for (const d of folders.splice(0)) rmSync(d,{ recursive:true,force:true });
});
function remote(replies: string[]) {
  const fetcher = fakeFetch(() => Response.json({ text: replies.shift() ?? "" }));
  return { calls:fetcher.calls, stt: new OpenAISttProvider({ ...cfg, fetch: fetcher }) };
}
it("test_stt_sends_model_language_extension", async () => {
  const {stt,calls} = remote([" 다음으로 "]);
  expect(await stt.transcribe(audio,{...ko,mimeType:"audio/mp4"})).toEqual({text:"다음으로"});
  const req = calls[0]!, form = await req.formData();
  expect(req.url).toBe(cfg.baseUrl + "/audio/transcriptions");
  expect([form.get("model"),form.get("language"),form.get("prompt")]).toEqual(["stt-model","ko",STT_PROMPT]);
  const part = form.get("file");
  expect(part).toBeInstanceOf(File);
  if (part instanceof File) expect([part.name,[...new Uint8Array(await part.arrayBuffer())]]).toEqual(["speech.mp4",[1,2,3]]);
});
it("test_stt_prompt_echo_retries_without_language", async () => {
  const {stt,calls} = remote([STT_PROMPT,"Korean please"]);
  expect(await stt.transcribe(audio,ko)).toEqual({text:"Korean please"});
  const second = await calls[1]!.formData();
  expect([second.has("language"), second.has("prompt")]).toEqual([false,false]);
});
it("test_stt_echo_twice_returns_empty", async () => {
  expect(await remote([STT_PROMPT,STT_PROMPT]).stt.transcribe(audio,ko)).toEqual({text:""});
});
it("test_stt_no_korean_prompt_for_other_languages", async () => {
  const {stt,calls} = remote(["Open Naver"]);
  await stt.transcribe(audio,en);
  const form = await calls[0]!.formData();
  expect(form.get("language")).toBe("en");
  expect(form.has("prompt")).toBe(false);
});
it("test_tts_body_and_mp3", async () => {
  const fetcher = fakeFetch(() => new Response(audio));
  const tts = new OpenAITtsProvider({ ...cfg, model:"tts-model",voice:"coral",instructions:"천천히",fetch:fetcher });
  expect(await tts.synthesize("안녕하세요",ko)).toEqual({audio,mimeType:"audio/mpeg"});
  expect(await fetcher.calls[0]!.json()).toEqual({model:"tts-model",voice:"coral",input:"안녕하세요",response_format:"mp3",instructions:"천천히"});
});
it("test_provider_error_status_only", async () => {
  const fetcher = fakeFetch(() => new Response("private error",{status:401}));
  await expect(new OpenAISttProvider({...cfg,fetch:fetcher}).transcribe(audio,ko)).rejects.toMatchObject({status:401,message:"voice provider error (HTTP 401)"});
  await expect(new OpenAITtsProvider({...cfg,voice:"coral",fetch:fetcher}).synthesize("음성",ko)).rejects.toBeInstanceOf(VoiceProviderError);
});
it("test_voice_fallback_without_key_or_model", async () => {
  expect((await createVoiceProviders({stt:"openai",tts:"openai",sttModel:"m"})).map(p => p.supported)).toEqual([false,false]);
  expect((await createVoiceProviders({stt:"openai",tts:"mock",apiKey:"test",sttModel:"m"})).map(p => p.supported)).toEqual([true,false]);
});
it("test_audio_extension", () => { expect(["audio/mp4","audio/ogg;codecs=opus","weird/type"].map(audioExtension)).toEqual(["mp4","ogg","webm"]); });
it("test_prompt_echo_detection", () => {
  expect(isPromptEcho("Disability pension application conversation. Name, resident registration address, actual residence, contact information.")).toBe(true);
  expect(isPromptEcho(STT_PROMPT)).toBe(true);
  expect(isPromptEcho("주소는 부산광역시 예시구 예시로 10, 다음으로")).toBe(false);
  expect(isPromptEcho("English please")).toBe(false);
});
it("test_local_transcribes_without_prompt_by_default", async () => {
  const {local,requests} = voice(" 장애인연금 신청 도와줘 ");
  expect(await local.probe()).toBe(true);
  await local.warm();
  expect(await local.transcribe(audio,ko)).toEqual({text:"장애인연금 신청 도와줘"});
  const [req] = requests();
  expect(req).toMatchObject({bytes:[1,2,3],language:"ko",prompt:null});
  if (process.platform !== "win32") expect(req!.mode).toBe(0o600);
  expect(existsSync(req!.audioPath)).toBe(false);
});
it("test_local_prompt_only_for_korean_when_enabled", async () => {
  const {local,requests} = voice("다음으로",true);
  await Promise.all([local.transcribe(audio,ko), local.transcribe(audio,en)]);
  expect(requests().map(r => r.prompt)).toEqual([STT_PROMPT,null]);
});
it.each(["시청해 주셔서 감사합니다.","구독과 좋아요 부탁드립니다","MBC 뉴스 이덕영입니다.",STT_PROMPT])("test_local_drops_silence_hallucinations_and_prompt_echo", async reply => {
  expect(await voice(reply).local.transcribe(audio,ko)).toEqual({text:""});
});
it("test_hallucination_keeps_real_utterances", () => {
  expect(["시청해주셔서 감사합니다","감사합니다","뉴스 읽어줘","구독 서비스 알려줘"].map(isHallucination)).toEqual([true,false,false,false]);
});
it("test_local_stop_signal_does_not_wait", async () => {
  const {local,journal,requests} = voice("다음으로",false,250);
  const controller = new AbortController();
  const turn = local.transcribe(audio,{ ...ko,signal:controller.signal });
  const deadline = Date.now()+5000;
  while (!existsSync(journal) && Date.now()<deadline) await delay(10);
  const [req] = requests();
  controller.abort();
  await expect(turn).rejects.toMatchObject({name:"AbortError"});
  expect(existsSync(req!.audioPath)).toBe(true);
  await local.warm();
  expect(existsSync(req!.audioPath)).toBe(false);
  await expect(local.transcribe(audio,{ ...ko,signal:controller.signal })).rejects.toMatchObject({name:"AbortError"});
  expect(requests()).toHaveLength(1);
});
it("test_routing_korean_local_others_openai", async () => {
  const {stt,calls} = remote(["Open Naver"]);
  const routed = new LanguageRoutedStt(voice("네이버 열어줘").local,stt);
  expect(routed.name).toBe("local(whisper-small-komixv2)+openai(stt-model)");
  expect(routed.localLanguages).toEqual(["ko"]);
  expect(await routed.transcribe(audio,ko)).toEqual({text:"네이버 열어줘"});
  expect(calls).toHaveLength(0);
  expect(await routed.transcribe(audio,en)).toEqual({text:"Open Naver"});
  expect(calls).toHaveLength(1);
});
it("test_routing_without_openai_keeps_every_language_local", async () => {
  const routed = new LanguageRoutedStt(voice("Open Naver").local,undefined,["ko"],["ko","en","zh","ja"]);
  expect(routed.localLanguages).toEqual(["ko","en","zh","ja"]);
  expect(await routed.transcribe(audio,en)).toEqual({text:"Open Naver"});
});
it("test_config_precedence", async () => {
  expect((await createVoiceProviders({stt:"local",sttBaseUrl:"http://127.0.0.1:8000/v1",sttLocalModel:folder()}))[0].name).toBe("local(http://127.0.0.1:8000/v1)");
  expect((await createVoiceProviders({stt:"local",sttLocalModel:folder(),apiKey:"test",sttModel:"m"}))[0]).toBeInstanceOf(UnsupportedSttProvider);
});
it("test_config_local_with_and_without_openai", async () => {
  const dir=folder();
  writeFileSync(join(dir,"model.bin"),"x"); writeFileSync(join(dir,"tokenizer.json"),"{}");
  for (const apiKey of ["test",undefined]) {
    const [stt] = await createVoiceProviders({stt:"local",sttLocalModel:dir,apiKey,sttModel:"m",sttLocalBeam:3});
    try {
      expect(stt).toBeInstanceOf(LanguageRoutedStt);
      expect(stt.localLanguages).toEqual(apiKey === undefined ? ["ko","en","zh","ja"] : ["ko"]);
    } finally { await stt.close?.(); }
  }
});
