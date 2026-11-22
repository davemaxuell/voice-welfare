/** 브라우저 및 음성용 검색어. 공급자의 검색식은 이 경계 안으로 전달하지 않는다. */
declare const visibleTerms: unique symbol;
export type SiteSearchTerms = string & {readonly [visibleTerms]: true};

const words = new Intl.Segmenter("ko", {granularity: "word"});
const characters = new Intl.Segmenter("ko", {granularity: "grapheme"});

/** 모델이 준 단어 배열을 전체로 검증한다. 식을 잘라 다른 검색어로 고치지 않는다. */
export function siteSearchTerms(input: unknown): SiteSearchTerms | undefined {
  const parts = typeof input === "string" ? [input] : input;
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const terms: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string" || part.trim().length === 0) return undefined;
    for (const {segment} of characters.segment(part)) {
      if (segment.trim().length > 0 && words.segment(segment).containing(0)?.isWordLike !== true) return undefined;
    }
    terms.push(part.trim());
  }
  return terms.length === 0 ? undefined : terms.join(" ") as SiteSearchTerms;
}
