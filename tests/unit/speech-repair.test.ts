import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { REPO_ROOT } from "../../src/core/assets.ts";
import { interpretSpeech, wordSuggestions } from "../../src/orchestrator/speech_repair.ts";
import { FakeLlm } from "../helpers.ts";

const context = { language: "ko", agency: "정부24", service: "주민등록등본", recentTurns: [] };
const signal = new AbortController().signal;

it("reconstructs the same public names and corroborating clues as the Python reference", () => {
  const rows = z.object({ words: z.array(z.tuple([z.string(), z.array(z.object({ text: z.string(), label: z.string() })), z.boolean()])) })
    .parse(JSON.parse(readFileSync(join(REPO_ROOT, "tests/fixtures/personal/speech-repair.json"), "utf8"))).words;
  for (const [heard, suggestions, corroborated] of rows) expect(wordSuggestions(heard), heard).toEqual([suggestions, corroborated]);
});

it("only proposes a model correction for a read-only request and leaves it for confirmation", async () => {
  const model = new FakeLlm({ speech_repair: { suggestion: " 고용24 열어줘 " } });
  const result = await interpretSpeech("뉘엿 뭉개", "UNKNOWN", context, model, signal, () => "OPEN_SITE");
  expect(result).toEqual([[{ text: "고용24 열어줘", label: "고용24 열어줘" }], false]);
  expect(model.calls).toHaveLength(1);
  expect(JSON.parse(model.calls[0]?.user ?? "")).toEqual({ heard: "뉘엿 뭉개", context });
  for (const action of ["UNKNOWN", "PREPARE_APPLY", "SUBMIT"]) {
    expect(await interpretSpeech("뉘엿 뭉개", "UNKNOWN", context, model, signal, () => action)).toEqual([[], false]);
  }
});

it("keeps private or consequential requests out of speech correction and rejects sensitive suggestions", async () => {
  const model = new FakeLlm({ speech_repair: { suggestion: "비밀번호 알려줘" } });
  for (const [text, intent] of [["대신\u001c신청", "UNKNOWN"], ["[비공개] 입력", "UNKNOWN"], ["정부24 열어줘", "APPROVE"]] as const) {
    expect(await interpretSpeech(text, intent, context, model, signal, () => "GOAL")).toEqual([[], false]);
  }
  expect(model.calls).toHaveLength(0);
  expect(await interpretSpeech("뉘엿 뭉개", "UNKNOWN", context, model, signal, () => "GOAL")).toEqual([[], false]);
});
