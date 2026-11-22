// node scripts/record-setup-clips.ts [--force] [--lang ko|en|zh|ja] [--clip ID]
// To use the desktop's saved key, set CHEONGEUM_EVAL_SETTINGS_DIR to its settings directory.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { REPO_ROOT, setupAudio } from "../src/core/assets.ts";
import { OPENAI_BASE_URL } from "../src/core/llm.ts";
import { STACK } from "../src/core/model_stack.ts";
import { VOICE_PROFILE } from "../src/core/voice_profile.ts";
import { loadConfig } from "../src/server/runtime.ts";
import { SettingsStore } from "../src/server/settings.ts";
import { LiveSpeechProvider } from "../src/voice/live_speech.ts";

const languages = z.enum(["ko", "en", "zh", "ja"]);
const clips = z.record(z.string().regex(/^[a-z0-9-]+$/u), z.partialRecord(languages, z.string().min(1)));
const pythonAudio = join(REPO_ROOT, "src/cheongeum/web/static/setup-audio");

function recordingVoice() {
  const env = join(REPO_ROOT, ".env");
  if (existsSync(env)) process.loadEnvFile(env);
  const directory = process.env.CHEONGEUM_EVAL_SETTINGS_DIR;
  const settings = directory === undefined ? undefined : new SettingsStore(join(directory, "preferences.json"));
  const voice = loadConfig().voice;
  const saved = settings?.key ?? "";
  const configured = voice.baseUrl?.replace(/\/+$/u, "") === OPENAI_BASE_URL ? voice.apiKey : undefined;
  const apiKey = saved.length > 0 ? saved : configured;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("Set OPENAI_API_KEY or CHEONGEUM_EVAL_SETTINGS_DIR to record the setup prompts.");
  }
  return new LiveSpeechProvider({ apiKey, baseUrl: OPENAI_BASE_URL, voice: VOICE_PROFILE.voice, speed: 1,
    instructions: VOICE_PROFILE.instructions + " Record this accessibility prompt once, without introducing yourself, translating, or delegating.",
  });
}

async function record(voice: LiveSpeechProvider, path: string, text: string, language: string) {
  // The reader returns only voiced audio with a transcript that matches the requested text.
  const { audio } = await voice.synthesize(text, { language });
  const temporary = path + "." + randomUUID() + ".mp3";
  try {
    const result = spawnSync("ffmpeg", ["-v", "error", "-f", "wav", "-i", "pipe:0", "-codec:a", "libmp3lame",
      "-q:a", "2", "-metadata", "artist=OpenAI", "-metadata", `comment=${STACK.voice} / ${voice.voice}`, temporary],
    { input: audio, windowsHide: true });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error("ffmpeg failed: " + result.stderr.toString());
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    force: { type: "boolean" }, lang: { type: "string" }, clip: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help === true) {
    console.log("node scripts/record-setup-clips.ts [--force] [--lang ko|en|zh|ja] [--clip ID] (requires ffmpeg)");
    return;
  }
  const manifest = clips.parse(JSON.parse(readFileSync(join(setupAudio, "manifest.json"), "utf8")));
  const selected = values.lang === undefined ? undefined : languages.parse(values.lang);
  let voice: LiveSpeechProvider | undefined;
  let matched = 0;
  for (const [id, texts] of Object.entries(manifest)) {
    if (values.clip !== undefined && values.clip !== id) continue;
    for (const [language, text] of Object.entries(texts)) {
      if (selected !== undefined && selected !== language) continue;
      matched++;
      const relative = join(language, id + ".mp3");
      const path = join(setupAudio, relative);
      const mirror = join(pythonAudio, relative);
      if (values.force === true || !existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        voice ??= recordingVoice();
        await record(voice, path, text, language);
        console.log(relative);
      }
      if (!existsSync(mirror) || !readFileSync(mirror).equals(readFileSync(path))) {
        mkdirSync(dirname(mirror), { recursive: true });
        copyFileSync(path, mirror);
      }
    }
  }
  if (matched === 0) throw new Error("No matching setup prompt in manifest.json.");
}

if (import.meta.main) await main();
