import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { setupAudio } from "../../src/core/assets.ts";
import { strip } from "../../src/core/text.ts";

// 키를 넣기 전(1단계)에는 녹음해 둔 문장을 튼다. 화면 글과 녹음 글이 같은 목록(manifest)에서 나온다.
const MANIFEST = z.record(z.string(), z.record(z.string(), z.string())).parse(JSON.parse(readFileSync(join(setupAudio, "manifest.json"), "utf8")));
const LANGS = new Set(["ko", "en", "zh", "ja"]);

it("test_every_manifest_entry_has_a_clip_for_each_of_its_languages", () => {
  for (const [clipId, texts] of Object.entries(MANIFEST)) {
    for (const [lang, text] of Object.entries(texts)) {
      const clip = statSync(join(setupAudio, lang, `${clipId}.mp3`), { throwIfNoEntry: false });
      expect(strip(text).length > 0 && clip?.isFile() === true && clip.size > 0, `${clipId} ${lang}`).toBe(true);
    }
  }
});

it("test_shared_steps_exist_in_all_four_languages_and_language_options_in_their_own", () => {
  for (const [clipId, texts] of Object.entries(MANIFEST)) {
    expect(new Set(Object.keys(texts)), clipId).toEqual(clipId.startsWith("lang-") ? new Set([clipId.slice("lang-".length)]) : LANGS);
  }
});

it("test_stage1_has_every_step_the_wizard_plays", () => {
  const want = ["lang-ko", "lang-en", "lang-zh", "lang-ja", "who", "key-alone", "key-checking", "key-invalid", "key-quota", "key-network", "pc", "handover"];
  for (const clipId of want) expect(Object.keys(MANIFEST)).toContain(clipId);
  expect(MANIFEST.who?.ko).toBe("지금 누가 설정하고 계세요? 사용하실 분 본인이면 1번, 가족이나 복지관 직원이면 2번.");
});
