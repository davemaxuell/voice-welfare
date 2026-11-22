import { z } from "zod";
import { asciiDecimalDigits, splitWhitespace, strip } from "../core/text.ts";
import { jsRound } from "../core/time.ts";
import { REDACTED, redactText } from "./privacy.ts";

export const verifyPatterns = {
  punctuation: /[\p{White_Space}"'“”‘’`.,!?;:·…()\[\]{}<>「」『』〈〉《》\-–—~\/\\|]+/gu,
  code: /\p{Nd}+(?:[-.]\p{Nd}+){1,}/gu,
  thousands: /^\p{Nd}{1,3}(?:,\p{Nd}{3})+(?=\n?$)/u,
  decimal: /^\p{Nd}+\.\p{Nd}+(?=\n?$)/u,
  number: /(\p{Nd}{1,3}(?:,\p{Nd}{3})+|\p{Nd}+(?:\.\p{Nd}+)?)\p{White_Space}*(조|억|천만|백만|만|천|千万|千萬|万|萬|亿|億|兆|千|thousand|m[iİ]ll[iİ]on|b[iİ]ll[iİ]on)?/giu,
  nonDigit: /\P{Nd}/gu,
  codeSeparator: /[-.]/u,
  blank: /^\p{White_Space}*(?=\n?$)/u,
  date: /\p{Nd}+\.\p{Nd}+\.\p{Nd}+/u,
  article: /제\p{White_Space}*$/u,
  sentenceBreak: /[\r\n]+|(?<=[.!?。])[\p{White_Space}\u001c-\u001f]+/u,
};

export const PUBLIC_FACT_LABELS = {
  documents: "필요한 서류", dates: "기간", eligibility: "대상", amount: "금액",
  procedure: "방법", contact: "연락처", location: "위치", other: "요청한 정보", page_title: "페이지 제목",
} as const;
export type PublicFact = keyof typeof PUBLIC_FACT_LABELS;
export interface PublicSource { url: string; title: string }

const claimShape = z.object({ fact: z.unknown(), quote: z.unknown() }).partial();

function collapseSpaces(text: string): string {
  return splitWhitespace(text).join(" ");
}

/** 요청한 사실별로 공식 페이지에서 다시 찾은 문장을 보관한다. */
export class PublicEvidence {
  readonly required: readonly PublicFact[];
  readonly passages = new Map<PublicFact, Array<[url: string, passage: string]>>();

  constructor(required: readonly PublicFact[]) {
    this.required = required;
  }

  // 원문 문장 전체를 보존한다. 연속된 표 행·문장을 인용하는 경우도 허용한다.
  static passage(quote: string, source: string): string | undefined {
    const lines = source.split(verifyPatterns.sentenceBreak).filter(row => strip(row).length > 0).map(collapseSpaces);
    const start = lines.join(" ").indexOf(quote);
    if (start < 0) return undefined;
    let offset = 0;
    const selected: string[] = [];
    for (const line of lines) {
      if (offset >= start + quote.length) break;
      if (offset + line.length > start) selected.push(line);
      offset += line.length + 1;
    }
    const passage = selected.join(" ");
    const length = Array.from(passage).length;
    return length > 0 && length <= 500 ? passage : undefined;
  }

  collect(claims: unknown, pages: ReadonlyMap<string, string>, { observedRow = false }: { observedRow?: boolean } = {}): void {
    for (const claim of Array.isArray(claims) ? claims.slice(0, 12) : []) {
      const parsed = claimShape.safeParse(claim);
      if (!parsed.success) continue;
      const fact = this.required.find(name => name === parsed.data.fact);
      const raw = parsed.data.quote;
      if (fact === undefined || typeof raw !== "string") continue;
      const length = Array.from(strip(raw)).length;
      if (length < (observedRow ? 1 : 5) || length > 500) continue;
      const quote = collapseSpaces(raw);
      for (const [url, source] of [...pages].reverse()) {
        const passage = observedRow
          ? (collapseSpaces(source).includes(quote) ? quote : undefined)
          : PublicEvidence.passage(quote, source);
        if (passage !== undefined && passage.length > 0 && !passage.includes(REDACTED) && redactText(passage) === passage) {
          const bucket = this.passages.get(fact) ?? [];
          this.passages.set(fact, bucket);
          const fromPage = bucket.filter(([u]) => u === url);
          if (bucket.length < 16 && fromPage.length < 4 && !fromPage.some(([, p]) => p === passage)) bucket.push([url, passage]);
          break;
        }
      }
    }
  }

  get missing(): PublicFact[] {
    return this.required.filter(fact => !this.passages.has(fact));
  }

  result(titles: ReadonlyMap<string, string>): [speech: string, sources: PublicSource[]] {
    const rows = this.required.flatMap(fact => this.passages.get(fact) ?? []);
    let speech = [...new Set(rows.map(([, quote]) => quote))].join(" ");
    const missing = this.missing;
    if (missing.length > 0) {
      const labels = missing.map(fact => PUBLIC_FACT_LABELS[fact]).join(", ");
      speech = strip(`${speech} 공식 자료에서 ${labels} 항목은 아직 확인하지 못했어요.`);
    }
    return [speech, [...new Set(rows.map(([url]) => url))].map(url => ({ url, title: titles.get(url) ?? "" }))];
  }
}

export function normalizeForMatch(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(verifyPatterns.punctuation, "");
}

function bigrams(points: string[]): string[] {
  return points.slice(1).map((point, index) => points[index] + point);
}

export function quoteInSource(quote: string, source: string): boolean {
  const normalizedQuote = normalizeForMatch(quote);
  const normalizedSource = normalizeForMatch(source);
  const q = Array.from(normalizedQuote);
  if (q.length < 4) return false;
  if (normalizedSource.includes(normalizedQuote)) return true;
  const src = Array.from(normalizedSource);
  if (src.length < q.length * 0.7) return false;

  const grams = bigrams(q);
  const sourceGrams = bigrams(src);
  const starts = new Set<number>();
  for (const gram of grams.slice(0, 6)) {
    let from = 0;
    for (let occurrence = 0; occurrence < 20; occurrence++) {
      const at = sourceGrams.indexOf(gram, from);
      if (at < 0) break;
      starts.add(Math.max(0, at - 4));
      from = at + 1;
    }
  }
  for (const start of starts) {
    const counts = new Map<string, number>();
    const window = src.slice(start, start + Math.ceil(q.length * 1.2));
    for (const gram of bigrams(window)) counts.set(gram, (counts.get(gram) ?? 0) + 1);
    let hits = 0;
    for (const gram of grams) {
      const count = counts.get(gram) ?? 0;
      if (count > 0) {
        hits++;
        counts.set(gram, count - 1);
      }
    }
    if (hits / grams.length >= 0.85) return true;
  }
  return false;
}

const multipliers = new Map<string, number>([
  ["천", 1e3], ["만", 1e4], ["백만", 1e6], ["천만", 1e7], ["억", 1e8], ["조", 1e12],
  ["千", 1e3], ["万", 1e4], ["萬", 1e4], ["千万", 1e7], ["千萬", 1e7], ["亿", 1e8], ["億", 1e8], ["兆", 1e12],
  ["thousand", 1e3], ["million", 1e6], ["billion", 1e9],
]);

export interface Numbers {
  values: Set<number>;
  codes: Set<string>;
  raw: string[];
}

/** canonical이면 반올림하지 않고 단위를 곱한 값만 모은다(번역 전후의 수치 비교용). */
export function extractNumbers(text: string, { canonical = false }: { canonical?: boolean } = {}): Numbers {
  const values = new Set<number>();
  const codes = new Set<string>();
  const raw: string[] = [];
  const rest = text.replace(verifyPatterns.code, code => {
    if (verifyPatterns.thousands.test(code) || verifyPatterns.decimal.test(code)) return code;
    codes.add(code.replace(verifyPatterns.nonDigit, ""));
    raw.push(code);
    for (const part of code.split(verifyPatterns.codeSeparator)) values.add(Number(asciiDecimalDigits(part)));
    return " ";
  });

  let chain = "";
  let total = 0;
  let lastEnd = 0;
  function flush() {
    if (chain !== "") {
      values.add(canonical ? total : jsRound(total));
      raw.push(strip(chain));
    }
    total = 0;
    chain = "";
  }
  for (const match of rest.matchAll(verifyPatterns.number)) {
    const digits = match[1]!;
    const amount = Number(asciiDecimalDigits(digits.replaceAll(",", "")));
    let unit = match[2];
    // 법령의 제29조에서 '조'는 조 단위의 수가 아니다.
    if (unit === "조" && verifyPatterns.article.test(rest.slice(Math.max(0, match.index - 4), match.index))) unit = undefined;
    const gap = rest.slice(lastEnd, match.index);
    if (chain === "" || !verifyPatterns.blank.test(gap) || unit === undefined) flush();
    if (unit !== undefined) {
      // 단위 정규식은 İ·ſ도 i·s로 받지만 toLowerCase()는 "i̇"·"ſ"를 내므로 보이는 ASCII 글자로 바꿔 찾는다.
      const multiplier = multipliers.get(unit.replaceAll("İ", "i").replaceAll("ſ", "s").toLowerCase());
      if (multiplier === undefined) throw new RangeError(`숫자 단위를 읽을 수 없습니다: ${unit}`);
      total += amount * multiplier;
      if (!canonical) values.add(amount);
    } else {
      total += amount;
    }
    chain += match[0];
    lastEnd = match.index + match[0].length;
    if (unit === undefined) flush();
  }
  flush();
  return { values, codes, raw };
}

export function unsupportedNumbers(answer: string, sources: readonly string[]): string[] {
  const source = extractNumbers(sources.join("\n"));
  const given = extractNumbers(answer);
  const missing = new Set<string>();
  for (const code of given.codes) {
    if (!source.codes.has(code)) missing.add(code);
  }
  for (const raw of given.raw) {
    if (raw.includes("-") || verifyPatterns.date.test(raw)) continue;
    const values = [...extractNumbers(raw).values];
    if (!values.some(value => source.values.has(value)) && !values.every(value => value <= 10)) missing.add(raw);
  }
  return [...missing];
}

export interface GroundingCheck {
  ok: boolean;
  reasons: string[];
  matchedQuotes: string[];
  unsupportedNumbers: string[];
}

export function checkGrounding({ answer, sources, quotes = [], allowed = [], minQuotes = 1 }: {
  answer: string;
  sources: readonly string[];
  quotes?: Iterable<unknown>;
  allowed?: readonly string[];
  minQuotes?: number;
}): GroundingCheck {
  const reasons = [];
  const offered = Array.from(quotes).filter((quote): quote is string => typeof quote === "string")
    .map(strip).filter(quote => quote.length > 0);
  const matchedQuotes = offered.filter(quote => sources.some(source => quoteInSource(quote, source)));
  if (minQuotes > 0 && matchedQuotes.length < minQuotes) {
    reasons.push(offered.length > 0 ? "근거로 든 문장이 원문에 없음" : "근거 문장이 없음");
  }
  const missing = unsupportedNumbers(answer, [...sources, ...allowed]);
  if (missing.length > 0) reasons.push("근거에 없는 숫자: " + missing.join(", "));
  return { ok: reasons.length === 0, reasons, matchedQuotes, unsupportedNumbers: missing };
}
