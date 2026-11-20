import { hasText, casefold, rstripChars, splitWhitespace, strip, stripChars } from "../../core/text.ts";
import { tryUrl } from "../../core/url.ts";
import { parseRegionMention, provinceName } from "../../core/region.ts";
import type { ServiceSummary, WelfareDataProvider, WelfareService } from "./data/index.ts";
import { officialDistricts, type ServiceLinkShelf } from "./open_data/index.ts";
import { urlCredentials } from "./urlsplit.ts";

export const welfareLinkPatterns = {
  siteCue: /(?:관련|공식)?\p{White_Space}*(?:사이트|홈페이지|누리집)/u,
  stripSite: /(?:복지로|관련|공식)?\p{White_Space}*(?:홈페이지|웹\p{White_Space}*사이트|사이트|누리집|상세\p{White_Space}*페이지|공식\p{White_Space}*안내|페이지|안내)/gu,
  formCue: /(?:서식|양식|신청서|다운로드|첨부)/u,
  regionSuffix: /(?:의|에서|에)(?=\n?$)/u,
  openCommand: /(을|를|에|로|으로|좀)?\p{White_Space}*(열어|접속|들어가|이동해|가|켜|띄워)\P{White_Space}*\p{White_Space}*(줘|주세요|봐)?/gu,
  guideCue: /^([^\n]+?)(?:의|은|는|을|를|이|가|에\p{White_Space}*대한|에서)?\p{White_Space}*(?:신청\p{White_Space}*(?:방법|절차|하는\p{White_Space}*법|서류|서식|양식|기간|기한|대상|자격|조건|사이트|홈페이지|안내)|(?:어떻게|어디(?:서|에서)?)\p{White_Space}*신청|지원\p{White_Space}*(?:대상|내용|금액|조건|기준|기간|방법)|선정\p{White_Space}*기준|제출\p{White_Space}*서류|구비\p{White_Space}*서류|준비\p{White_Space}*서류|필요한?\p{White_Space}*서류|서류|서식|양식|신청서|문의처?|전화번호|연락처|(?:관련|공식)\p{White_Space}*(?:사이트|홈페이지|누리집|안내)|홈페이지|누리집|얼마|자격|대상|혜택|기간|마감|기한|안내|알려|찾아|확인해|보여)/u,
  bokjiroPrefix: /^(?:복지로|bokj[iİ]ro)(?:에서|에|가서|들어가서|열어서)?\p{White_Space}*/iu,
  officialGuide: /복지로|상세\p{White_Space}*페이지|공식\p{White_Space}*안내/u,
};

export interface RegionHints { ctpv?: string | null; sgg?: string | null }
export interface DirectLink {name: string; url: string; sourceId: string}
interface LinkBundle {servId: string; servNm: string; detailUrl?: string; relatedSites: DirectLink[]; forms: DirectLink[]; sourceIds: string[]}
const key = (text: string) => casefold(splitWhitespace(text).join(""));
const length = (text: string) => Array.from(text).length;
const bokjiroOrigins = ["https://bokjiro.go.kr", "https://www.bokjiro.go.kr"];

export function verifiedBokjiroUrl(raw: string | undefined, id: string): string | undefined {
  const url = tryUrl(raw);
  return url !== undefined && bokjiroOrigins.includes(url.origin) && id !== "" && url.param("wlfareInfoId") === id ? url.href : undefined;
}

function publicUrl(raw: string): string | undefined {
  const text = strip(raw);
  const credentials = urlCredentials(text);
  const url = tryUrl(text);
  return url !== undefined && ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".") && url.hostname !== "127.0.0.1" &&
    (credentials.username ?? "") === "" && (credentials.password ?? "") === "" ? url.href : undefined;
}

export function regionHints(text: string, hints: RegionHints): RegionHints {
  const mention = parseRegionMention(text);
  let province = mention.province.length > 0 ? mention.province : hints.ctpv;
  const district = mention.districts[0] ?? (mention.province !== "" && mention.province !== hints.ctpv ? undefined : hints.sgg);
  if (hasText(district) && !hasText(province)) {
    const provinces = new Set(officialDistricts().get(district)?.map(([name]) => name));
    if (provinces.size === 1) [province] = provinces;
  }
  return {ctpv: province, sgg: district};
}

function stripPrefix(name: string): string {
  const tokens = splitWhitespace(name);
  let index = 0;
  while (index < tokens.length - 1) {
    const token = stripChars(tokens[index] ?? "", ".,!?").replace(welfareLinkPatterns.regionSuffix, "");
    if (provinceName(token) === "" && !(/[시군구]$/u.test(token) && officialDistricts().has(token))) break;
    index++;
  }
  return index > 0 ? tokens.slice(index).join(" ") : strip(name);
}

export function mergeDirectLinks(entries: readonly DirectLink[]): DirectLink[] {
  const seen = new Map<string, DirectLink>();
  for (const entry of entries) {
    const url = tryUrl(publicUrl(entry.url));
    if (url === undefined) continue;
    const k = casefold(url.hostname.replace(/^www\./u, "") + rstripChars(url.pathname, "/") + url.search);
    const previous = seen.get(k);
    if (previous === undefined) seen.set(k, {...entry, url: url.href});
    else if (previous.name === "") previous.name = entry.name;
  }
  return [...seen.values()];
}

function validLinks(rows: readonly {name: string; url: string}[], sourceId: string): DirectLink[] {
  return rows.flatMap(row => {
    const url = publicUrl(row.url);
    return url === undefined ? [] : [{name: strip(row.name), url, sourceId}];
  });
}

export function detailLinks(detail: WelfareService, id: string): [DirectLink[], DirectLink[]] {
  let sites = validLinks(detail.relatedSites ?? [], id);
  if (sites.length === 0) sites = validLinks((detail.contacts ?? []).map(row => ({name: row.name, url: row.value})), id);
  return [sites, validLinks(detail.forms ?? [], id)];
}

function pickSite(sites: DirectLink[], query: string): DirectLink | undefined {
  if (sites.length === 1) return sites[0];
  const q = key(query);
  const named = sites.filter(s => length(key(s.name)) >= 2 && q.includes(key(s.name)));
  if (named.length === 1) return named[0];
  const primary = sites.filter(s => !casefold(s.url).includes("129.go.kr"));
  return primary.length === 1 ? primary[0] : undefined;
}

function matchRow(catalog: ServiceSummary[], name: string, {ctpv, sgg}: RegionHints): ServiceSummary[] {
  if (key(name) === "") return [];
  let rows = catalog.filter(row => key(row.servNm) === key(name));
  if (hasText(sgg)) {
    const same = rows.filter(row => row.region?.sgg === sgg);
    rows = same.length > 0 ? same : rows.filter(row => !hasText(row.region?.sgg));
  }
  if (rows.length > 1 && hasText(ctpv)) {
    const same = rows.filter(row => row.region?.ctpv === ctpv);
    if (same.length > 0) rows = same;
  }
  return rows;
}

export class WelfareLinks {
  readonly provider: WelfareDataProvider;
  protected readonly links?: ServiceLinkShelf;
  protected selectedDetail?: WelfareService;

  constructor(provider: WelfareDataProvider, links?: ServiceLinkShelf) {
    this.provider = provider;
    this.links = links;
  }

  private async loadCatalog(ctpv?: string | null): Promise<ServiceSummary[]> {
    try { return await this.provider.catalog(ctpv ?? undefined); }
    catch (error) {
      if (error instanceof Error && (error instanceof RangeError || "code" in error)) return [];
      throw error;
    }
  }

  async directLinks(name: string, options: RegionHints & {includeDetail?: boolean} = {}): Promise<LinkBundle | undefined> {
    const region = regionHints(name, options);
    const candidates = [...new Set([strip(name), stripPrefix(name)])];
    const catalog = await this.loadCatalog(region.ctpv);
    let row: ServiceSummary | undefined;
    for (const candidate of candidates) {
      const matches = matchRow(catalog, candidate, region);
      if (matches.length > 1) return undefined;
      [row] = matches;
      if (row !== undefined) break;
    }
    const csv = row === undefined ? candidates.map(n => this.links?.byName(n)).find(r => r !== undefined) : this.links?.byId(row.servId);
    if (row === undefined && csv === undefined) return undefined;
    const servId = row?.servId ?? csv?.serv_id ?? "";
    const servNm = row?.servNm ?? csv?.name ?? "";
    const apiId = row?.provider === "local" ? "15108347" : "15090532";
    const sourceIds: string[] = [];
    let detailUrl = verifiedBokjiroUrl(row?.detailUrl, servId);
    if (hasText(row?.detailUrl) && detailUrl === undefined) return undefined;
    if (detailUrl !== undefined) sourceIds.push(apiId);
    const csvSites = validLinks(csv?.sites ?? [], "15083323");
    detailUrl ??= verifiedBokjiroUrl(csv?.detail_url, servId);
    if (csvSites.length > 0 || (row === undefined && detailUrl !== undefined)) sourceIds.push("15083323");
    let detail = this.selectedDetail?.servId === servId ? this.selectedDetail : undefined;
    if (detail === undefined && options.includeDetail === true && servId !== "") {
      try {
        if (row?.provider === "local") detail = await this.provider.getLocalService?.(servId, detailUrl ?? "");
        else if (row !== undefined || this.provider.mode === "official-api") detail = await this.provider.getService(servId, detailUrl ?? "");
      } catch { /* 상세 조회에 실패해도 검증된 목록·CSV 주소는 남는다. */ }
    }
    const [apiSites, apiForms] = detail?.servId === servId ? detailLinks(detail, apiId) : [[], []];
    if ((apiSites.length > 0 || apiForms.length > 0) && !sourceIds.includes(apiId)) sourceIds.push(apiId);
    const relatedSites = mergeDirectLinks([...apiSites, ...csvSites]);
    const forms = mergeDirectLinks(apiForms);
    return detailUrl === undefined && relatedSites.length === 0 && forms.length === 0 ? undefined : {servId, servNm, detailUrl, relatedSites, forms, sourceIds};
  }

  async applicationGuideUrl(name: string, region: RegionHints = {}): Promise<string | undefined> {
    return (await this.directLinks(name, region))?.detailUrl;
  }

  async resolveGuideTarget(question: string, options: RegionHints & {subject?: string | null; siteUrl?: string | null} = {}) {
    const dest = tryUrl(options.siteUrl);
    if (dest !== undefined && !(bokjiroOrigins.includes(dest.origin) && dest.pathname === "/")) return undefined;
    const region = regionHints(question, options);
    const q = strip(strip(question).replace(welfareLinkPatterns.bokjiroPrefix, ""));
    const wantsSite = welfareLinkPatterns.siteCue.test(q);
    const wantsForm = welfareLinkPatterns.formCue.test(q);
    const candidates = new Set([options.subject, welfareLinkPatterns.guideCue.exec(q)?.[1], this.links?.matchInText(q)?.name].flatMap(n => hasText(n) && strip(n).length > 0 ? [strip(n)] : []));
    if (candidates.size === 0 || (hasText(region.ctpv) && !hasText(options.subject))) {
      const text = key(q);
      const matches = (await this.loadCatalog(region.ctpv)).map(r => strip(r.servNm)).filter(n => length(key(n)) >= 4 && text.includes(key(n))).sort((a,b) => length(key(b)) - length(key(a)));
      const unique: string[] = [];
      for (const n of matches) if (!unique.some(other => key(other).includes(key(n)))) unique.push(n);
      if (unique.length === 1 && unique[0] !== undefined) candidates.add(unique[0]);
    }
    for (const candidate of candidates) {
      const links = await this.directLinks(candidate, {...region, includeDetail: wantsSite || wantsForm});
      if (links === undefined) continue;
      if (dest === undefined && wantsSite) {
        const site = pickSite(links.relatedSites, q);
        if (site !== undefined) return {url: site.url, kind: "related-site" as const, label: hasText(site.name) ? site.name : links.servNm, links};
      }
      if (links.detailUrl !== undefined) return {url: links.detailUrl, kind: "bokjiro" as const, links};
    }
    return undefined;
  }

  async resolveSiteLink(target: string, region: RegionHints = {}) {
    const clean = (text: string) => stripChars(text.replace(/\p{White_Space}+/gu, " "), " .,!?");
    const cleaned = clean(target.replace(welfareLinkPatterns.openCommand, " "));
    if (length(cleaned) < 2) return undefined;
    const related = welfareLinkPatterns.siteCue.test(cleaned);
    const bokjiro = welfareLinkPatterns.officialGuide.test(cleaned);
    const bare = clean(cleaned.replace(welfareLinkPatterns.stripSite, " "));
    if (!bokjiro && this.links) {
      const site = this.links.relatedSite(cleaned) ?? this.links.relatedSite(bare);
      const url = site === undefined ? undefined : publicUrl(site.url);
      if (url !== undefined && site !== undefined) return {url, label: [site.name, bare].find(hasText) ?? cleaned, kind: "related-site" as const, sourceId: "15083323"};
    }
    if (length(bare) < 2) return undefined;
    const bundle = await this.directLinks(bare, {...region, includeDetail: related});
    if (bundle === undefined) return undefined;
    const picked = related && !bokjiro ? pickSite(bundle.relatedSites, cleaned) : undefined;
    if (picked !== undefined) return {url: picked.url, label: hasText(picked.name) ? picked.name : bundle.servNm, kind: "related-site" as const, sourceId: picked.sourceId};
    return bundle.detailUrl === undefined ? undefined : {url: bundle.detailUrl, label: `복지로 ${bundle.servNm}`, kind: "bokjiro" as const, sourceId: bundle.sourceIds[0]};
  }
}
