import { asciiDecimalDigits, strip } from "../../core/text.ts";
import { parseUrl, tryUrl } from "../../core/url.ts";

export type PageId = "mock-home" | "mock-welfare" | "mock-login" | "external" | "blank";
export type Validation = { ok: true; value: string; message: "" } | { ok: false; value: ""; message: string };
const ok = (value: string): Validation => ({ ok: true, value, message: "" });
const fail = (message: string): Validation => ({ ok: false, value: "", message });

export interface FieldProfile {
  fieldId: string;
  label: string;
  step: number;
  kind: "text" | "tel" | "number" | "select" | "checkbox";
  sensitivity: "normal" | "personal" | "secret";
  aliases: readonly string[];
  genericAliases: readonly string[];
  maskOnReadback: boolean;
  options?: readonly string[];
  validate?: (raw: string) => Validation;
}

export interface SiteProfile {
  id: string;
  name: string;
  origin: string;
  urls: { home: string; apply: string; login: string };
  links: { application: string; login: string };
  buttons: { next: string; prev: string; submit: string; dismissDialog: readonly string[] };
  receiptPattern: RegExp;
  fields: readonly FieldProfile[];
  classify: (url: string) => PageId;
}

export const profilePatterns = {
  term: /[\p{White_Space}·.,]/gu,
  nameFiller: /(^|\p{White_Space})(음+|어+|아+|그냥|좀|도와|해줘|뭐|네|응|아니|잠깐|근데|그러니까|저기|이거|그거)(\p{White_Space}|(?=\n?$))|[?？]/u,
  spaces: /\p{White_Space}+/gu,
  koreanName: /^[가-힣]{2,5}(?=\n?$)/u,
  englishName: /^[A-Za-z]+( [A-Za-z]+){0,3}(?=\n?$)/u,
  road: /(로|길|동|리|가)(\p{White_Space}|\p{Nd}|(?=\n?$))/u,
  digit: /\p{Nd}/u,
  nonDigit: /\P{Nd}/gu,
  phone: /^01[016789]\p{Nd}{7,8}(?=\n?$)/u,
  digits: /\p{Nd}+/u,
  no: /(아니|안 ?달라|같아|해제)/u,
  yes: /(예|네|응|달라|다름|다릅니다|맞아|체크)/u,
  unsure: /모르/u,
  absent: /없/u,
  present: /있/u,
  absentOption: /없음/u,
  presentOption: /있음/u,
  receipt: /모의 접수번호:\p{White_Space}*(MOCK-[0-9]{8}-[0-9]{4})/u,
};

export function normalizeTerm(value: string): string {
  return value.replace(profilePatterns.term, "").toLowerCase();
}

function squash(raw: string): string {
  return strip(raw).replace(profilePatterns.spaces, " ");
}

export function validateName(raw: string): Validation {
  const value = squash(raw);
  const korean = profilePatterns.koreanName.test(value);
  const english = profilePatterns.englishName.test(value) && value.length <= 30;
  return (korean || english) && !profilePatterns.nameFiller.test(value)
    ? ok(value) : fail("이름만 또박또박 말씀해 주세요. 예: 김하늘.");
}

export function validateAddress(raw: string): Validation {
  const value = squash(raw);
  return value.split(" ").length >= 3 && profilePatterns.digit.test(value) &&
    profilePatterns.road.test(value) && [...value].length <= 100 ? ok(value)
    : fail("주소가 불완전합니다. 시·도, 시·군·구, 도로명과 건물번호까지 말씀해 주세요. 추측해서 입력하지 않았습니다.");
}

export function validatePhone(raw: string): Validation {
  const digits = raw.replace(profilePatterns.nonDigit, "");
  if (!profilePatterns.phone.test(digits)) return fail("연락처는 010으로 시작하는 휴대전화 번호 10~11자리로 말씀해 주세요.");
  const chars = [...digits];
  const split = chars.length === 11 ? 7 : 6;
  return ok([chars.slice(0, 3), chars.slice(3, split), chars.slice(split)].map(part => part.join("")).join("-"));
}

export function validateHouseholdSize(raw: string): Validation {
  const match = profilePatterns.digits.exec(raw);
  if (match !== null) {
    const size = Number(asciiDecimalDigits(match[0]));
    if (size >= 1 && size <= 20) return ok(String(size));
  }
  return fail("가구원 수는 1에서 20 사이의 숫자로 말씀해 주세요.");
}

export function validateYesNo(raw: string): Validation {
  if (profilePatterns.no.test(raw)) return ok("아니오");
  if (profilePatterns.yes.test(raw)) return ok("예");
  return fail('"예" 또는 "아니오"로 말씀해 주세요.');
}

export function matchOption(raw: string, options: readonly string[]): Validation {
  const term = normalizeTerm(raw);
  const exact = options.filter(o => normalizeTerm(o) === term);
  if (exact.length === 1) return ok(exact[0]!);
  const contains = options.filter(o => term.includes(normalizeTerm(o)) || normalizeTerm(o).includes(term));
  if (contains.length === 1) return ok(contains[0]!);
  const keywords = [
    [profilePatterns.unsure, profilePatterns.unsure],
    [profilePatterns.absent, profilePatterns.absentOption],
    [profilePatterns.present, profilePatterns.presentOption],
  ] as const;
  const keyword = keywords.find(([input]) => input.test(raw))?.[1];
  const hits = keyword === undefined ? [] : options.filter(o => keyword.test(o));
  return hits.length === 1 ? ok(hits[0]!) : fail("선택지 중 하나로 말씀해 주세요: " + options.join(", ") + ".");
}

export const INCOME_OPTIONS = ["신고할 소득·재산 있음", "신고할 소득·재산 없음", "잘 모르겠음 (상담 필요)"] as const;

export function createMockWelfareProfile(baseUrl: string): SiteProfile {
  const { origin } = parseUrl(baseUrl);
  const defaults = { genericAliases: [], maskOnReadback: false };
  return {
    id: "mock-welfare", name: "모의 복지 신청 사이트", origin,
    urls: { home: origin + "/", apply: origin + "/apply.html", login: origin + "/login.html" },
    links: { application: "장애인연금 모의 신청하기", login: "모의 본인인증" },
    buttons: { next: "다음", prev: "이전", submit: "모의접수", dismissDialog: ["닫기", "확인"] },
    receiptPattern: profilePatterns.receipt,
    fields: [
      { ...defaults, fieldId: "applicantName", label: "성명", step: 1, kind: "text", sensitivity: "personal",
        aliases: ["이름", "성명", "신청인 이름", "신청자 이름", "신청인 성명"], validate: validateName },
      { ...defaults, fieldId: "address", label: "주민등록 주소", step: 1, kind: "text", sensitivity: "personal",
        aliases: ["주민등록 주소", "주민등록상 주소", "등록 주소", "주민등록"], genericAliases: ["주소"], validate: validateAddress },
      { ...defaults, fieldId: "residenceDiffers", label: "실거주지가 주민등록 주소와 다릅니다", step: 1, kind: "checkbox", sensitivity: "normal",
        aliases: ["실거주지가 주민등록 주소와 다릅니다", "실거주지 다름"], validate: validateYesNo },
      { ...defaults, fieldId: "residenceAddress", label: "실거주지 주소", step: 1, kind: "text", sensitivity: "personal",
        aliases: ["실거주지 주소", "거주지 주소", "실거주지", "사는 곳 주소"], genericAliases: ["주소"], validate: validateAddress },
      { ...defaults, fieldId: "phone", label: "연락처 (선택)", step: 1, kind: "tel", sensitivity: "personal",
        aliases: ["연락처", "전화번호", "휴대폰 번호", "휴대폰", "핸드폰 번호", "핸드폰", "휴대전화"], maskOnReadback: true, validate: validatePhone },
      { ...defaults, fieldId: "incomeStatus", label: "소득·재산 신고 (선택)", step: 2, kind: "select", sensitivity: "normal",
        aliases: ["소득·재산 신고", "소득 재산 신고", "소득·재산", "소득 재산", "소득 신고", "소득", "재산"],
        options: INCOME_OPTIONS, validate: raw => matchOption(raw, INCOME_OPTIONS) },
      { ...defaults, fieldId: "householdSize", label: "가구원 수 (선택)", step: 2, kind: "number", sensitivity: "normal",
        aliases: ["가구원 수", "가구원", "가족 수"], validate: validateHouseholdSize },
      { ...defaults, fieldId: "loginPassword", label: "비밀번호", step: 0, kind: "text", sensitivity: "secret", aliases: [] },
    ],
    classify(url) {
      if (url.length === 0 || url === "about:blank") return "blank";
      const parsed = tryUrl(url);
      if (parsed === undefined || parsed.origin !== origin) return "external";
      if (parsed.pathname.startsWith("/apply")) return "mock-welfare";
      if (parsed.pathname.startsWith("/login")) return "mock-login";
      return "mock-home";
    },
  };
}

export function fieldVocabulary(profile: SiteProfile): string[] {
  const words = new Set(profile.fields.filter(field => field.sensitivity !== "secret")
    .flatMap(field => [...field.aliases, ...field.genericAliases]));
  return [...words].sort((a, b) => [...normalizeTerm(b)].length - [...normalizeTerm(a)].length);
}
