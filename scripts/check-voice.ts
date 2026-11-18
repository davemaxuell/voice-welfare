import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../src/core/assets.ts";
import { loadConfig } from "../src/server/runtime.ts";
import { createVoiceProviders } from "../src/voice/config.ts";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const [stt, tts] = await createVoiceProviders(loadConfig().voice);
try {
  console.log(`STT: ${stt.supported ? stt.name : "미설정(브라우저 음성 사용)"} · TTS: ${tts.supported ? tts.name : "미설정(브라우저 음성 사용)"}`);
  const sentence = "주소는 부산광역시 예시구 예시로 10";
  if (tts.supported) {
    const start = performance.now();
    const {audio} = await tts.synthesize(sentence, {language: "ko"});
    await mkdir(join(REPO_ROOT, "reports"), {recursive: true});
    await writeFile(join(REPO_ROOT, "reports", "voice-check.mp3"), audio);
    console.log(`✓ TTS ${Math.floor(performance.now() - start)}ms, ${audio.length} bytes → reports/voice-check.mp3`);
    if (stt.supported) {
      const start = performance.now();
      const {text} = await stt.transcribe(audio, {language: "ko", mimeType: "audio/mpeg"});
      const normalize = (s: string) => s.replace(/[\p{White_Space}.,]/gu, "");
      const comparison = normalize(text) === normalize(sentence) ? "(원문과 일치)" : `(원문: "${sentence}")`;
      console.log(`✓ STT ${Math.floor(performance.now()-start)}ms: "${text}" ${comparison}`);
    }
  } else if (stt.supported) {
    console.log("TTS가 없어 STT 왕복 테스트는 건너뜁니다. 웹 UI에서 마이크로 확인하세요.");
  }
} finally {
  await stt.close?.();
}
