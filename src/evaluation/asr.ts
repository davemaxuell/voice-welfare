import { spokenDigitSpans } from "../safety/privacy.ts";
import { normalizeForMatch } from "../safety/verify.ts";

export function cer(reference: string, hypothesis: string): number {
  const a = [...normalizeForMatch(reference)],
    b = [...normalizeForMatch(hypothesis)];
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (const [i, char] of a.entries()) {
    const next = [i + 1];
    for (const [j, other] of b.entries()) {
      next.push(Math.min(previous[j + 1]! + 1, next[j]! + 1, previous[j]! + Number(other !== char)));
    }
    previous = next;
  }
  return previous[b.length]! / a.length;
}
export const asrPatterns = {
  runs: /\p{Nd}(?:[\p{Nd}\p{White_Space}-]*\p{Nd})?/gu,
  separators: /[\p{White_Space}-]/gu,
};
export function digitRuns(text: string): string[] {
  const points = [...text];
  for (const [start, end, digits] of spokenDigitSpans(text).reverse()) points.splice(start, end - start, digits);
  return [...points.join("").matchAll(asrPatterns.runs)].map(([run]) => run.replace(asrPatterns.separators, ""));
}
export function hasSpelledNumbers(text: string): boolean {
  return spokenDigitSpans(text).length > 0;
}
