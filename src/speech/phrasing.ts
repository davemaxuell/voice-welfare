import { asciiDecimalDigits, strip } from "../core/text.ts";
import { maskValue } from "../safety/privacy.ts";

export const READ_CHUNK = 350;
export const phrasingPatterns = {
  wordTail: /[\p{White_Space})）'"’”]+(?=\n?$)/u,
  digit: /[0-9]/u,
  letterWithBatchim: /[LMNR](?=\n?$)/iu,
  optionalLabel: /\p{White_Space}*\(선택\)(?=\n?$)/u,
  sentenceEnd: /[.!?。]\p{White_Space}[^.!?。]*(?=\n?$)|다\.\p{White_Space}[^.]*(?=\n?$)/u,
};

export function josa(word: string, withBatchim: string, without: string): string {
  const last = Array.from(word.replace(phrasingPatterns.wordTail, "")).at(-1);
  if (last === undefined) return word + without;
  if (phrasingPatterns.digit.test(last)) return word + ("013678".includes(last) ? withBatchim : without);
  const syllable = last.charCodeAt(0) - 0xac00;
  const hasBatchim = syllable >= 0 && syllable <= 11171 ? syllable % 28 !== 0 : phrasingPatterns.letterWithBatchim.test(last);
  return word + (hasBatchim ? withBatchim : without);
}

export function speakLabel(label: string): string {
  return label.replace(phrasingPatterns.optionalLabel, "");
}

function dateInteger(part: string): string {
  const digits = asciiDecimalDigits(strip(part));
  if (!/^\+?[0-9](?:_?[0-9])*$/u.test(digits)) throw new Error("잘못된 날짜 숫자");
  return BigInt(digits.replaceAll("_", "")).toString();
}

export function speakDate(date: string): string {
  const parts = date.split("-").map(dateInteger);
  if (parts.length !== 3) throw new Error("날짜에 연·월·일 필요");
  return `${parts[1]}월 ${parts[2]}일`;
}

export function chunkText(text: string, offset: number, size = READ_CHUNK): string {
  const characters = Array.from(text);
  if (offset >= characters.length) return "";
  let end = Math.min(characters.length, offset + size);
  if (end < characters.length) {
    const window = characters.slice(offset, end).join("");
    const match = phrasingPatterns.sentenceEnd.exec(window);
    if (match !== null) {
      const cut = Array.from(window.slice(0, match.index)).length;
      if (cut > size * 0.5) end = offset + cut + 2;
    }
  }
  return strip(characters.slice(offset, end).join(""));
}

export function readback(field: { maskOnReadback: boolean }, value: string): string {
  return field.maskOnReadback && value.length > 0 ? maskValue(value) : value;
}
