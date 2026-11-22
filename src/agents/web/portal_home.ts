import { isOfficialPortal } from "../../core/sites.ts";

export function portalNameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/gu, "")
    .replace(/\(?(?:새창(?:으로)?열[림기]|opens?inanew(?:tab|window))\)?$/u, "")
    .replace(/(?:(?:공식|대표)?(?:홈페이지|누리집|웹사이트|사이트)|(?:official)?(?:homepage|website))$/u, "");
}

/** 검색 결과의 제목 전체가 요청한 기관과 첫 화면 표시로만 이루어졌는지 확인한다. */
function matchesPortalTitle(name: string, title: string): boolean {
  const wanted = portalNameKey(name);
  const parts = title.split(/\s*[|<>›»]\s*|\s+[-–—:]\s+/u).map(portalNameKey)
    .filter(part => part.length > 0 && !/^(?:홈|메인|첫화면|home|main)$/u.test(part));
  return wanted.length >= 2 && parts.length > 0 && parts.every(part => part === wanted);
}

/** 검색 결과가 직접 가리킨 공식 첫 화면만 연다. 기사·중계 주소나 동명 기관은 음성 선택지로 남긴다. */
export function uniquePortalHome(name: string, candidates: readonly {title: string; url: string}[]): string | undefined {
  const matches = new Set<string>();
  for (const candidate of candidates) {
    const url = URL.parse(candidate.url);
    if (!url || !isOfficialPortal(url) || url.search.length > 0 || url.hash.length > 0 || !matchesPortalTitle(name, candidate.title)) continue;
    if (url.pathname !== "/" && !/\/(?:index|main|home|default)(?:\.[a-z\d]+)?\/?$/iu.test(url.pathname)) continue;
    matches.add(url.href);
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}
