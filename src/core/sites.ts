// Shared site identities used by routing, language detection and source verification.
export interface KnownSite {
  names: readonly string[];
  url: string;
  label: string;
  /** "이 사이트 뭐야"에 답할 한 줄 소개(일반적으로 알려진 성격만) */
  about?: string;
  /** 기관명을 말하지 않아도 담당 누리집을 찾을 수 있는 대표 업무 */
  services: readonly string[];
}

export function knownSite(names: readonly string[], url: string, label: string, about?: string, services: readonly string[] = []): KnownSite {
  return about === undefined ? { names, url, label, services } : { names, url, label, about, services };
}

export const PUBLIC_SITES: readonly KnownSite[] = [
  knownSite(
    ["복지로", "bokjiro", "bokjiro.go.kr"], "https://www.bokjiro.go.kr", "복지로",
    "보건복지부가 운영하는 복지 포털로, 복지 제도를 찾아보고 온라인으로 신청할 수 있는 곳",
  ),
  knownSite(
    ["정부24", "정부이십사", "정부이사", "민원24", "민원이십사", "민원포털", "민원서비스", "gov24", "government24"], "https://www.gov.kr", "정부24",
    "정부 민원 포털로, 각종 증명서 발급과 민원 신청을 온라인으로 하는 곳",
    ["주민등록등본", "주민등록초본", "주민등록표등본", "주민등록표초본", "등본발급", "전입신고", "건축물대장", "토지대장", "민원신청", "민원서류", "민원발급"],
  ),
  knownSite(
    ["한국장학재단", "장학재단", "kosaf", "Korea Student Aid Foundation"], "https://www.kosaf.go.kr", "한국장학재단",
    "국가장학금과 학자금 대출을 안내하는 곳",
    ["다자녀국가장학금", "국가장학금2유형", "국가장학금1유형", "국가장학금", "학자금대출", "국가근로장학금", "장학금", "학자금"],
  ),
  knownSite(
    ["홈택스", "손택스", "hometax", "home tax"], "https://www.hometax.go.kr", "홈택스",
    "국세청의 세금 신고·납부 사이트로, 연말정산과 종합소득세 신고 등을 하는 곳",
    ["연말정산", "종합소득세", "사업자등록증명"],
  ),
  knownSite(
    ["국세청"], "https://www.nts.go.kr", "국세청",
    "세금을 담당하는 정부 기관의 누리집",
  ),
  knownSite(
    ["국민신문고", "신문고"], "https://www.epeople.go.kr", "국민신문고",
    "정부에 민원·제안·신고를 올리는 사이트",
    ["고충민원", "민원제기", "민원을제기", "민원넣", "민원을넣", "불편민원", "민원신고", "민원을신고"],
  ),
  knownSite(
    ["고용24", "고용이십사", "워크넷", "고용노동부 일자리"], "https://www.work24.go.kr", "고용24",
    "고용노동부의 일자리·실업급여·직업훈련 통합 사이트",
    ["실업급여", "구직급여", "국민내일배움카드"],
  ),
  knownSite(
    ["국민건강보험공단", "건강보험공단", "국민건강보험", "건강보험"], "https://www.nhis.or.kr", "국민건강보험공단",
    "건강보험과 장기요양보험을 운영하는 공단의 누리집으로, 보험료와 건강검진 등을 확인하는 곳",
  ),
  knownSite(["건강보험심사평가원", "심평원"], "https://www.hira.or.kr", "건강보험심사평가원"),
  knownSite(
    ["국민연금공단", "국민연금", "national pension service"], "https://www.nps.or.kr", "국민연금공단",
    "국민연금을 운영하는 공단의 누리집으로, 연금 가입 내역과 수령 안내를 보는 곳",
  ),
  knownSite(
    ["기초연금"], "https://basicpension.mohw.go.kr", "기초연금",
    "기초연금 제도를 안내하는 보건복지부 누리집",
  ),
  knownSite(
    ["보건복지부", "복지부", "ministry of health and welfare"], "https://www.mohw.go.kr", "보건복지부",
    "복지·보건 정책을 맡은 정부 부처의 누리집으로, 정책 소식과 보도자료가 올라오는 곳",
  ),
  knownSite(["행정안전부", "행안부"], "https://www.mois.go.kr", "행정안전부"),
  knownSite(
    ["보건복지상담센터", "129"], "https://www.129.go.kr", "보건복지상담센터",
    "복지 제도 상담을 해 주는 보건복지상담센터 누리집",
  ),
  knownSite(["한국장애인고용공단", "장애인고용공단"], "https://www.kead.or.kr", "한국장애인고용공단"),
  knownSite(
    ["정책브리핑", "대한민국 정책브리핑"], "https://www.korea.kr", "대한민국 정책브리핑",
    "정부 정책 소식을 모아 알리는 정부 공식 사이트",
  ),
  knownSite(["서울시", "서울특별시"], "https://www.seoul.go.kr", "서울특별시"),
  knownSite(
    ["코레일", "레츠코레일", "korail"], "https://www.letskorail.com", "코레일",
    "기차표를 예매하는 한국철도공사 사이트",
  ),
];

export const KNOWN_SITES: readonly KnownSite[] = [
  ...PUBLIC_SITES,
  knownSite(
    ["네이버 지도", "naver map"], "https://map.naver.com", "네이버 지도",
    "네이버의 지도·길찾기 서비스",
  ),
  knownSite(
    ["네이버 뉴스", "naver news"], "https://news.naver.com", "네이버 뉴스",
    "여러 언론사 기사를 모아 보여 주는 네이버의 뉴스 서비스",
  ),
  knownSite(
    ["네이버", "naver"], "https://www.naver.com", "네이버",
    "한국에서 가장 많이 쓰는 포털 사이트로, 검색·뉴스·날씨·쇼핑·지도 등을 한곳에서 쓸 수 있는 곳",
  ),
  knownSite(
    ["구글", "google"], "https://www.google.com", "구글",
    "세계적으로 많이 쓰는 검색 사이트",
  ),
  knownSite(
    ["유튜브", "youtube", "you tube"], "https://www.youtube.com", "유튜브",
    "동영상을 보고 올리는 사이트",
  ),
  knownSite(
    ["다음 사이트", "다음 포털", "다음넷", "daum"], "https://www.daum.net", "다음",
    "카카오가 운영하는 포털 사이트로, 검색·뉴스·메일 등을 쓸 수 있는 곳",
  ),
];

export const PUBLIC_AGENCIES: ReadonlyMap<string, KnownSite> = new Map(PUBLIC_SITES.map(site => [site.label, site]));
export const PUBLIC_ORIGINS: ReadonlySet<string> = new Set(PUBLIC_SITES.map(site => site.url.replace(/\/+$/u, "")));

/** 공공 누리집으로 볼 수 있는 주소인지. https, 기본 포트, 계정 정보 없음에 `.go.kr` 도메인이거나 알려진 공공 누리집이다. */
export function isOfficialPortal(url: { href: string; protocol: string; hostname: string; port: string; origin: string }): boolean {
  if (url.protocol !== "https:" || url.port !== "" || /^[a-z][\d+.a-z-]*:\/\/[^/?#]*@/iu.test(url.href)) return false;
  return url.hostname.endsWith(".go.kr") || PUBLIC_ORIGINS.has(url.origin);
}
