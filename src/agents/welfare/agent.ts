import { z } from 'zod';
import { AGENT_IDS, type SourceCitation } from '../../core/turn.ts';
import { checkGrounding, unsupportedNumbers } from '../../safety/verify.ts';
import { redactText } from '../../safety/privacy.ts';
import { redactedJson, type StructuredLlm } from '../../core/llm.ts';
import { boundedText, omitAbsent } from '../../core/schema.ts';
import { todayIso } from '../../core/time.ts';
import { asciiDecimalDigits, strip } from '../../core/text.ts';
import { tryUrl } from '../../core/url.ts';
import type { ServiceSummary, WelfareDataProvider, WelfareService } from './data/index.ts';
import { describeProfile, matchServices, type Match, type UserProfile } from './discovery.ts';
import { chunkService, retrieve } from './rag.ts';

export const agentPatterns = {
  firstBreak: /(?<=[.。])\p{White_Space}|(?<=니다)\p{White_Space}/u,
  serviceName: /([가-힣]{2,12}(?:연금|수당|급여|바우처|지원금|장려금|지원사업|보험료\p{White_Space}*지원))/u,
  formExt: /\.(hwpx?|pdf)(?=\n?$)/iu,
  deadline: /(지금|현재)[^\n]*(신청|접수)[^\n]*(할\p{White_Space}*수|가능|돼|되나)|(신청|접수)\p{White_Space}*(기간|마감|기한)/u,
  yearRound: /(신청|접수)\p{White_Space}*기간\p{White_Space}*[:：]?\p{White_Space}*연중|연중\p{White_Space}*(신청|접수)/u,
  dateYmd: /(\p{Nd}{4})\p{White_Space}*[.\-\/년]\p{White_Space}*(\p{Nd}{1,2})\p{White_Space}*[.\-\/월]\p{White_Space}*(\p{Nd}{1,2})\p{White_Space}*일?/u,
  compactDate: /(\p{Nd}{4})(\p{Nd}{2})(\p{Nd}{2})/u,
  range: /(?:신청|접수)\p{White_Space}*(?:기간|마감|기한)[^0-9]{0,12}(?:(\p{Nd}{4}\p{White_Space}*[.\-\/년]\p{White_Space}*\p{Nd}{1,2}\p{White_Space}*[.\-\/월]\p{White_Space}*\p{Nd}{1,2}\p{White_Space}*일?|\p{Nd}{8}))\p{White_Space}*(?:[~～\-]|부터)\p{White_Space}*(?:(\p{Nd}{4}\p{White_Space}*[.\-\/년]\p{White_Space}*\p{Nd}{1,2}\p{White_Space}*[.\-\/월]\p{White_Space}*\p{Nd}{1,2}\p{White_Space}*일?|\p{Nd}{8}))/u,
  until: /(?:신청|접수)\p{White_Space}*(?:기간|마감|기한)[^0-9]{0,12}(?:(~|까지)\p{White_Space}*)?(\p{Nd}{4}\p{White_Space}*[.\-\/년]\p{White_Space}*\p{Nd}{1,2}\p{White_Space}*[.\-\/월]\p{White_Space}*\p{Nd}{1,2}\p{White_Space}*일?|\p{Nd}{8})\p{White_Space}*까지/u,
  isoDate: /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}/u,
  sentenceBreak: /(?<=[.!?。]|다\.|요\.)\p{White_Space}+/u,
  eligibility: /(대상|자격|받을\p{White_Space}*수|해당|되나요|돼\?)/u,
  ordinal: /(\p{Nd}{1,2})\p{White_Space}*번/u,
  nativeOrdinal: /(첫|두|세|네|다섯)\p{White_Space}*번\p{White_Space}*째/u,
  hangulPair: /[가-힣]{2}/u,
  extraWords: /(신청|해줘|하고\p{White_Space}*싶|도와|알려|자세히|너가|네가|찾은|그거|그|이|저)/gu,
  space: /\p{White_Space}/gu,
  minAge: /(\p{Nd}{1,3})\p{White_Space}*세\p{White_Space}*이상/u,
  disability: /장애/u,
  income: /소득|재산/u,
  finalPeriod: /[.。](?=\n?$)/u,
  leadingStar: /^[★\p{White_Space}]+/u,
  guide: /사업안내/u,
  phone: /^\p{Nd}/u,
  number: /\p{Nd}/u,
  bokjiro: /bokjiro\.go\.kr(?=\n?$)/u,
  spaces: /\p{White_Space}+/gu,
  target: /(대상|자격|누가|받을\p{White_Space}*수)/u,
  threshold: /선정기준액은/u,
  criteria: /(선정\p{White_Space}*기준|소득인정액)/u,
  benefit: /(얼마|금액|지급액|급여|연금액)/u,
  method: /(방법|절차|어디|어떻게)/u,
  forms: /(서류|서식|양식)/u,
  contact: /(문의|전화|연락)/u,
  punctuation: /[.!?…](?=\n?$)/u,
  dot: /\.(?=\n?$)/u,
};



function catalogSource(fixture: boolean): SourceCitation { return {
  title: '한국사회보장정보원 복지서비스 목록(중앙부처·지자체)',
  url: 'https://www.data.go.kr/data/15090532/openapi.do',
  lastCheckedAt: todayIso(),
  version: fixture ? '저장된 자료 기준' : 'API 실시간',
}; }

export const firstSentence = (s: string, max = 60) => {
  const one = (s.split(agentPatterns.firstBreak)[0] ?? '').replace(agentPatterns.finalPeriod, '');
  const points = Array.from(one);
  return points.length > max ? `${points.slice(0, max).join("")}…` : one;
};

const PRECHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['condition', 'status', 'note'],
        properties: {
          condition: { type: 'string' },
          status: { type: 'string', enum: ['met', 'unmet', 'unknown'] },
          note: { type: 'string' },
        },
      },
    },
  },
};

export interface GroundedAnswer {
  speech: string;
  sources: SourceCitation[];
  count?: number;
  /** 검증된 자료(fixture/공식 API)에 근거했는지 여부 */
  grounded: boolean;
  /** 답변에 쓴 서비스(Agent A 인계용) */
  service?: { servId: string; servNm: string; dataOrigin: WelfareService['dataOrigin'] };
  /** 답변 방식: 근거 검색+LLM 생성 / 주제 규칙 추출 */
  method?: 'rag-llm' | 'topic-rule' | 'general-llm' | 'none';
  /** 검색된 근거 조각(평가용) */
  retrieval?: { chunkIds: string[]; sections: string[]; used: string[] };
  /** 검증 담당 결과: 답의 숫자가 근거에 없어서 규칙 답변으로 바꿨다면 그 이유 */
  verification?: { ok: boolean; reasons: string[] };
}

const RagOutputSchema = z.object({
  answerable: z.boolean(),
  answer: boundedText(0, 600),
  usedChunkIds: z.array(z.string()),
});

const RAG_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answerable', 'answer', 'usedChunkIds'],
  properties: {
    answerable: { type: 'boolean' },
    answer: { type: 'string' },
    usedChunkIds: { type: 'array', items: { type: 'string' } },
  },
};

const RAG_SYSTEM = `너는 시각장애인을 돕는 한국 복지 제도 안내 도우미다.
반드시 사용자 메시지의 "근거" 조각에 적힌 내용만으로 답한다. 근거에 없는 내용은 추측하지 말고 answerable=false로 둔다.
수급 자격을 판정하지 않는다("받을 수 있다/없다"고 단정하지 말 것). 금액·나이·날짜는 근거 그대로 쓴다.
질문에 대한 답(결론·숫자·대상)부터 말하고, 최대 2문장 100자 안팎의 짧고 쉬운 존댓말로 답한다. 묻지 않은 내용(서식, 다른 단계, 예외 조건 등)은 덧붙이지 않는다. 괄호 남발을 피한다.
usedChunkIds에는 답에 실제로 쓴 근거 id만 넣는다.`;

/** 질문 속 복지 제도 이름(예: 기초연금, 주거급여) */
const SERVICE_NAME = agentPatterns.serviceName;

export function isDeadlineQuestion(question: string) { return agentPatterns.deadline.test(question); }
function parseDay(raw: string | undefined): string | undefined {
  const text = strip(raw ?? '');
  let day: number, month: number, year: number;
  if (agentPatterns.isoDate.test(text)) {
    const iso = text.slice(0,10);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(iso)) return undefined;
    year = Number(iso.slice(0,4)); month = Number(iso.slice(5,7)); day = Number(iso.slice(8));
  } else {
    const match = agentPatterns.dateYmd.exec(text) ?? agentPatterns.compactDate.exec(text);
    if (match === null || match[0] !== text) return undefined;
    year = Number(asciiDecimalDigits(match[1] ?? '')); month = Number(asciiDecimalDigits(match[2] ?? '')); day = Number(asciiDecimalDigits(match[3] ?? ''));
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month-1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0,10);
}
type PeriodFields = Partial<Pick<WelfareService, "summary"|"applyMethod"|"target"|"criteria"|"benefit"|"applySteps"|"enfcBgngYmd"|"enfcEndYmd">>;
export function applicationOpenStatus(service: PeriodFields, today = todayIso()): "open"|"closed"|"unknown" {
  const day = parseDay(today.length > 0 ? today : todayIso());
  if (day === undefined) return "unknown";
  const start = parseDay(service.enfcBgngYmd), end = parseDay(service.enfcEndYmd);
  if (start !== undefined && end !== undefined) return start <= day && day <= end ? "open" : "closed";
  const text = [service.summary,service.applyMethod,service.target,service.criteria,service.benefit,
    ...(service.applySteps ?? []).map(step => step.step + " " + step.detail)].join("\n");
  if (agentPatterns.yearRound.test(text)) return "open";
  const range = agentPatterns.range.exec(text);
  if (range !== null) {
    const a = parseDay(range[1]), b = parseDay(range[2]);
    if (a !== undefined && b !== undefined) return a <= day && day <= b ? "open" : "closed";
  }
  const until = parseDay(agentPatterns.until.exec(text)?.[2]);
  return until === undefined ? "unknown" : day <= until ? "open" : "closed";
}

/** MVP 첫 적용 대상. 질문에 다른 서비스명이 없으면 이것을 찾는다. */
const DEFAULT_SERVICE = '장애인연금';
const ELIGIBILITY_NOTE = '자격은 담당 기관이 최종 판단해요.';

const fixtureVersion = (version: string | undefined) => version?.startsWith('fixture') === true ? '저장된 자료 기준' : version;
export const cite = (s: SourceCitation) => omitAbsent({
  title: s.title,
  url: s.url,
  lastCheckedAt: s.lastCheckedAt,
  version: fixtureVersion(s.version),
  note: s.note,
});

/** 말로는 짧게(자세한 링크·확인일은 화면의 근거 자료 목록에 표시) */
export const sourceSentence = (s: SourceCitation) => `(${s.title.startsWith('복지로') ? '출처: 복지로' : `출처: ${s.title}`}, ${fixtureVersion(s.version) ?? ''})`;

/** 음성으로는 핵심 두 문장까지만(LLM이 길게 써도 잘라 낸다). */
const firstSentences = (text: string, n = 2) => {
  const parts = strip(text).split(agentPatterns.sentenceBreak);
  return parts.slice(0, n).join(' ');
};

/** 자격 안내는 자격·대상을 물었을 때만 덧붙인다. */
const eligibilityNote = (q: string) => (agentPatterns.eligibility.test(q) ? ` ${ELIGIBILITY_NOTE}` : '');

/** 긴 공식 문구를 음성으로 듣기 좋게 앞부분 몇 줄만. */
const lines = (text: string | undefined, n: number, maxChars = 220) =>
  (text ?? '')
    .split('\n')
    .map(strip)
    .filter(Boolean)
    .slice(0, n)
    .map((l) => (Array.from(l).length > maxChars ? `${Array.from(l).slice(0, maxChars).join("")}…` : l))
    .join(' ');

/**
 * Agent B의 복지 정보 모듈: 정책 데이터(공식 API 또는 fixture)만 근거로 설명하고 항상 출처·확인일을 붙인다.
 * 화면 텍스트나 사용자 입력을 정책 사실로 섞지 않으며, 수급 자격을 판정하지 않는다.
 */
export class WelfareInformationAgent {
  readonly id = AGENT_IDS.welfare;

  /** 직전에 이야기한 제도(“그럼 신청은 어디서 해?” 같은 이어지는 질문용) */
  private selectedDetail?: WelfareService;
  get lastService(): WelfareService | undefined { return this.selectedDetail; }

  readonly provider: WelfareDataProvider;
  llm?: StructuredLlm;
  constructor(provider: WelfareDataProvider, llm?: StructuredLlm) {
    this.provider = provider;
    this.llm = llm;
  }
  private pickedSource(s: ServiceSummary) {
    const source = this.listSource();
    return { ...source, url: s.detailUrl.length > 0 ? s.detailUrl : source.url, title: `복지로 '${s.servNm}'` };
  }
  private listSource() {
    return catalogSource(this.provider.mode === "fixture" || (this.provider.lastError?.length ?? 0) > 0);
  }

  /** 지금 대화의 기준 제도(없으면 undefined) */
  get currentServiceName(): string | undefined {
    return this.lastService?.servNm ?? this.picked?.servNm;
  }

  /** 지금 제도의 공식 상세 페이지(복지로) — Agent A가 열어 준다 */
  get currentServiceUrl(): string | undefined {
    return (this.picked?.detailUrl.length ?? 0) > 0 ? this.picked?.detailUrl : this.lastService?.source.url.includes('bokjiro') === true ? this.lastService.source.url : undefined;
  }

  // ---------------------------------------------------------------- 맞춤 복지 찾기
  private matches: Match[] = [];
  private shown = 0;
  private listHinted = false;
  /** 사용자가 고른 찾기 결과(목록 요약) */
  private picked?: ServiceSummary;

  get hasMatches(): boolean {
    return this.matches.length > 0;
  }

  private listSpeech(from: number): string {
    const page = this.matches.slice(from, from + 3);
    this.shown = from + page.length;
    // 목록은 이름만 짧게(듣고 고르기 쉽게). 설명은 번호를 말하면 그때.
    const items = page.map((m, i) => `${from + i + 1}번 ${m.service.servNm}`).join(', ');
    const more = this.matches.length > this.shown ? " 더 들으려면 '더 알려줘'." : '';
    const hint = this.listHinted ? '' : " 번호를 말씀하시면 자세히 알려 드려요. 예: '1번 자세히', '1번 자격 확인해줘'.";
    this.listHinted = true;
    return `${items}이에요.${more}${hint}`;
  }

  /** 프로필로 받을 수 있을 법한 제도를 찾는다(자격 판정 아님). */
  async discover(profile: UserProfile): Promise<GroundedAnswer & { count: number }> {
    const catalog = await this.provider.catalog(profile.ctpv ?? undefined);
    this.matches = matchServices(catalog, profile);
    this.shown = 0;
    if (this.matches.length === 0) {
      return { speech: '말씀하신 조건에 맞는 제도를 찾지 못했어요. 조건을 바꿔 말씀하시거나 보건복지상담센터 129에 문의해 보세요.', sources: [this.listSource()], grounded: false, count: 0, method: 'topic-rule' };
    }
    return {
      speech: `받을 수 있을 법한 제도를 ${this.matches.length > 10 ? '여러 개' : `${this.matches.length}개`} 찾았어요. 관련 높은 순서로 ${this.listSpeech(0)} 실제로 받을 수 있는지는 기관이 판단해요.`,
      sources: [this.listSource()],
      grounded: true,
      count: this.matches.length,
      method: 'topic-rule',
    };
  }

  moreMatches(): GroundedAnswer {
    if (this.matches.length === 0) return { speech: "아직 찾은 제도가 없어요. '받을 수 있는 복지 찾아줘'라고 해 보세요.", sources: [], grounded: false };
    if (this.shown >= this.matches.length) return { speech: '찾은 제도를 모두 알려드렸어요.', sources: [this.listSource()], grounded: true };
    return { speech: this.listSpeech(this.shown), sources: [this.listSource()], grounded: true };
  }

  /**
   * "1번", "첫 번째", "장애인연금", "기장군 교통비 지원"(일부·받아쓰기 오타 포함) → 찾기 결과에서 고르기.
   * 고르면 그 제도가 대화의 기준 제도가 된다.
   */
  pick(ref: string | undefined): ServiceSummary | undefined {
    if (ref === undefined || ref.length === 0) return this.picked;
    const hit = this.findInMatches(ref);
    if (hit) {
      this.picked = hit;
      if (this.lastService?.servNm !== hit.servNm) this.selectedDetail = undefined;
    }
    return hit;
  }

  /** 찾기 결과 목록에서 말한 것 찾기(고르지는 않음) */
  findInMatches(ref: string): ServiceSummary | undefined {
    if (this.matches.length === 0) return undefined;
    const ORD: Record<string, number> = { 첫: 1, 두: 2, 세: 3, 네: 4, 다섯: 5 };
    const n = agentPatterns.ordinal.exec(ref) ?? agentPatterns.nativeOrdinal.exec(ref);
    if (n) {
      const value = n[1] ?? '';
      const ordinal = ORD[value] ?? Number(asciiDecimalDigits(value));
      return this.matches[ordinal - 1]?.service;
    }
    const r = ref.replace(agentPatterns.space, '');
    const exact = this.matches.find((m) => r.includes(m.service.servNm.replace(agentPatterns.space, '')))?.service;
    if (exact) return exact;
    // 이름 일부만 말하거나 받아쓰기 오타가 있어도: 말한 글의 2-gram이 제도 이름에 많이 들어 있으면 그 제도
    const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)).filter((g) => agentPatterns.hangulPair.test(g)));
    const said = grams(r.replace(agentPatterns.extraWords, ''));
    if (said.size < 3) return undefined;
    let best: { s: ServiceSummary; score: number } | undefined;
    for (const m of this.matches) {
      const name = grams(m.service.servNm.replace(agentPatterns.space, ''));
      const shared = [...said].filter((g) => name.has(g)).length;
      const score = shared / said.size;
      if (score >= 0.5 && shared >= 3 && (!best || score > best.score)) best = { s: m.service, score };
    }
    return best?.s;
  }

  private async detailOf(s: ServiceSummary | undefined, name?: string): Promise<WelfareService | undefined> {
    if (s?.provider === 'central') return (await this.provider.getService(s.servId)) ?? (await this.provider.findService(s.servNm));
    if (s?.provider === 'local') return this.provider.getLocalService?.(s.servId, s.detailUrl);
    if (name !== undefined && name.length > 0) return this.provider.findService(name);
    return undefined;
  }

  async serviceDetail(ref: string | undefined): Promise<GroundedAnswer> {
    const s = this.pick(ref);
    if (!s) return { speech: "어떤 제도인지 알려 주세요. 예: '1번 자세히'.", sources: [], grounded: false };
    const where = s.provider === 'local' ? `${s.region?.sgg ?? s.region?.ctpv ?? 'None'} 지역 제도예요. ` : '';
    return {
      speech: `${s.servNm}. ${where}${firstSentence(s.summary, 120)}. ${s.targets.length > 0 ? `대상은 ${s.targets.join(', ')}이에요. ` : ''}자격을 살펴보려면 '자격 확인해줘', 신청 준비는 '신청하려면 뭐가 필요해?'라고 해 주세요.`,
      sources: [this.pickedSource(s)],
      grounded: true,
    };
  }

  /**
   * 자격 미리 점검: 공식 선정기준과 사용자 답을 비교해 조건별로 "맞아요/확인 필요/안 맞을 수 있어요".
   * 최종 판정은 하지 않는다. LLM이 없으면 나이 기준만 규칙으로 비교한다.
   */
  async precheck(ref: string | undefined, profile: UserProfile): Promise<GroundedAnswer> {
    const s = this.pick(ref);
    const name = s?.servNm ?? ref ?? this.currentServiceName;
    const detail = await this.detailOf(s, name);
    if (name === undefined || name.length === 0 || (!s && !detail)) return { speech: "어떤 제도의 자격을 살펴볼까요? 예: '1번 자격 확인해줘'.", sources: [], grounded: false };
    if (detail) this.selectedDetail = detail;
    const criteria = detail ? `${detail.target}\n${detail.criteria ?? ''}`.trim() : '';
    if (criteria.length === 0) {
      // 선정기준 원문이 없으면 추측으로 비교하지 않는다.
      return {
        speech: `${name}의 자세한 선정기준을 공식 자료에서 가져오지 못했어요. ${s !== undefined && s.targets.length > 0 ? `목록상 대상은 ${s.targets.join(', ')}이에요. ` : ''}정확한 자격은 담당 기관에 확인해 주세요. 복지로 상세 페이지를 열어 드릴까요?`,
        sources: s !== undefined && s.detailUrl.length > 0 ? [this.pickedSource(s)] : [this.listSource()],
        grounded: false,
      };
    }
    const description = describeProfile(profile);
    const who = description.length > 0 ? description : '알려 주신 정보 없음';
    const word = { met: '맞아요', unmet: '맞지 않을 수 있어요', unknown: '확인이 필요해요' } as const;
    let checks: { condition: string; status: keyof typeof word }[] = [];
    if (this.llm) {
      const privateProfile: Record<string, ReturnType<typeof redactText> | number | boolean | null> = {};
      for (const [key, value] of Object.entries(profile)) {
        if (typeof value === 'string') privateProfile[key] = redactText(value);
        else if (typeof value === 'number' || typeof value === 'boolean' || value === null) privateProfile[key] = value;
      }
      const out = await this.llm.generate({
        system:
          '복지 제도의 공식 대상·선정기준과 사용자 정보를 비교해 조건별로 status를 정한다. met=사용자 정보로 충족이 확인됨, unmet=사용자 정보와 어긋남, unknown=사용자 정보가 없거나(예: 소득 금액, 거주 기간) 판단 불가. 사용자가 말하지 않은 것은 반드시 unknown. 기준 원문에 있는 조건만, 중요한 것 3개 이내. condition은 15자 이내 한국어 명사구(예: "만 18세 이상", "중위소득 50% 이하"), note는 한 문장. 최종 자격을 단정하지 말 것.',
        user: redactedJson({ 제도: redactText(name), 기준: redactText(Array.from(criteria).slice(0, 2500).join("")), 사용자: { ...privateProfile, 설명: redactText(who) } }),
        schemaName: 'precheck',
        schema: PRECHECK_SCHEMA,
      });
      const raw = z.object({ checks: z.array(z.unknown()) }).safeParse(out);
      if (raw.success) {
        const check = z.object({ condition: z.string().min(1), status: z.enum(['met', 'unmet', 'unknown']) });
        checks = raw.data.checks.flatMap(value => { const item = check.safeParse(value); return item.success ? [item.data] : []; }).slice(0, 3);
      }
    }
    if (checks.length === 0) {
      const min = agentPatterns.minAge.exec(criteria);
      if (min && profile.age !== undefined && profile.age >= 0) {
        checks.push({ condition: `${min[1]}세 이상`, status: profile.age >= Number(asciiDecimalDigits(min[1] ?? '')) ? 'met' : 'unmet' });
      }
      if (agentPatterns.disability.test(criteria)) checks.push({ condition: '장애 기준', status: profile.disability === 'severe' ? 'met' : 'unknown' });
      if (agentPatterns.income.test(criteria)) checks.push({ condition: '소득·재산 기준', status: profile.income === 'basic' ? 'met' : 'unknown' });
    }
    const lines = checks.map((c) => `${c.condition.replace(agentPatterns.finalPeriod, '')}: ${word[c.status]}`).join('. ');
    return {
      speech: `${name} 자격을 미리 살펴봤어요. ${lines.length > 0 ? lines : '기준과 비교할 정보가 부족해요'}. 최종 자격은 기관이 판단해요. 신청 준비가 궁금하면 '신청하려면 뭐가 필요해?'라고 해 주세요.`,
      sources: detail ? [cite(detail.source)] : [this.listSource()],
      grounded: !!detail,
      ...(detail ? {service: {servId: detail.servId, servNm: detail.servNm, dataOrigin: detail.dataOrigin}} : {}),
      method: this.llm ? 'rag-llm' : 'topic-rule',
    };
  }

  /** 신청 준비: 신청 경로·서식·문의처를 짧게. 자세한 건 Agent A가 공식 페이지를 열어 준다. */
  async prepare(ref: string | undefined): Promise<GroundedAnswer> {
    const s = this.pick(ref);
    const name = s?.servNm ?? ref ?? this.currentServiceName;
    const detail = await this.detailOf(s, name);
    if (!detail) {
      return {
        speech: name !== undefined && name.length > 0 ? `${name}의 신청 서류는 공식 상세 페이지에서 확인해야 해요. '신청 페이지 열어줘'라고 하시면 열어 드릴게요.` : '어떤 제도의 신청을 준비할까요?',
        sources: s !== undefined && s.detailUrl.length > 0 ? [this.pickedSource(s)] : [],
        grounded: false,
      };
    }
    this.selectedDetail = detail;
    const how = detail.applySteps?.[0]?.detail ?? detail.applyMethod;
    const forms = (detail.forms ?? []).map((f) => f.name.replace(agentPatterns.formExt, '').replace(agentPatterns.leadingStar, '')).filter((f) => !agentPatterns.guide.test(f));
    const contact = detail.contacts?.find((c) => agentPatterns.phone.test(c.value));
    return {
      speech: `${detail.servNm} 신청은 ${firstSentence(how, 80)}에서 해요.${forms.length > 0 ? ` 필요한 서식은 ${forms.slice(0, 3).join(', ')} 등이 있어요.` : ''}${contact ? ` 문의는 ${contact.name} ${contact.value}.` : ''} 복지로 상세 페이지를 열어 드릴까요?`,
      sources: [cite(detail.source)],
      grounded: true,
      service: { servId: detail.servId, servNm: detail.servNm, dataOrigin: detail.dataOrigin },
    };
  }

  get answerMode(): 'rag-llm' | 'topic-rule' {
    return this.llm ? 'rag-llm' : 'topic-rule';
  }

  get dataMode() {
    return this.provider.mode;
  }

  async explainField(fieldId: string, label: string): Promise<GroundedAnswer> {
    const entry = await this.provider.getFieldGlossary(fieldId);
    if (!entry) {
      return {
        speech: `'${label}' 항목에 대한 검증된 설명 자료가 아직 없습니다. 추측해서 설명하지 않겠습니다. 담당 기관에 문의해 주세요.`,
        sources: [],
        grounded: false,
      };
    }
    return {
      speech: `'${entry.term}' 항목 설명입니다. ${entry.explanation} ${sourceSentence(entry.source)}`,
      sources: [cite(entry.source)],
      grounded: true,
    };
  }

  /** 말에 제도 이름이 있으면 공식 자료에서 찾아 대화의 기준 제도로 삼는다(실제 사이트 신청 안내용). */
  async selectService(text: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!SERVICE_NAME.test(text.replace(agentPatterns.spaces, ''))) return undefined;
    signal?.throwIfAborted();
    const s = await this.service(text, signal);
    signal?.throwIfAborted();
    if (!s) return undefined;
    this.selectedDetail = s;
    this.picked = undefined;
    return s.servNm;
  }

  /** 질문에서 제도 이름을 찾고, 없으면 직전 제도 → 기본(장애인연금) 순서. */
  private async service(question: string): Promise<WelfareService | undefined> {
    const named = SERVICE_NAME.exec(question.replace(agentPatterns.spaces, ''))?.[1];
    if (named !== undefined && named.length > 0) {
      const exact = await this.provider.findService(named);
      if (exact) return exact;
      const first = (await this.provider.listServices(named))[0];
      if (first) return (await this.provider.getService(first.servId)) ?? first;
      return undefined;
    }
    // 제도 이름도, 이전 대화의 제도도 없으면 특정 제도를 가정하지 않는다(호출자가 되묻는다).
    return this.lastService;
  }

  private static readonly ASK_SERVICE: GroundedAnswer = {
    speech: '어떤 제도에 대해 궁금하신가요? 예를 들어 기초연금, 주거급여, 아동수당처럼 제도 이름을 말씀해 주세요.',
    sources: [],
    grounded: false,
    method: 'none',
  };

  /**
   * 자유 질문(티키타카): 공식 데이터를 근거 조각으로 나눠 검색하고, LLM이 근거 안에서만 답한다.
   * LLM이 없거나 실패하면 주제 규칙(answerPolicyQuestion)으로 답한다.
   */
  private deadlineAnswer(s: WelfareService, today?: string): GroundedAnswer {
    const status = applicationOpenStatus(s, today);
    const contact = s.contacts?.find(c => agentPatterns.phone.test(c.value));
    const phone = contact === undefined ? '' : ` 문의는 ${contact.name} ${contact.value}.`;
    const answer = status === 'unknown' ? `${s.servNm}을 지금 신청할 수 있는지는 공식 자료에서 확인하지 못했어요.${phone}` :
      `${s.servNm}은 지금 신청할 수 ${status === 'open' ? '있어요' : '없어요'}.`;
    return { speech: answer + " " + sourceSentence(s.source), sources: [cite(s.source)], grounded: status !== 'unknown',
      method: 'topic-rule', service: { servId: s.servId, servNm: s.servNm, dataOrigin: s.dataOrigin } };
  }
  async answerQuestion(question: string, today?: string): Promise<GroundedAnswer> {
    const named = SERVICE_NAME.test(question.replace(agentPatterns.spaces, ''));
    if (!named && !this.lastService) return {...WelfareInformationAgent.ASK_SERVICE, sources: []};
    const s = await this.service(question);
    if (!s) {
      return { speech: '그 제도의 공식 자료를 찾지 못했어요. 보건복지상담센터 129에 문의해 보세요.', sources: [], grounded: false, method: 'none' };
    }
    this.selectedDetail = s;
    if (isDeadlineQuestion(question)) return this.deadlineAnswer(s, today);
    if (!this.llm) return this.topicAnswer(s, question, today);

    const top = retrieve(question, chunkService(s), 3);
    const raw = await this.llm.generate({
      system: RAG_SYSTEM,
      user: redactedJson({ question: redactText(question), 제도: redactText(s.servNm), 기준: redactText(s.source.version), 근거: top.map(c => ({ id: redactText(c.id), 항목: redactText(c.section), 내용: redactText(c.text) })) }),
      schemaName: 'grounded_answer',
      schema: RAG_JSON_SCHEMA,
    });
    const parsed = RagOutputSchema.safeParse(raw);
    const ids = new Set(top.map((c) => c.id));
    const used = parsed.success ? parsed.data.usedChunkIds.filter((id) => ids.has(id)) : [];
    const retrieval = { chunkIds: top.map((c) => c.id), sections: top.map((c) => c.section), used };
    // 형식 오류이거나, 답했다면서 근거를 하나도 대지 못하면 믿지 않고 규칙 답변으로 대체한다.
    if (!parsed.success || (parsed.data.answerable && used.length === 0)) return { ...this.topicAnswer(s, question), retrieval };
    if (parsed.data.answerable) {
      // 검증 담당: 답에 나온 금액·나이·날짜가 LLM에 준 근거 조각(또는 질문)에 있어야 한다. 없으면 지어낸 숫자로 보고 규칙 답변으로 바꾼다.
      // (근거 id를 잘못 댄 것은 위 usedChunkIds 검사가, 숫자 자체는 여기서 본다)
      const check = checkGrounding({ answer: parsed.data.answer, sources: top.map((c) => c.text), allowed: [question], minQuotes: 0 });
      if (!check.ok) return { ...this.topicAnswer(s, question), retrieval, verification: { ok: false, reasons: check.reasons } };
    }
    if (!parsed.data.answerable) {
      // 공식 자료에 없을 때: 일반적으로 알려진 내용이 확실하면 '공식 자료 아님'을 밝히고 짧게 알려 준다.
      const general = z.object({ known: z.boolean(), answer: z.string() }).safeParse(await this.llm.generate({
        system:
          '사용자의 복지 질문에 대한 답이 공식 자료에 없었다. 일반적으로 널리 알려진 사실이 확실할 때만 known=true로 1~2문장 쉬운 존댓말 답을 써라. 확실하지 않거나 개인마다 다르면 known=false. 수급 자격은 판정하지 말 것.',
        user: redactedJson({ question: redactText(question), 제도: redactText(s.servNm) }),
        schemaName: 'general_answer',
        schema: { type: 'object', additionalProperties: false, required: ['known', 'answer'], properties: { known: { type: 'boolean' }, answer: { type: 'string' } } },
      }));
      const said = general.success && general.data.known ? strip(general.data.answer) : '';
      const numbered = agentPatterns.number.test(said);
      if (said.length > 0 && !numbered) {
        return {
          speech: `${s.servNm} 공식 자료에는 그 내용이 없어요. 일반적으로 알려진 바로는, ${said} 정확한 내용은 주민센터나 보건복지상담센터 129에 꼭 확인해 주세요.`,
          sources: [cite(s.source)],
          grounded: false,
          method: 'general-llm',
          service: { servId: s.servId, servNm: s.servNm, dataOrigin: s.dataOrigin },
          retrieval,
        };
      }
      return {
        speech: `${s.servNm} 공식 자료에서 그 내용은 찾지 못했습니다. 추측해서 답하지 않겠습니다. 보건복지상담센터 129에 문의해 보세요. ${sourceSentence(s.source)}`,
        sources: [cite(s.source)],
        grounded: false,
        method: 'rag-llm',
        ...(numbered ? { verification: {ok: false, reasons: ['공식 자료에 없는 답에 숫자']} } : {}),
        service: { servId: s.servId, servNm: s.servNm, dataOrigin: s.dataOrigin },
        retrieval,
      };
    }
    return {
      speech: `${firstSentences(parsed.data.answer)}${eligibilityNote(question)} ${sourceSentence(s.source)}`,
      sources: [cite(s.source)],
      grounded: true,
      method: 'rag-llm',
      service: { servId: s.servId, servNm: s.servNm, dataOrigin: s.dataOrigin },
      retrieval,
    };
  }

  /**
   * 복지로 상세 페이지(주소의 wlfareInfoId)를 공식 API 자료로 "읽을 글"로 만든다.
   * 복지로 화면은 지원대상·서비스 내용·신청방법이 탭으로 나뉘어 한 번에 한 탭만 보이므로, 화면 대신 공식 자료를 중요한 순서로 읽는다.
   * 찾지 못하면 undefined(호출자가 화면 본문을 읽음).
   */
  async readableService(pageUrl: string): Promise<{ servNm: string; text: string } | undefined> {
    const url = tryUrl(pageUrl);
    if (url === undefined || !agentPatterns.bokjiro.test(url.hostname)) return undefined;
    const id = url.param("wlfareInfoId");
    if (id === undefined || id.length === 0) return undefined;
    const s =
      (this.lastService?.servId === id ? this.lastService : undefined) ??
      (await this.provider.getService(id).catch(() => undefined)) ??
      (await this.provider.getLocalService?.(id, pageUrl).catch(() => undefined));
    if (!s) return undefined;
    this.selectedDetail = s;
    const block = (label: string, text: string | undefined) => {
      const body = (text ?? '').split('\n').map(strip).filter(Boolean).join(' ');
      return body.length > 0 ? `${label}: ${body.endsWith('.') ? body : `${body}.`}` : '';
    };
    const steps = s.applySteps !== undefined && s.applySteps.length > 0 ? s.applySteps.map((a) => `${a.step}은 ${a.detail}`).join('. ') : s.applyMethod;
    const contact = s.contacts !== undefined && s.contacts.length > 0 ? s.contacts.map((c) => `${c.name} ${c.value}`).join(', ') : '';
    const text = [
      `${s.servNm}. ${s.summary}`,
      // 사용자에게 중요한 순서: 누가 받는지 → 무엇을 받는지 → 어떻게 신청하는지 → 문의 → (계산식이 많은) 자세한 선정 기준
      block('지원 대상', s.target),
      block('서비스 내용', s.benefit),
      block('신청 방법', steps),
      block('문의', contact),
      block('자세한 선정 기준', s.criteria),
    ]
      .filter(Boolean)
      .join(' ');
    return { servNm: s.servNm, text };
  }

  /**
   * 지금 제도의 요점 한두 문장: 누가 → 무엇을 → 어떻게 신청. 듣자마자 머리에 그려지게.
   * LLM이 있으면 공식 자료로 압축하고(숫자는 자료에 있는 것만), 없거나 틀리면 자료 첫 문장들로.
   */
  async briefing(signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    const s = this.lastService;
    if (!s) return undefined;
    const source = Array.from([`대상: ${s.target}`, `내용: ${s.benefit ?? s.summary}`, `신청: ${s.applyMethod}`].join('\n')).slice(0, 2500).join('');
    if (this.llm) {
      const out = z.object({text: z.string()}).safeParse(await this.llm.generate({
        system:
          '복지 제도 공식 자료를 시각장애인이 듣자마자 이해하도록 요점만 말한다. "누가 무엇을 받고, 어디서 신청하는지"를 쉬운 존댓말 1~2문장, 합쳐 80자 안팎으로. 자료에 없는 내용·숫자는 쓰지 않는다. 예외 조건·계산식은 빼고, 자격을 단정하지 않는다.',
        user: redactedJson({ 제도: redactText(s.servNm), 자료: redactText(source) }),
        schemaName: 'service_brief', signal,
        schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
      }));
      signal?.throwIfAborted();
      const text = out.success ? strip(out.data.text) : '';
      if (text.length > 0 && unsupportedNumbers(text, [source]).length === 0) return text;
    }
    return `대상은 ${firstSentence(s.target, 70)}. 신청은 ${firstSentence(s.applyMethod, 50)}.`;
  }

  /** 질문 주제(대상·기준·금액·절차·서류·문의)에 맞는 부분만 골라 답한다(LLM 없이). */
  async answerPolicyQuestion(question: string, today?: string): Promise<GroundedAnswer> {
    if (!SERVICE_NAME.test(question.replace(agentPatterns.spaces, '')) && !this.lastService) return {...WelfareInformationAgent.ASK_SERVICE, sources: []};
    const s = await this.service(question);
    if (!s) return { speech: '그 제도의 공식 자료를 찾지 못했어요. 보건복지상담센터 129에 문의해 보세요.', sources: [], grounded: false, method: 'none' };
    this.selectedDetail = s;
    return this.topicAnswer(s, question, today);
  }

  private topicAnswer(s: WelfareService, question: string, today?: string): GroundedAnswer {

    if (isDeadlineQuestion(question)) return this.deadlineAnswer(s, today);
    const parts: string[] = [];
    if (agentPatterns.target.test(question)) {
      parts.push(`지원 대상: ${lines(s.target, 1)}`);
      const threshold = s.criteria?.split('\n').find((l) => agentPatterns.threshold.test(l));
      if (threshold !== undefined && threshold.length > 0) parts.push(threshold.trim());
    }
    if (agentPatterns.criteria.test(question)) parts.push(`선정 기준: ${lines(s.criteria, 3)}`);
    if (agentPatterns.benefit.test(question)) {
      parts.push(s.benefit !== undefined && s.benefit.length > 0 ? `지원 내용: ${lines(s.benefit, 2)}` : '지원 금액 정보는 이 자료에 없습니다.');
    }
    if (agentPatterns.method.test(question)) {
      parts.push(
        s.applySteps !== undefined && s.applySteps.length > 0 ? `신청 절차: ${s.applySteps.map((a) => `${a.step}은 ${a.detail}`).join('. ')}`
          : `신청 방법: ${s.applyMethod}`,
      );
    }
    if (agentPatterns.forms.test(question)) {
      parts.push(s.forms !== undefined && s.forms.length > 0 ? `관련 서식: ${s.forms.map((f) => f.name.replace(agentPatterns.formExt, '')).join(', ')}` : '서식 정보는 이 자료에 없습니다.');
    }
    if (agentPatterns.contact.test(question)) {
      parts.push(s.contacts !== undefined && s.contacts.length > 0 ? `문의처: ${s.contacts.map((c) => `${c.name} ${c.value}`).join(', ')}` : '문의처 정보는 이 자료에 없습니다.');
    }
    if (parts.length === 0) parts.push(s.summary, `지원 대상: ${lines(s.target, 1)}`);

    return {
      speech: `${parts.map((p) => (agentPatterns.punctuation.test(p.trim()) ? p.trim() : `${p.trim()}.`)).join(' ')}${eligibilityNote(question)} ${sourceSentence(s.source)}`,
      sources: [cite(s.source)],
      grounded: true,
      method: 'topic-rule',
      service: { servId: s.servId, servNm: s.servNm, dataOrigin: s.dataOrigin },
    };
  }

  /** 신청서를 열 때 덧붙이는 짧은 실제 신청 경로 안내와 근거. */
  async applicationContext(signal?: AbortSignal): Promise<GroundedAnswer> {
    signal?.throwIfAborted();
    const s = await this.provider.findService(DEFAULT_SERVICE, signal);
    signal?.throwIfAborted();
    if (!s) return { speech: '', sources: [], grounded: false };
    // 신청을 시작했으면 이후 "소득 있어도 돼?" 같은 질문은 이 제도에 대한 것이다.
    this.selectedDetail = s;
    const first = (text: string) => (text.split('. ')[0] ?? '').replace(agentPatterns.dot, '');
    const speech = s.applySteps?.[0]
      ? `참고로 실제 ${s.servNm} 신청은 ${first(s.applySteps[0].detail)}에서 할 수 있습니다.`
      : `참고로 실제 ${s.servNm}은 ${first(s.applyMethod)}.`;
    return {
      speech,
      sources: [cite(s.source)],
      grounded: true,
      service: { servId: s.servId, servNm: s.servNm, dataOrigin: s.dataOrigin },
    };
  }
}
