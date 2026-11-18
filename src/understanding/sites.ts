import { strip } from "../core/text.ts";
import { tryUrl } from "../core/url.ts";

export interface KnownSite {
  names: readonly string[];
  url: string;
  label: string;
  about?: string;
}

export const KNOWN_SITES: readonly KnownSite[] = [
  {
    names: ["복지로", "bokjiro", "bokjiro.go.kr"],
    url: "https://www.bokjiro.go.kr", label: "복지로",
    about: "보건복지부가 운영하는 복지 포털로, 복지 제도를 찾아보고 온라인으로 신청할 수 있는 곳",
  },
  {
    names: ["정부24", "정부 24", "정부이십사", "민원24", "민원 24", "민원이십사", "gov24", "government24", "government 24"],
    url: "https://www.gov.kr", label: "정부24",
    about: "정부 민원 포털로, 각종 증명서 발급과 민원 신청을 온라인으로 하는 곳",
  },
  {
    names: ["홈택스", "손택스", "hometax", "home tax"],
    url: "https://www.hometax.go.kr", label: "홈택스",
    about: "국세청의 세금 신고·납부 사이트로, 연말정산과 종합소득세 신고 등을 하는 곳",
  },
  {
    names: ["국세청"],
    url: "https://www.nts.go.kr", label: "국세청",
    about: "세금을 담당하는 정부 기관의 누리집",
  },
  {
    names: ["국민신문고", "신문고"],
    url: "https://www.epeople.go.kr", label: "국민신문고",
    about: "정부에 민원·제안·신고를 올리는 사이트",
  },
  {
    names: ["고용24", "고용 24", "워크넷", "고용노동부 일자리"],
    url: "https://www.work24.go.kr", label: "고용24",
    about: "고용노동부의 일자리·실업급여·직업훈련 통합 사이트",
  },
  {
    names: ["국민건강보험공단", "건강보험공단", "국민건강보험", "건강보험"],
    url: "https://www.nhis.or.kr", label: "국민건강보험공단",
    about: "건강보험과 장기요양보험을 운영하는 공단의 누리집으로, 보험료와 건강검진 등을 확인하는 곳",
  },
  {
    names: ["건강보험심사평가원", "심평원"],
    url: "https://www.hira.or.kr", label: "건강보험심사평가원",
    about: undefined,
  },
  {
    names: ["국민연금공단", "국민연금", "national pension service"],
    url: "https://www.nps.or.kr", label: "국민연금공단",
    about: "국민연금을 운영하는 공단의 누리집으로, 연금 가입 내역과 수령 안내를 보는 곳",
  },
  {
    names: ["기초연금"],
    url: "https://basicpension.mohw.go.kr", label: "기초연금",
    about: "기초연금 제도를 안내하는 보건복지부 누리집",
  },
  {
    names: ["보건복지부", "복지부", "ministry of health and welfare"],
    url: "https://www.mohw.go.kr", label: "보건복지부",
    about: "복지·보건 정책을 맡은 정부 부처의 누리집으로, 정책 소식과 보도자료가 올라오는 곳",
  },
  {
    names: ["행정안전부", "행안부"],
    url: "https://www.mois.go.kr", label: "행정안전부",
    about: undefined,
  },
  {
    names: ["보건복지상담센터", "129"],
    url: "https://www.129.go.kr", label: "보건복지상담센터",
    about: "복지 제도 상담을 해 주는 보건복지상담센터 누리집",
  },
  {
    names: ["한국장애인고용공단", "장애인고용공단"],
    url: "https://www.kead.or.kr", label: "한국장애인고용공단",
    about: undefined,
  },
  {
    names: ["정책브리핑", "대한민국 정책브리핑"],
    url: "https://www.korea.kr", label: "대한민국 정책브리핑",
    about: "정부 정책 소식을 모아 알리는 정부 공식 사이트",
  },
  {
    names: ["서울시", "서울특별시"],
    url: "https://www.seoul.go.kr", label: "서울특별시",
    about: undefined,
  },
  {
    names: ["코레일", "레츠코레일", "korail"],
    url: "https://www.letskorail.com", label: "코레일",
    about: "기차표를 예매하는 한국철도공사 사이트",
  },
  {
    names: ["네이버 지도", "naver map"],
    url: "https://map.naver.com", label: "네이버 지도",
    about: "네이버의 지도·길찾기 서비스",
  },
  {
    names: ["네이버 뉴스", "naver news"],
    url: "https://news.naver.com", label: "네이버 뉴스",
    about: "여러 언론사 기사를 모아 보여 주는 네이버의 뉴스 서비스",
  },
  {
    names: ["네이버", "naver"],
    url: "https://www.naver.com", label: "네이버",
    about: "한국에서 가장 많이 쓰는 포털 사이트로, 검색·뉴스·날씨·쇼핑·지도 등을 한곳에서 쓸 수 있는 곳",
  },
  {
    names: ["구글", "google"],
    url: "https://www.google.com", label: "구글",
    about: "세계적으로 많이 쓰는 검색 사이트",
  },
  {
    names: ["유튜브", "youtube", "you tube"],
    url: "https://www.youtube.com", label: "유튜브",
    about: "동영상을 보고 올리는 사이트",
  },
  {
    names: ["다음 사이트", "다음 포털", "다음넷", "daum"],
    url: "https://www.daum.net", label: "다음",
    about: "카카오가 운영하는 포털 사이트로, 검색·뉴스·메일 등을 쓸 수 있는 곳",
  },
];

export const sitesPatterns = {
  siteNoun: /(홈페이지|누리집|웹\p{White_Space}*사이트|사이트|페이지)/gu,
  openCommand: /(을|를|에|로|으로|좀)?\p{White_Space}*(열어|접속|들어가|이동해|가|켜|띄워)\P{White_Space}*\p{White_Space}*(줘|주세요|봐)?/gu,
  spaces: /\p{White_Space}+/gu,
  domain: /(?:(?<![A-Za-z0-9_İı])(?=[A-Za-z0-9_İı])|(?<=[A-Za-z0-9_İı])(?![A-Za-z0-9_İı]))((?:https?:\/\/)?(?:(?:[a-zİı0-9-]+\.)+[a-zİı]{2,}|localhost|\p{Nd}{1,3}(?:\.\p{Nd}{1,3}){3})(?::\p{Nd}+)?(?:\/[^\p{White_Space}]*)?)/iu,
  space: /\p{White_Space}/gu,
  otherThanHangul: /[^가-힣]/gu,
  particle: /(으로|에서|을|를|로|에|좀|이|가)(?=\n?$)/gu,
  hangulName: /^[가-힣]+(?=\n?$)/u,
  www: /^www\./gu,
  dotCom: /\p{White_Space}*(닷|점)\p{White_Space}*(컴|com)/gu,
  dotKr: /\p{White_Space}*(닷|점)\p{White_Space}*(케이알|kr)/gu,
  linkEnding: /[.,)]+(?=\n?$)/gu,
  localAddress: /^(localhost|\p{Nd}{1,3}(\.\p{Nd}{1,3}){3})(:|\/|(?=\n?$))/iu,
  protocol: /^https?:\/\//iu,
};

export function siteNameFrom(text: string): string {
  return strip(text.replace(sitesPatterns.siteNoun, " ")
    .replace(sitesPatterns.openCommand, " ").replace(sitesPatterns.spaces, " "));
}

function normalizedName(text: string): string {
  return text.replace(sitesPatterns.space, "").toLowerCase();
}

export function mentionsKnownSite(text: string): boolean {
  const normalized = normalizedName(text);
  return KNOWN_SITES.some(site => site.names.some(name => normalized.includes(normalizedName(name))))
    || sitesPatterns.domain.test(text) || nearSite(text) !== undefined;
}

/** 받아쓰기가 한글 이름의 한 글자만 다르게 적었을 때만 후보로 삼는다. */
export function nearSite(text: string, extra: readonly KnownSite[] = []): KnownSite | undefined {
  const tokens = text.split(sitesPatterns.spaces)
    .map(word => word.replace(sitesPatterns.otherThanHangul, "").replace(sitesPatterns.particle, ""))
    .filter(word => word.length >= 3);
  return [...extra, ...KNOWN_SITES].find(site => site.names.some(alias => {
    const name = alias.replace(sitesPatterns.space, "");
    if (name.length < 3 || !sitesPatterns.hangulName.test(name)) return false;
    return tokens.some(word => {
      if (word.length !== name.length) return false;
      let differences = 0;
      for (let i = 0; i < word.length; i++) {
        if (word[i] !== name[i]) differences++;
        if (differences > 1) return false;
      }
      return differences === 1;
    });
  }));
}

function bareHost(url: string): string {
  return tryUrl(url)?.hostname.replace(sitesPatterns.www, "") ?? "";
}

export function siteLabel(url: string, extra: readonly KnownSite[] = []): string {
  const here = bareHost(url);
  if (here.length === 0) return "";
  for (const site of [...extra, ...KNOWN_SITES]) {
    const host = bareHost(site.url);
    if (here === host || here.endsWith("." + host)) return site.label;
  }
  return here;
}

export function resolveSite(target: string, extra: readonly KnownSite[] = []): Pick<KnownSite, "url" | "label"> | undefined {
  const normalized = normalizedName(target);
  let best: KnownSite | undefined;
  let bestLength = -1;
  for (const site of [...extra, ...KNOWN_SITES]) {
    for (const alias of site.names) {
      const name = normalizedName(alias);
      const length = Array.from(name).length;
      if (length > bestLength && normalized.includes(name)) {
        best = site;
        bestLength = length;
      }
    }
  }
  best ??= nearSite(target, extra);
  if (best !== undefined) return { url: best.url, label: best.label };
  const spoken = target.replace(sitesPatterns.dotCom, ".com").replace(sitesPatterns.dotKr, ".kr");
  const match = sitesPatterns.domain.exec(spoken)?.[1];
  if (match === undefined) return undefined;
  const raw = match.replace(sitesPatterns.linkEnding, "");
  const protocol = sitesPatterns.localAddress.test(raw) ? "http://" : "https://";
  const url = sitesPatterns.protocol.test(raw) ? raw : protocol + raw;
  const parsed = tryUrl(url);
  return parsed === undefined ? undefined : { url, label: parsed.host };
}
