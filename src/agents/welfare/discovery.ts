import { asciiDecimalDigits, strip } from "../../core/text.ts";
import type { ServiceSummary } from './data/index.ts';

export const discoveryPatterns = {
  ageAfterLabel: /(?:나이는?|만)\p{White_Space}*(\p{Nd}{1,3})(?:(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])(?![A-Za-z0-9_]))/u,
  ageWithUnit: /(?:만\p{White_Space}*)?(\p{Nd}{1,3})\p{White_Space}*(?:살|세)/u,
  nativeAge: /(열|스물|스무|서른|마흔|쉰|예순|일흔|여든|아흔)\p{White_Space}*(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉)?\p{White_Space}*살/u,
  skip: /^(모름|몰라|모르겠|잘\p{White_Space}*모르|건너\p{White_Space}*뛰|건너\p{White_Space}*뛸|패스|넘어가|넘길|다음|없어요?(?=\n?$)|말\p{White_Space}*안\p{White_Space}*할래|말하기\p{White_Space}*싫)/u,
  spaces: /\p{White_Space}+/gu,
  filler: /^((음+|어+|아+|에+|그+|저기|그러니까|그니까|글쎄)[,.\p{White_Space}]+)+/u,
  noDisability: /(없|아니)/u,
  severe: /(심한|중증|1급|2급|3급|심해)/u,
  notSevere: /심하지\p{White_Space}*않/u,
  mild: /(심하지\p{White_Space}*않|경증|가벼|4급|5급|6급)/u,
  basic: /(기초\p{White_Space}*생활|수급자|생계\p{White_Space}*급여|의료\p{White_Space}*급여)/u,
  nearPoor: /차상위/u,
  lowIncome: /(소득이?\p{White_Space}*(적|낮|없|거의)|형편이?\p{White_Space}*어려|저소득)/u,
  normalIncome: /(해당\p{White_Space}*안|아니에?요?|보통|일반|평범|직장\p{White_Space}*다녀)/u,
  region: /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청북|충북|충청남|충남|전라북|전북|전라남|전남|경상북|경북|경상남|경남|제주)/u,
  singleParent: /(한부모|조손)/u,
  children: /(자녀|아이|애)\p{White_Space}*(가\p{White_Space}*)?(셋|넷|다섯|3명|4명|여러)/u,
  manyChildren: /다자녀/u,
  veteran: /(보훈|국가\p{White_Space}*유공)/u,
  multicultural: /(다문화|탈북|북한이탈)/u,
  alone: /(혼자|1인|독거)/u,
  disabilityYes: /^(네|예|응|맞아|그래|있어|있습니다|있어요)/u,
  disabilityNo: /^(아니|없)/u,
  incomeYes: /^(네|예|응|맞아|맞습니다|맞아요|그래|그렇|해당돼)/u,
  incomeNo: /^(아니)/u,
  disability: /장애/u,
  lowIncomeName: /(저소득|기초|생계|차상위|수급)/u,
  mildName: /경증/u,
  severeName: /중증/u,
};


/**
 * 맞춤 복지 찾기: "받을 수 있는데 몰라서 못 받는 복지"를 찾는다.
 * 사용자 답(나이·장애·소득·지역)은 이번 대화에서만 쓰고 저장하지 않는다.
 * 목록 필터·순위는 규칙 기반(빠르고 재현 가능). 자격 판정은 하지 않는다.
 */
export interface UserProfile {
  age?: number;
  disability?: 'severe' | 'mild' | 'yes' | 'no' | 'unknown';
  income?: 'basic' | 'near-poor' | 'low' | 'normal' | 'unknown';
  ctpv?: string | null; // null = 건너뜀
  singleParent?: boolean;
  manyChildren?: boolean;
  veteran?: boolean;
  multicultural?: boolean;
  living?: 'alone' | 'family';
}

export type ProfileSlot = 'age' | 'disability' | 'income' | 'ctpv';
export const PROFILE_ORDER: ProfileSlot[] = ['age', 'disability', 'income', 'ctpv'];

export const PROFILE_QUESTIONS: Record<ProfileSlot, string> = {
  age: '나이가 어떻게 되세요?',
  disability: '장애가 있으신가요? 있다면 심한 장애인지도 말씀해 주세요.',
  income: "기초생활수급자나 차상위계층이신가요? 잘 모르시면 '모름'이라고 하셔도 돼요.",
  ctpv: "사시는 시·도를 알려 주시면 지역 복지도 함께 찾아볼게요. 건너뛰려면 '건너뛰기'라고 해 주세요.",
};

const CTPV: Record<string, string> = {
  서울: '서울특별시',
  부산: '부산광역시',
  대구: '대구광역시',
  인천: '인천광역시',
  광주: '광주광역시',
  대전: '대전광역시',
  울산: '울산광역시',
  세종: '세종특별자치시',
  경기: '경기도',
  강원: '강원특별자치도',
  충북: '충청북도',
  충청북: '충청북도',
  충남: '충청남도',
  충청남: '충청남도',
  전북: '전북특별자치도',
  전라북: '전북특별자치도',
  전남: '전라남도',
  전라남: '전라남도',
  경북: '경상북도',
  경상북: '경상북도',
  경남: '경상남도',
  경상남: '경상남도',
  제주: '제주특별자치도',
};

const TENS: Record<string, number> = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60, 일흔: 70, 여든: 80, 아흔: 90 };
const ONES: Record<string, number> = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };

function parseAge(t: string): number | undefined {
  const d = discoveryPatterns.ageWithUnit.exec(t) ?? (discoveryPatterns.ageAfterLabel.exec(t));
  if (d) return Number(asciiDecimalDigits(d[1] ?? ""));
  const k = discoveryPatterns.nativeAge.exec(t);
  if (k) return (TENS[k[1] ?? ""] ?? 0) + (ONES[k[2] ?? ""] ?? 0);
  return undefined;
}

const SKIP = discoveryPatterns.skip;

/**
 * 답에서 알아들을 수 있는 정보를 모두 뽑는다(한 번에 여러 개 말해도 됨).
 * asking: 지금 물어본 항목 — "네/없어/모름" 같은 짧은 답을 그 항목에 적용한다.
 */
export function parseProfileAnswer(text: string, asking?: ProfileSlot): Partial<UserProfile> {
  // 말 앞의 군말("음", "어", "그러니까")은 빼고 본다: "음 맞아" → "맞아"
  const t = strip(strip(text.replace(discoveryPatterns.spaces, ' '))
    .replace(discoveryPatterns.filler, '') // 뒤에 띄어쓰기가 있을 때만("아니요"·"어디"는 그대로)
    );
  const out: Partial<UserProfile> = {};
  const age = parseAge(t);
  if (age !== undefined && age >= 0 && age <= 120) out.age = age;

  if (discoveryPatterns.disability.test(t)) {
    if (discoveryPatterns.noDisability.test(t)) out.disability = 'no';
    else if (discoveryPatterns.severe.test(t) && !discoveryPatterns.notSevere.test(t)) out.disability = 'severe';
    else if (discoveryPatterns.mild.test(t)) out.disability = 'mild';
    else out.disability = 'yes';
  }
  if (discoveryPatterns.basic.test(t)) out.income = 'basic';
  else if (discoveryPatterns.nearPoor.test(t)) out.income = 'near-poor';
  else if (discoveryPatterns.lowIncome.test(t)) out.income = 'low';
  else if (discoveryPatterns.normalIncome.test(t) && asking === 'income') out.income = 'normal';

  const region = discoveryPatterns.region.exec(t);
  if (region) out.ctpv = CTPV[region[1] ?? ""];

  if (discoveryPatterns.singleParent.test(t)) out.singleParent = true;
  if (discoveryPatterns.children.test(t) || discoveryPatterns.manyChildren.test(t)) out.manyChildren = true;
  if (discoveryPatterns.veteran.test(t)) out.veteran = true;
  if (discoveryPatterns.multicultural.test(t)) out.multicultural = true;
  if (discoveryPatterns.alone.test(t)) out.living = 'alone';

  // 지금 물어본 항목에 대한 짧은 답
  const skip = SKIP.test(t);
  if (asking === 'disability' && out.disability === undefined) {
    if (discoveryPatterns.disabilityYes.test(t)) out.disability = 'yes';
    else if (discoveryPatterns.disabilityNo.test(t)) out.disability = 'no';
    else if (skip) out.disability = 'unknown';
  }
  if (asking === 'income' && out.income === undefined) {
    if (discoveryPatterns.incomeYes.test(t)) out.income = 'low';
    else if (discoveryPatterns.incomeNo.test(t)) out.income = 'normal';
    else if (skip) out.income = 'unknown';
  }
  if (asking === 'ctpv' && out.ctpv === undefined && skip) out.ctpv = null;
  if (asking === 'age' && out.age === undefined && skip) out.age = -1; // 말하지 않음
  return out;
}

export function nextProfileSlot(p: UserProfile): ProfileSlot | undefined {
  return PROFILE_ORDER.find(slot => !Object.hasOwn(p, slot));
}

export function lifeStageOf(age: number | undefined): string | undefined {
  if (age === undefined || age < 0) return undefined;
  if (age < 6) return '영유아';
  if (age < 13) return '아동';
  if (age < 19) return '청소년';
  if (age < 35) return '청년';
  if (age < 65) return '중장년';
  return '노년';
}

export function targetsOf(p: UserProfile): string[] {
  const t: string[] = [];
  if (p.disability !== undefined && !['no', 'unknown'].includes(p.disability)) t.push('장애인');
  if (p.income !== undefined && ['basic', 'near-poor', 'low'].includes(p.income)) t.push('저소득');
  if (p.singleParent === true) t.push('한부모·조손');
  if (p.manyChildren === true) t.push('다자녀');
  if (p.veteran === true) t.push('보훈대상자');
  if (p.multicultural === true) t.push('다문화·탈북민');
  return t;
}

export interface Match {
  service: ServiceSummary;
  score: number;
  /** 왜 골랐는지(사용자에게 말해 줄 이유) */
  reasons: string[];
}

/**
 * 규칙 기반 맞춤 순위:
 *  - 나이를 알면 생애주기가 안 맞는 서비스는 뺀다(생애주기 정보가 없는 서비스는 남김)
 *  - 대상이 정해진 서비스(장애인·저소득 등)는 사용자와 겹칠 때만 남긴다
 *  - 겹치는 대상 수 > 생애주기 일치 > 지역 서비스 > 온라인 신청 가능 순으로 점수
 */
export function matchServices(catalog: ServiceSummary[], p: UserProfile): Match[] {
  const stage = lifeStageOf(p.age);
  const mine = targetsOf(p);
  const seen = new Set<string>();
  const out: Match[] = [];
  for (const s of catalog) {
    if (seen.has(s.servNm)) continue;
    if (stage !== undefined && s.lifeStages.length > 0 && !s.lifeStages.includes(stage)) continue;
    const overlap = s.targets.filter((t) => mine.includes(t));
    if (s.targets.length > 0 && overlap.length === 0) continue;
    if (s.targets.length === 0 && mine.length === 0 && stage === undefined) continue; // 정보가 없으면 너무 넓다
    const reasons = [...overlap];
    let score = overlap.length * 2;
    const text = `${s.servNm} ${s.summary}`;
    // 그 집단을 위한 제도(이름에 집단이 드러남)를 앞으로: 장애인연금·중증장애인 교통비 등
    if (mine.includes('장애인') && discoveryPatterns.disability.test(s.servNm)) score += 3;
    if (mine.includes('저소득') && discoveryPatterns.lowIncomeName.test(s.servNm)) score += 1.5;
    // 장애 정도가 어긋나는 제도는 뒤로(심한 장애인데 경증 대상, 또는 그 반대)
    if (p.disability === 'severe' && discoveryPatterns.mildName.test(text) && !discoveryPatterns.severeName.test(s.servNm)) score -= 3;
    if (p.disability === 'mild' && discoveryPatterns.severeName.test(s.servNm)) score -= 3;
    // 정기적인 현금 지원을 앞으로
    if (s.provision === '현금지급') score += 1;
    if (s.cycle === '월') score += 0.5;
    if (s.themes.includes('생활지원')) score += 0.5;
    if (stage !== undefined && s.lifeStages.includes(stage)) {
      score += 0.5;
      reasons.push(stage);
    }
    if (s.provider === 'local') {
      score += 0.5;
      reasons.push(`${s.region?.sgg ?? s.region?.ctpv ?? 'None'} 지역`);
    }
    if (s.onlineApply === true) score += 0.5;
    if (s.targets.length === 0) score -= 1; // 누구나 대상인 일반 서비스는 뒤로
    seen.add(s.servNm);
    out.push({ service: s, score, reasons });
  }
  return out.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const left = Array.from(a.service.servNm), right = Array.from(b.service.servNm);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const difference = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
      if (difference !== 0) return difference;
    }
    return left.length - right.length;
  });
}

export function describeProfile(p: UserProfile): string {
  const parts: string[] = [];
  if (p.age !== undefined && p.age >= 0) parts.push(`${p.age}세`);
  if (p.disability === 'severe') parts.push('심한 장애');
  else if (p.disability === 'mild') parts.push('심하지 않은 장애');
  else if (p.disability === 'yes') parts.push('장애 있음');
  if (p.income === 'basic') parts.push('기초생활수급');
  else if (p.income === 'near-poor') parts.push('차상위');
  else if (p.income === 'low') parts.push('소득 낮음');
  if (p.ctpv != null && p.ctpv.length > 0) parts.push(p.ctpv);
  return parts.join(', ');
}
