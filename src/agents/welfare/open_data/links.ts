/** 중앙부처 복지서비스 공식 CSV(15083323)의 복지로 상세 주소와 관련 사이트 색인. */
import { casefold, rstripChars, strip } from "../../../core/text.ts";
import { tryUrl } from "../../../core/url.ts";
import { fromIsoDate, LINKS, PYTHON_SPACE, type DatasetCitation, type RelatedSite, type ServiceLink } from "./datasets.ts";

export const linksPatterns = {
  // Python의 $는 끝 줄바꿈 앞에서도 맞는다.
  siteSuffix: new RegExp(String.raw`(?:홈페이지|웹${PYTHON_SPACE}*사이트|사이트|누리집)(?=\n?$)`, "gu"),
  space: new RegExp(`${PYTHON_SPACE}+`, "gu"),
};

function key(text: string): string {
  return casefold(text.replace(linksPatterns.space, ""));
}

function urlKey(url: string): string {
  const parsed = tryUrl(url);
  if (parsed === undefined) return rstripChars(casefold(url), "/");
  const host = parsed.hostname.startsWith("www.") ? parsed.hostname.slice("www.".length) : parsed.hostname;
  const path = parsed.pathname === "/" ? "" : rstripChars(parsed.pathname, "/");
  return casefold(`${host}${path}${parsed.search}`);
}

const length = (text: string) => Array.from(text).length;

export class ServiceLinkShelf {
  readonly records: readonly ServiceLink[];
  /** YYYY-MM-DD. 자료가 없으면 없다. */
  readonly referenceDate: string | undefined;
  private readonly idIndex = new Map<string, ServiceLink>();
  private readonly nameIndex = new Map<string, ServiceLink[]>();
  private readonly siteIndex = new Map<string, RelatedSite[]>();

  constructor(records: readonly ServiceLink[] = [], referenceDate?: string) {
    this.records = records;
    this.referenceDate = referenceDate === undefined || referenceDate === "" ? undefined : fromIsoDate(referenceDate);
    for (const record of records) {
      this.idIndex.set(record.serv_id, record);
      const named = this.nameIndex.get(key(record.name));
      if (named === undefined) this.nameIndex.set(key(record.name), [record]);
      else named.push(record);
      for (const site of record.sites) {
        if (site.name.length === 0) continue;
        const bare = strip(site.name.replace(linksPatterns.siteSuffix, ""));
        const keys = new Set([key(site.name)]);
        if (bare.length > 0 && length(key(bare)) >= 2) keys.add(key(bare));
        for (const k of keys) {
          if (k.length === 0) continue;
          const labeled = this.siteIndex.get(k);
          if (labeled === undefined) this.siteIndex.set(k, [site]);
          else labeled.push(site);
        }
      }
    }
  }

  citation(note = ""): DatasetCitation | undefined {
    return this.referenceDate === undefined ? undefined : LINKS.citation(this.referenceDate, note);
  }

  byId(servId: string): ServiceLink | undefined {
    return this.idIndex.get(servId);
  }

  byName(name: string): ServiceLink | undefined {
    const matches = this.nameIndex.get(key(name)) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** 문장에 공식 서비스 이름이 뚜렷하고 유일하게 들어 있을 때만 돌려준다. */
  matchInText(text: string): ServiceLink | undefined {
    if (this.records.length === 0 || strip(text).length === 0) return undefined;
    const direct = this.byName(text);
    if (direct !== undefined) return direct;
    const compactText = key(text);
    const found: [number, string, ServiceLink][] = [];
    for (const [k, rows] of this.nameIndex) {
      const [only] = rows;
      if (rows.length !== 1 || only === undefined || length(k) < 4) continue;
      if (compactText.includes(k)) found.push([length(k), k, only]);
    }
    if (found.length === 0) return undefined;
    found.sort((a, b) => b[0] - a[0]);
    const kept: [string, ServiceLink][] = [];
    for (const [, k, record] of found) {
      if (kept.some(([existing]) => existing.includes(k))) continue;
      kept.push([k, record]);
    }
    const [first] = kept;
    return kept.length === 1 && first !== undefined ? first[1] : undefined;
  }

  /** 관련 사이트 이름과 정확히 일치하고 가리키는 주소가 하나뿐일 때만 돌려준다. */
  relatedSite(query: string): RelatedSite | undefined {
    const cleaned = strip(strip(query).replace(linksPatterns.siteSuffix, ""));
    for (const candidate of [query, cleaned]) {
      const k = key(candidate);
      if (k.length === 0 || length(k) < 2) continue;
      const hits = this.siteIndex.get(k);
      if (hits === undefined || hits.length === 0) continue;
      const unique = new Map<string, RelatedSite>();
      for (const site of hits) unique.set(urlKey(site.url), site);
      const [only] = unique.values();
      return unique.size === 1 ? only : undefined;
    }
    return undefined;
  }
}
