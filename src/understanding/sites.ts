import { KNOWN_SITES, type KnownSite as ListedSite } from "../core/sites.ts";
import type { Intent } from "../core/intents.ts";
import { splitWhitespace, strip } from "../core/text.ts";
import { addressSite, spokenAddressPatterns, tryUrl } from "../core/url.ts";

/**
 * 사이트 이름 → 주소. 목록에 없는 이름은 추측하지 않고 사용자에게 주소를 묻는다.
 * (주소를 직접 말하면 그대로 연다: "gov.kr 열어줘") 거꾸로 주소 → 말할 사이트 이름은 siteLabel.
 */
export { KNOWN_SITES };
/** 연습 사이트처럼 따로 넘기는 사이트는 대표 업무(services)가 없을 수 있다. */
export type KnownSite = Omit<ListedSite, "services"> & { services?: readonly string[] };
export type SiteAddress = Pick<KnownSite, "url" | "label">;

export const sitesPatterns = {
  ...spokenAddressPatterns,
  siteNoun: /(홈페이지|누리집|웹\p{White_Space}*사이트|사이트|페이지)/gu,
  openCommand: /(을|를|에|로|으로|좀)?\p{White_Space}*(열어|접속|들어가|이동해|가|켜|띄워)\P{White_Space}*\p{White_Space}*(줘|주세요|봐)?/gu,
  spaces: /\p{White_Space}+/gu,
  space: /\p{White_Space}/gu,
  otherThanHangul: /[^가-힣]/gu,
  particle: /(으로|에서|을|를|로|에|좀|이|가)(?=\n?$)/gu,
  hangulName: /^[가-힣]+(?=\n?$)/u,
  www: /^www\./gu,
  dotCom: /\p{White_Space}*(닷|점)\p{White_Space}*(컴|com)/gu,
  dotKr: /\p{White_Space}*(닷|점)\p{White_Space}*(케이알|kr)/gu,
  scholarshipType2: /(?:2|Ⅱ|ⅱ|ii)유형/u,
  scholarshipType1: /(?:1|Ⅰ|ⅰ|i)유형/u,
  civilPortal: /^민원(?:사이트|홈페이지|누리집)?(?:에서|으로|로|에|을|좀|열|접속|들어|가|$)/u,
  siteNameTail: /(?:사이트|누리집|홈페이지)?(?:요|이요)?[.!?]*(?=\n?$)/gu,
  guessDestination: /(에서|으로|로|에|가서)$/u,
  guessOpen: /^(열어|들어가|접속|가\p{White_Space}*줘|켜)/u,
  guessParticle: /(으로|에서|가서|을|를|로|에|좀|이|가)$/u,
  goalParticle: /(?:으로|로|에|을|를)$/u,
  goalSiteNoun: /\p{White_Space}*(?:사이트|홈페이지|누리집)$/u,
};

const destinationCommand = /^(.+?)\s*(?:좀\s*)?(?:열어|접속(?:해|해봐)?|들어가|이동해|가|띄워|켜)(?:\s*(?:줘요?|주세요|주어|줄래요?|주실래요?|봐요?))?[.!?。]*$/u;
const searchCommand = /^(.+?)\s*(?:을|를)?\s*(?:좀\s*)?검색(?:해(?:봐)?|하자)?(?:\s*(?:줘요?|주세요|줄래요?|주실래요?|봐요?))?[.!?。]*$/u;
const websiteSuffix = /\s*(?:(?:공식|대표|관련)\s*)?(?:홈페이지|누리집|웹\s*사이트|사이트)$/u;
const demonstrative = /^(?:(?:그|이|저|어느|어떤|다른)\s*(?:거|것|곳|쪽|페이지|항목|화면|링크)?|거기|여기|저기|그럼|다시|다음|이전|\d+\s*번)$/u;
const directionalOrCompound = /(?:에서|말고|하고|찾고|열고|읽고|듣고|보고|누르고|해서|가서|찾아서)\s|(?:^|\s)(?:그리고|그다음에?)\s/u;

function destinationSubject(text: string): string | undefined {
  const subject = destinationCommand.exec(strip(text))?.[1]?.trim();
  if (subject === undefined || isSiteName(subject)) return subject;
  return subject.replace(/(?:으로|을|를|로|에)$/u, "").trim();
}

function subjectName(subject: string): string | undefined {
  const name = subject.replace(websiteSuffix, "").trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .·&-]{1,79}$/u.test(name) || demonstrative.test(name) || directionalOrCompound.test(name)) return undefined;
  return name;
}

/** 이름 뒤의 이동 명령만 떼어 낸다. '국가기록원'처럼 이름 안의 '가'는 보존한다. */
export function requestedSiteName(text: string, {allowBare = false} = {}): string | undefined {
  const subject = destinationSubject(text) ?? (allowBare ? strip(text) : undefined);
  return subject === undefined ? undefined : subjectName(subject);
}

/** 단일 기관을 지목한 열기·검색 명령. 주소록에 없는 이름도 '누리집'을 명시하면 모델 없이 구분한다. */
export function namedSiteCommand(text: string): Extract<Intent, {type: "OPEN_SITE" | "SEARCH"}> | undefined {
  const query = searchCommand.exec(strip(text))?.[1]?.trim();
  const subject = query ?? destinationSubject(text);
  if (subject === undefined) return undefined;
  const name = subjectName(subject);
  if (name === undefined || (!isSiteName(name) && !websiteSuffix.test(subject))) return undefined;
  return query === undefined ? {type: "OPEN_SITE", target: text} : {type: "SEARCH", query};
}

/** 사이트 이름만 남기기(검색어로 쓰려고): "우리동네복지관 사이트 열어줘" → "우리동네복지관" */
export function siteNameFrom(text: string): string {
  return requestedSiteName(text) ?? strip(text.replace(sitesPatterns.siteNoun, " ")
    .replace(sitesPatterns.openCommand, " ").replace(sitesPatterns.spaces, " "));
}

function normalizedName(text: string): string {
  return text.replace(sitesPatterns.space, "").toLowerCase();
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

export function serviceTopic(site: KnownSite, text: string): string {
  const words = normalizedName(text);
  if (site.label === "한국장학재단" && words.includes("국가장학금")) {
    if (words.includes("다자녀")) return "다자녀국가장학금";
    if (sitesPatterns.scholarshipType2.test(words)) return "국가장학금2유형";
    if (sitesPatterns.scholarshipType1.test(words)) return "국가장학금1유형";
  }
  return (site.services ?? []).find(term => words.includes(term)) ?? "";
}

/** 명시된 기관이 우선한다. 다른 사이트나 여러 기관을 말했으면 업무 이름만으로 목적지를 정하지 않는다. */
export function publicServiceSite(text: string): ListedSite | undefined {
  const words = normalizedName(text);
  const named = KNOWN_SITES.filter(site => site.names.some(name => words.includes(normalizedName(name))));
  const [first] = named;
  if (first !== undefined) return named.length === 1 && first.services.length > 0 ? first : undefined;
  if (sitesPatterns.domain.test(text)) return undefined;
  const matches = KNOWN_SITES.filter(site => site.services.some(term => words.includes(term)));
  if (matches.length === 1) return matches[0];
  if (sitesPatterns.civilPortal.test(words)) return KNOWN_SITES.find(site => site.label === "정부24");
  return undefined;
}

export function isSiteName(text: string): boolean {
  const bare = normalizedName(text).replace(sitesPatterns.siteNameTail, "");
  return bare === "민원" || KNOWN_SITES.some(site => site.names.some(name => normalizedName(name) === bare));
}

/** fuzzy면 받아쓰기가 한 글자 틀린 이름(nearSite)도 친다. '복지관'·'신문사'처럼 낱말이 비슷한 경우가 있어 순위를 바꾸는 규칙은 끈다. */
export function mentionsKnownSite(text: string, fuzzy = true): boolean {
  const normalized = normalizedName(text);
  const exact = KNOWN_SITES.some(site => site.names.some(name => normalized.includes(normalizedName(name))))
    || sitesPatterns.domain.test(text);
  return exact || (fuzzy && nearSite(text) !== undefined);
}

/** 글자 하나 차이(코드 포인트 기준) */
export function oneEditApart(left: string, right: string): boolean {
  const a = Array.from(left), b = Array.from(right);
  if (left === right || Math.abs(a.length - b.length) > 1) return left === right;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function hangulAlias(name: string): string | undefined {
  const alias = name.replace(sitesPatterns.space, "");
  return codePoints(alias) >= 3 && sitesPatterns.hangulName.test(alias) ? alias : undefined;
}

/**
 * 받아쓰기가 사이트 이름을 한 글자 틀리게 적은 경우("네이보 열어줘", "복지루")를 알려진 사이트로 맞춘다.
 * 세 글자 이상 한글 이름끼리, 한 글자 차이만 인정(짧은 이름은 오인 위험이 커서 제외).
 */
export function nearSite(text: string, extra: readonly KnownSite[] = []): KnownSite | undefined {
  const tokens = text.split(sitesPatterns.spaces)
    .map(word => word.replace(sitesPatterns.otherThanHangul, "").replace(sitesPatterns.particle, ""))
    .filter(word => codePoints(word) >= 3);
  return [...extra, ...KNOWN_SITES].find(site => site.names.some(name => {
    const alias = hangulAlias(name);
    return alias !== undefined
      && tokens.some(word => word !== alias && codePoints(word) === codePoints(alias) && oneEditApart(word, alias));
  }));
}

/**
 * 정확한 사이트 이름·주소 없이 한 글자 다른 이름만 있으면 [사이트, 그 낱말]. '복지관'·'신문사'처럼 진짜 낱말일 수 있어
 * 부르는 쪽이 "'복지로' 말씀이세요?" 하고 확인한다(주인 결정 2026-11-19).
 */
export function nearSiteGuess(text: string, extra: readonly KnownSite[] = []): [KnownSite, string] | undefined {
  // 목적지 자리의 낱말만 본다: '…에서·…로·…가서' 또는 바로 뒤에 '열어·들어가·접속'
  const sites = [...extra, ...KNOWN_SITES];
  const exact = new Set(sites.flatMap(site => site.names.map(name => name.replace(sitesPatterns.space, ""))));
  const words = strip(text).split(sitesPatterns.spaces);
  for (const [index, raw] of words.entries()) {
    const after = words[index + 1] ?? "";
    if (!sitesPatterns.guessDestination.test(raw) && !sitesPatterns.guessOpen.test(after)) continue;
    const word = raw.replace(sitesPatterns.otherThanHangul, "").replace(sitesPatterns.guessParticle, "");
    // '복지로'는 '복지부'와 한 글자 차이지만 그 자체로 정확한 이름이다
    if (exact.has(word)) continue;
    for (const site of sites) {
      for (const name of site.names) {
        const alias = hangulAlias(name);
        if (alias !== undefined && codePoints(word) === codePoints(alias) && oneEditApart(word, alias)) return [site, word];
      }
    }
  }
  return undefined;
}

function bareHost(url: string): string {
  return tryUrl(url)?.hostname.replace(sitesPatterns.www, "") ?? "";
}

/** 주소 → 말할 사이트 이름: 알려진 사이트(하위 도메인 포함)면 그 이름, 아니면 www를 뗀 호스트. 주소를 못 읽으면 "". */
export function siteLabel(url: string, extra: readonly KnownSite[] = []): string {
  const here = bareHost(url);
  if (here.length === 0) return "";
  for (const site of [...extra, ...KNOWN_SITES]) {
    const host = bareHost(site.url);
    if (here === host || here.endsWith("." + host)) return site.label;
  }
  return here;
}

/** 한 사이트에서 찾아 달라는 요청을 [사이트 주소, 질문]으로 나눈다. */
export function goalSiteRequest(goal: string, extra: readonly KnownSite[] = [], {addressesOnly = false} = {}): [string | undefined, string] {
  const aliases = addressesOnly ? [] : [...extra, ...KNOWN_SITES]
    .flatMap(site => site.names.map(alias => [normalizedName(alias), site.url] as const))
    .sort((a, b) => codePoints(b[0]) - codePoints(a[0]));
  const destinations: Array<[string, string]> = [];
  for (const marker of goal.matchAll(sitesPatterns.goalMarker)) {
    const prefix = strip(goal.slice(0, marker.index));
    if (prefix.length === 0) continue;
    // '복지로에서 기초연금 ...'의 제도명이나 '이 화면에서'를 목적지로 잡지 않는다.
    let bare = strip(prefix.replace(sitesPatterns.goalParticle, ""));
    bare = strip(bare.replace(sitesPatterns.goalSiteNoun, ""));
    const token = splitWhitespace(bare.length > 0 ? bare : prefix).at(-1) ?? "";
    let url: string | undefined;
    if (sitesPatterns.domainWhole.test(token)) {
      url = addressSite(token)?.url;
    } else if (!addressesOnly) {
      const full = normalizedName(prefix), short = normalizedName(bare);
      url = aliases.find(([alias]) => full.endsWith(alias) || short.endsWith(alias))?.[1];
      url ??= nearSite(token, extra)?.url;
    }
    if (url !== undefined && url.length > 0) destinations.push([url, strip(goal.slice(marker.index + marker[0].length))]);
  }
  const [only] = destinations;
  if (only !== undefined) return destinations.length === 1 ? only : [undefined, goal];
  return [addressesOnly ? undefined : publicServiceSite(goal)?.url, goal];
}

/** 이름이나 주소를 실제 URL로. 연습용 모의 사이트는 extra로 넘긴다. */
export function resolveSite(target: string, extra: readonly KnownSite[] = []): SiteAddress | undefined {
  const normalized = normalizedName(target);
  const requested = requestedSiteName(target);
  const singleName = requested === undefined ? undefined : normalizedName(requested);
  let known: KnownSite | undefined;
  let knownLength = -1;
  for (const site of [...extra, ...KNOWN_SITES]) {
    for (const alias of site.names) {
      const name = normalizedName(alias);
      const length = codePoints(name);
      const matches = singleName === undefined ? normalized.includes(name)
        : singleName === name || singleName === normalizedName(alias.replace(websiteSuffix, ""));
      if (length > knownLength && matches) {
        known = site;
        knownLength = length;
      }
    }
  }
  const explicit = sitesPatterns.explicitUrl.exec(target);
  const site = explicit === null ? undefined : addressSite(explicit[0]);
  if (site !== undefined) {
    // 이름은 주소의 호스트로만 정한다: 'bokjiro.go.kr.evil.example'을 복지로라고 말하지 않는다
    const label = siteLabel(site.url, extra);
    return { ...site, label: label.length > 0 ? label : site.label };
  }
  if (known !== undefined) return { url: known.url, label: known.label };
  const service = publicServiceSite(target);
  const agency = service !== undefined && (singleName === undefined || singleName === "민원" || service.services.includes(singleName))
    ? service : nearSite(requested ?? target, extra);
  if (agency !== undefined) return { url: agency.url, label: agency.label };
  const spoken = target.replace(sitesPatterns.dotCom, ".com").replace(sitesPatterns.dotKr, ".kr");
  const match = sitesPatterns.domain.exec(spoken)?.[1];
  return match === undefined ? undefined : addressSite(match);
}
