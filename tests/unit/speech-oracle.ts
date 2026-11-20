import { z } from "zod";
import { LangSchema } from "../../src/core/turn.ts";
import { detectLangSwitch, detectScriptLang } from "../../src/language/i18n.ts";
import { chunkText, josa, readback, speakDate, speakLabel } from "../../src/speech/phrasing.ts";

export const speechImplementations = new Map<string, (args: Record<string, unknown>) => unknown>([
  ["language.i18n.detect_lang_switch", a => detectLangSwitch(z.string().parse(a.text)) ?? null],
  ["language.i18n.detect_script_lang", a => detectScriptLang(z.string().parse(a.text)) ?? null],
  ["speech.phrasing.josa", a => josa(z.string().parse(a.word), z.string().parse(a.with_batchim), z.string().parse(a.without))],
  ["speech.phrasing.speak_label", a => speakLabel(z.string().parse(a.label))],
  ["speech.phrasing.speak_date", a => speakDate(z.string().parse(a.date_str))],
  ["speech.phrasing.chunk_text", a => chunkText(z.string().parse(a.text), z.int().parse(a.offset), z.int().parse(a.size))],
  ["speech.phrasing.readback", a => {
    const field = z.object({ mask_on_readback: z.boolean() }).parse(a.field_);
    return readback({ maskOnReadback: field.mask_on_readback }, z.string().parse(a.value));
  }],
]);
