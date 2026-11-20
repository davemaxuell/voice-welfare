import { strip } from "../../core/text.ts";
import { tryUrl } from "../../core/url.ts";
import type { WebObservation } from "./view.ts";

export const DEFAULT_CONTACT_NAME = "보건복지상담센터";
export const DEFAULT_CONTACT_NUMBER = "129";
export const DEFAULT_CAN_DO = ["복지 제도 찾아 드리기", "웹 페이지 읽어 드리기", "연습 신청서 작성 돕기"] as const;
const DEFAULT_ROUTES = {
  blocked: "평소 쓰시는 브라우저로 직접 여시거나, 비슷한 정보를 다른 사이트에서 찾아 드릴까요?",
  "policy-denied": "읽기·이동·검색은 도와드릴 수 있어요. 예: '본문 읽어줘', '뒤로 가줘'.",
};
export const playbookPatterns = {
  www: /^www\./u, digit: /\p{Nd}/u, space: /\p{White_Space}/gu,
  residentCopy: /주민등록(?:표)?(?:등본|초본)|등본발급/u, typeTwo: /(?:2|Ⅱ|ⅱ|II|ii)유형/u,
  howToApply: /신청방법|신청절차|어떻게신청|신청하는법/u, when: /언제|기간|기한|일정|마감|날짜/u,
  procedureHeading: /(?:^|\n)[ \t]*[^\n]{0,75}국가장학금[^\n]{0,75}지원절차[ \t]*\n/u,
};
export interface SitePlaybook {
  host: string;
  label: string;
  contactName: string;
  contactNumber: string;
  automationNotice: string;
  routes: Partial<typeof DEFAULT_ROUTES>;
  canDo: readonly string[];
}

const playbooks: SitePlaybook[] = [
  {
    host: "bokjiro.go.kr", label: "복지로", contactName: DEFAULT_CONTACT_NAME, contactNumber: DEFAULT_CONTACT_NUMBER,
    automationNotice: "복지로는 자동으로 여는 브라우저의 접속을 막을 수 있어요. 막혀도 우회하지 않고, 직접 여시는 방법이나 다른 도움을 말씀드릴게요.",
    routes: {
      blocked: "평소 쓰시는 브라우저로 복지로를 직접 여시거나, '복지 제도 찾아줘'라고 말씀해 주세요.",
      "policy-denied": "읽기·검색·메뉴 이동은 도와드릴 수 있어요. 예: '본문 읽어줘', '서비스 찾기 눌러줘'.",
    },
    canDo: ["복지 제도 찾아 드리기", "공식 안내 읽어 드리기", "연습 신청서 작성 돕기"],
  },
  {
    host: "gov.kr", label: "정부24", contactName: "정부민원안내콜센터", contactNumber: "1588-2188",
    automationNotice: "정부24는 자동 프로그램을 쓰면 이용이 제한될 수 있어요. 청음은 막히면 우회하지 않고, 직접 여시는 방법이나 다른 도움을 말씀드릴게요.",
    routes: {
      blocked: "평소 쓰시는 브라우저로 정부24를 직접 여시거나, 발급 절차를 물어 주세요. 예: '주민등록등본 발급 방법 알려줘'.",
      "policy-denied": "읽기·검색·링크 이동은 도와드릴 수 있어요. 예: '본문 읽어줘', '신청 방법 찾아줘'.",
    },
    canDo: ["민원 절차 안내 읽어 드리기", "페이지 읽고 찾아 드리기", "다른 공식 사이트 열어 드리기"],
  },
];

/** 통합검색은 헤더 응답 뒤에 결과 목록을 받는다. 두 요청은 오래 걸려도 롱 폴링이 아니다. */
export function loadsBokjiroSearchResults(url: string): boolean {
  const request = tryUrl(url);
  return request !== undefined && ["www.bokjiro.go.kr", "bokjiro.go.kr"].includes(request.hostname) && [
    "/ssis-tbu/TWZZ01000M/getHeaderInf.do",
    "/ssis-tbu/TWZZ01000M/twatzzza/intgSearch/selectTwzzIntgSearchList.do",
  ].includes(request.pathname);
}

/** 기관이 공개한 업무별 안내 페이지. 사용자가 지정한 상세 주소는 그대로 둔다. */
export function publicGuideUrl(siteUrl: string | undefined, question: string): string | undefined {
  const site = tryUrl(siteUrl ?? "");
  if (site === undefined || site.pathname !== "/" || site.search.length > 0) return undefined;
  const words = question.replace(playbookPatterns.space, "");
  if (site.hostname === "www.gov.kr" && playbookPatterns.residentCopy.test(words)) {
    return "https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=13100000015";
  }
  if (site.hostname === "www.kosaf.go.kr" && words.includes("국가장학금")) {
    let page = "scholarship05_12_01_01";
    if (words.includes("다자녀")) page = "scholarship05_12_10";
    else if (playbookPatterns.typeTwo.test(words)) page = "scholarship05_12_01_02";
    if (words.includes("서류")) return `https://www.kosaf.go.kr/ko/scholar.do?pg=${page}&ttab1=3`;
    if (playbookPatterns.howToApply.test(words)) return `https://www.kosaf.go.kr/ko/scholar.do?pg=${page}&ttab1=2`;
    return "https://www.kosaf.go.kr/ko/scholar.do?pg=scholarship_submain01&naviParam=JH,02,00,00";
  }
  return undefined;
}

/** 장학재단의 업무별 탭은 공통 일정 배너 뒤에 있다. 절차 질문의 근거는 현재 탭의 본문이다. */
export function guideSection<View extends WebObservation>(view: View, question: string): View {
  const page = tryUrl(view.url ?? "");
  if (page === undefined || page.hostname !== "www.kosaf.go.kr" || page.pathname !== "/ko/scholar.do") return view;
  if (!page.search.includes("ttab1=2") || playbookPatterns.when.test(question)) return view;
  const outline = view.outline ?? {};
  const main = outline.mainText ?? "";
  const heading = playbookPatterns.procedureHeading.exec(main);
  if (heading === null) return view;
  return { ...view, outline: { ...outline, mainText: strip(main.slice(heading.index)) } };
}

export function forUrl(url?: string): SitePlaybook | undefined {
  const host = tryUrl(url)?.hostname.replace(playbookPatterns.www, "");
  return playbooks.find(site => host === site.host || host?.endsWith("." + site.host) === true);
}

export function nextStep(obstacle: string, url?: string): string {
  if (obstacle !== "policy-denied" && obstacle !== "blocked") return DEFAULT_ROUTES.blocked;
  return forUrl(url)?.routes[obstacle] ?? DEFAULT_ROUTES[obstacle];
}

interface Contact {
  contactName?: string;
  contactNumber?: string;
  url?: string;
}

export function resolveContact({ contactName, contactNumber, url }: Contact = {}): readonly [string, string] {
  if (contactNumber !== undefined && playbookPatterns.digit.test(contactNumber)) {
    return [contactName === undefined || contactName.length === 0 ? "담당 기관" : contactName, contactNumber];
  }
  const site = forUrl(url);
  return [site?.contactName ?? DEFAULT_CONTACT_NAME, site?.contactNumber ?? DEFAULT_CONTACT_NUMBER];
}

export function canDoList(url?: string): readonly string[] {
  return forUrl(url)?.canDo ?? DEFAULT_CAN_DO;
}

export function blockedSpeech(url?: string, once?: (key: string, text: string) => string): string {
  const site = forUrl(url);
  const parts = ["이 사이트는 자동으로 여는 브라우저의 접속을 막고 있어서 내용을 읽을 수 없어요. 보안 장치를 우회하지는 않아요."];
  const notice = site === undefined ? undefined : once?.("automation:" + site.host, site.automationNotice);
  if (notice !== undefined && notice.length > 0) parts.push(notice);
  parts.push(nextStep("blocked", url));
  return parts.join(" ");
}

export function helpHumanSpeech(contact: Contact & { serviceName?: string; stepHint?: string } = {}): string {
  const [name, number] = resolveContact(contact);
  const topic = contact.serviceName !== undefined && contact.serviceName.length > 0
    ? contact.serviceName : forUrl(contact.url)?.label ?? "복지·민원";
  const where = contact.stepHint !== undefined && contact.stepHint.length > 0 ? contact.stepHint : "도움이 필요한 단계";
  return "제가 상담원에게 전화하거나 연결해 드리지는 못해요. 문의는 " + name + " " + number + "입니다. " +
    "직접 거실 때 이렇게 말씀하시면 좋아요: '" + topic + " 문의인데요, " + where + "에서 도움이 필요해요.' " +
    "대신 제가 도와드릴 수 있는 일은 " + canDoList(contact.url).slice(0, 3).join(", ") + "이에요. 번호를 다시 들려 드릴까요?";
}
