import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { REPO_ROOT, setupAudio } from "../src/core/assets.ts";
import { loadConfig } from "../src/server/runtime.ts";
import { createVoiceProviders } from "../src/voice/config.ts";

async function main() {
  const { values } = parseArgs({ options: {
    force: { type: "boolean" }, lang: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help === true) {
    console.log("node scripts/record-setup-clips.ts [--force] [--lang ko|en|zh|ja]");
    return 0;
  }
  if (values.lang !== undefined && !["ko", "en", "zh", "ja"].includes(values.lang)) {
    console.error("--lang must be ko, en, zh or ja");
    return 2;
  }
  const dotenv = join(REPO_ROOT, ".env");
  if (existsSync(dotenv)) process.loadEnvFile(dotenv);
  const [, tts] = createVoiceProviders({ ...loadConfig().voice, ttsSpeed: 1 });
  if (!tts.supported) {
    console.error(".env에 OPENAI_API_KEY(또는 VOICE_API_KEY)가 있어야 녹음할 수 있어요.");
    return 1;
  }
  const manifest = z.record(z.string(), z.record(z.string(), z.string())).parse(
    JSON.parse(await readFile(join(setupAudio, "manifest.json"), "utf8"))
  );
  let made = 0;
  for (const [id, texts] of Object.entries(manifest)) {
    for (const [language, sentence] of Object.entries(texts)) {
      if (values.lang !== undefined && language !== values.lang) continue;
      const path = join(setupAudio, language, id + ".mp3");
      if (existsSync(path) && values.force !== true) continue;
      const { audio } = await tts.synthesize(sentence, { language, pace: 1 });
      await mkdir(join(setupAudio, language), { recursive: true });
      await writeFile(path, audio);
      made++;
      console.log(language + "/" + id + ".mp3 (" + audio.length + " bytes)");
    }
  }
  console.log("녹음 " + made + "개");
  return 0;
}
if (import.meta.main) process.exitCode = await main();
