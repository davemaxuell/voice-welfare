import { z } from "zod";
import { boundedText, omitAbsent, optional } from "./schema.ts";
import type { SessionState } from "./turn.ts";

export const HELP_GROUPS = ["시작", "복지 정보", "웹 읽기", "신청서", "언제든"] as const;
export type HelpGroup = (typeof HELP_GROUPS)[number];
export interface Example { text: string; state: SessionState }

const nonempty = z.string().min(1);
export const FillSchema = z.object({ fieldMention: nonempty, value: boundedText(1, 200) });
export type Fill = z.infer<typeof FillSchema>;

type Utterance = string | readonly [text: string, state: SessionState];
function example(utterance: Utterance): Example {
  return typeof utterance === "string" ? { text: utterance, state: "IDLE" } : { text: utterance[0], state: utterance[1] };
}

function intent<const K extends string, S extends z.ZodRawShape>(
  type: K, describe: string, help: HelpGroup | undefined, utterances: [Utterance, ...Utterance[]],
  params: S, flags: { llm?: boolean; beforeConsent?: boolean } = {},
) {
  const [first, ...rest] = utterances;
  const examples: [Example, ...Example[]] = [example(first), ...rest.map(example)];
  return { type, describe, help, examples, schema: z.object({ ...params, type: z.literal(type) }),
    llm: flags.llm ?? true, beforeConsent: flags.beforeConsent ?? false };
}

const FORM = "APPLICATION_OPEN", WEB = "BROWSING", CONFIRM = "WAITING_FOR_USER_CONFIRMATION";
// 도움말 예문, 동의 전에 허용할 명령, 계획 프롬프트, 경계 스키마가 같은 표를 쓴다.
export const INTENTS = [
  intent("OPEN_SITE", "특정 사이트 열기: site에 사용자가 지정한 사이트 이름이나 주소", "시작",
    ["복지로 열어줘", "정부24 들어가줘"], { target: nonempty }),
  intent("START_APPLICATION", "장애인연금 신청 시작", "시작",
    ["장애인연금 신청 도와줘", "신청 페이지를 열어줘"], {}),
  intent("GOAL", "웹에서 여러 단계를 거쳐야 하는 목표: topic에 목표 문장", "시작",
    ["네이버에서 오늘 뉴스 알려줘", "복지로 가서 기초연금 신청 방법 찾아줘"], { goal: boundedText(2, 200) }),
  intent("OPEN_BROWSER", "사이트 이름 없이 크롬·브라우저만 켜기", "시작",
    ["크롬 켜줘", "브라우저 열어줘"], {}),
  intent("POLICY_QUESTION", "제도 대상·절차 질문", "복지 정보",
    ["기초연금은 몇 살부터 받아?", "장애인연금 지원대상과 신청 절차 알려줘"], { topic: z.string() }, { beforeConsent: true }),
  intent("DISCOVER", "나에게 맞는 복지 찾기", "복지 정보",
    ["나한테 맞는 복지 찾아줘", "받을 수 있는 복지 찾아줘"], {}, { beforeConsent: true }),
  intent("FIND_PLACE", "공식 자료에서 기관 위치·전화번호 찾기", "복지 정보",
    ["우리 동네 주민센터 어디야?", "국민연금 지사 전화번호 알려줘"], {}, { beforeConsent: true }),
  intent("PRECHECK", "특정 제도 자격 미리 점검: topic에 제도명", "복지 정보",
    ["기초연금 받을 수 있는지 확인해줘", "1번 자격 확인해줘"], { service: optional(z.string()) }, { beforeConsent: true }),
  intent("PREPARE_APPLY", "신청 준비·서류: topic에 제도명", "복지 정보",
    ["신청하려면 뭐가 필요해?", "기초연금 신청 서류 알려줘"], { service: optional(z.string()) }, { beforeConsent: true }),
  intent("SERVICE_DETAIL", "찾아 드린 제도 목록 중 하나 자세히: topic에 목록 번호나 제도명", "복지 정보",
    ["2번 자세히 알려줘", "1번 설명해줘"], { service: optional(z.string()) }, { beforeConsent: true }),
  intent("OPEN_OFFICIAL", "찾아 드린 제도의 공식 안내 페이지를 읽기 전용으로 열기: topic에 목록 번호나 제도명, 없으면 방금 이야기한 제도", "복지 정보",
    ["공식 안내 열어줘", "2번 공식 안내 열어줘"], { service: optional(z.string()) }),
  intent("HELP_HUMAN", "사람 도움 요청", "복지 정보",
    ["상담원 연결해줘", "사람한테 도움 받고 싶어"], {}, { beforeConsent: true }),
  intent("READ_START_GUIDE", "첫 이용 안내 다시 듣기", undefined,
    ["시작 안내 다시 읽어줘", "처음 안내 다시 들려줘"], {}, { llm: false, beforeConsent: true }),
  intent("INTRO_REPLAY", "청음 소개 다시 듣기", undefined,
    ["청음 소개 다시 해줘", "청음 소개해줘"], {}, { llm: false }),
  intent("SETUP_RESTART", "처음 설정 다시 하기", undefined,
    ["설정 다시 해줘", "처음 설정 다시 할래"], {}, { llm: false, beforeConsent: true }),
  intent("READ_MAIN", "웹 페이지 본문 읽기: 이어서 더 읽어 달라면 more=true", "웹 읽기",
    [["본문 읽어줘", WEB], ["계속 읽어줘", WEB]], { more: z.boolean() }),
  intent("LIST_LINKS", "누를 수 있는 링크·메뉴 목록: 이어서 더 알려 달라면 more=true", "웹 읽기",
    [["링크 목록 알려줘", WEB], ["링크 더 알려줘", WEB]], { more: z.boolean() }),
  intent("FOLLOW_LINK", "화면의 링크·메뉴·버튼 누르기: topic에 그 이름", "웹 읽기",
    [["공지사항 눌러줘", WEB], ["장애인연금 안내 링크 눌러줘", WEB]], { name: nonempty }),
  intent("SEARCH", "검색: topic에 검색어, 어느 사이트에서 찾을지 말했으면 site에 그 이름", "웹 읽기",
    [["기초연금 검색해줘", WEB], ["복지로에서 기초연금 검색해줘", WEB]], { query: boundedText(1, 100), site: optional(z.string()) }),
  intent("PREV", "이전 단계", "웹 읽기",
    [["뒤로 가줘", WEB], ["이전으로", FORM]], {}),
  intent("ABOUT_SITE", "지금 연 사이트가 어떤 곳인지", "웹 읽기",
    [["여기 무슨 사이트야?", WEB], ["이 사이트 뭐 하는 곳이야?", WEB]], {}),
  intent("LOGIN", "로그인/본인인증", "웹 읽기",
    [["로그인하고 싶어", WEB], ["로그인 페이지 열어줘", WEB], ["다 입력했어", "AUTH_HANDOFF"]], {}),
  intent("CLEAR_LOGIN", "로그아웃·로그인 기록 삭제", "웹 읽기",
    ["로그아웃해줘", "로그인 기록 지워줘"], {}),
  intent("READ_DOWNLOAD", "받은 파일 읽기", "웹 읽기",
    ["받은 파일 읽어줘", "다운로드 읽어줘", "받은 파일 목록", "받은 파일 요약해줘", "받은 PDF에서 신청 기한이 언제야?"], { list: z.boolean().nullable().default(false).transform(value => value ?? undefined) }),
  intent("FILL", "입력란에 값 입력", "신청서",
    [["이름은 김하늘", FORM], ["주소는 부산광역시 예시구 예시로 10", FORM]], { fills: z.array(FillSchema).min(1).max(5) }),
  intent("NEXT", "다음 단계", "신청서",
    [["다음으로", FORM], ["다음 단계로 넘어가줘", FORM]], {}),
  intent("READ_FIELD", "항목 값 다시 읽기", "신청서",
    [["주소 다시 읽어줘", FORM], ["이름 뭐였지?", FORM]], { fieldMention: nonempty }),
  intent("REVIEW", "입력 내용 전체 읽기", "신청서",
    [["지금까지 쓴 내용 읽어줘", FORM], ["입력한 내용 전체 읽어줘", FORM]], {}),
  intent("EXPLAIN", "항목 뜻 설명", "신청서",
    [["이 항목은 무슨 뜻이야?", FORM], ["가구원 수가 무슨 뜻이야?", FORM]], { fieldMention: optional(z.string()) }),
  intent("EDIT_FIELD", "항목 수정 의사, 값 없음", "신청서",
    [["주소 수정할게", FORM], ["이름 고칠래", FORM]], { fieldMention: nonempty }),
  intent("CURRENT_STEP", "현재 단계 안내", "신청서",
    [["지금 어느 단계야?", FORM], ["현재 단계 알려줘", FORM]], {}),
  intent("PREPARE_SUBMIT", "제출/접수 준비", "신청서",
    [["최종 확인할게", FORM], ["모의 접수 내용을 확인했어", FORM]], {}),
  intent("STOP", "즉시 멈춤", "언제든",
    ["멈춰", "그만"], {}, { llm: false, beforeConsent: true }),
  intent("PROGRESS", "하고 있는 일이 어디까지 왔는지 묻기", "언제든",
    ["지금 어디까지 했어?", "얼마나 남았어?"], {}, { llm: false, beforeConsent: true }),
  intent("DESCRIBE_PICTURE", "요청한 브라우저 화면 사진 설명", "웹 읽기",
    ["화면 사진으로 설명해줘", "페이지 전체를 캡처해서 접수 기한을 알려줘", "스크린샷으로 차트의 추세를 알려줘"], { question: nonempty }, { llm: false }),
  intent("DESCRIBE_SCREEN", "화면 전체 설명", "언제든",
    ["화면 설명해줘", "지금 화면에 뭐가 있어?"], {}),
  intent("REPHRASE", "방금 들은 안내를 쉬운 말로 다시", "언제든",
    ["쉽게 말해줘", "무슨 말이야?"], {}),
  intent("RESUME", "다시 시작", "언제든",
    [["다시 시작", "STOPPED"], "계속 진행해"], {}),
  intent("APPROVE", "실행 직전 승인", undefined,
    [["모의접수 승인", CONFIRM], ["응", CONFIRM]], {}, { llm: false }),
  intent("REJECT", "접수 거절", undefined,
    [["승인 안 해", CONFIRM], ["아니", CONFIRM]], {}),
  intent("AUTH_DONE", "인증 마침", undefined,
    [["인증 끝났어", "AUTH_HANDOFF"], ["다 했어", "AUTH_HANDOFF"], ["로그인 완료했어", "AUTH_HANDOFF"]], {}),
  intent("WHAT_CAN_I_SAY", "할 수 있는 말(도움말) 안내: 다른 말도 더 알려 달라면 more=true", undefined,
    ["뭐라고 말하면 돼?", "뭘 할 수 있어?", "도움말", "사용법 알려줘", "명령어 알려줘", "다른 말도 알려줘", "도움말 더"], { more: z.boolean().default(false) }, { beforeConsent: true }),
  intent("UNKNOWN", "그 외/불확실", undefined,
    ["오늘 날씨 어때", "블라블라"], { text: z.string() }),
] as const;

export const INTENT_TYPES = INTENTS.map(spec => spec.type);
const [first, ...others] = INTENTS;
export const IntentSchema = z.discriminatedUnion("type", [first.schema, ...others.map(row => row.schema)]).transform(omitAbsent);
export type Intent = z.infer<typeof IntentSchema>;
export type IntentType = Intent["type"];
export function parseIntent(candidate: unknown): Intent | undefined {
  return IntentSchema.safeParse(candidate).data;
}

export type HelpPage = [HelpGroup, string[]][];
export function helpPages(lead: readonly HelpGroup[], consented: boolean): HelpPage[] {
  const remaining = new Map(HELP_GROUPS.map(group => [group, INTENTS
    .filter(spec => spec.help === group && (consented || spec.beforeConsent))
    .map(spec => spec.examples[0].text)]));
  let otherGroups = [...new Set<HelpGroup>(["언제든", ...HELP_GROUPS])].filter(group => !lead.includes(group));
  const pages: HelpPage[] = [];
  while (true) {
    const page: HelpPage = [];
    for (const group of [...lead, ...otherGroups]) {
      const examples = remaining.get(group);
      if (examples !== undefined && examples.length > 0) page.push([group, examples.splice(0, 2)]);
      if (page.length === 3) break;
    }
    if (page.length === 0) return pages;
    pages.push(page);
    const used = new Set(page.map(([group]) => group));
    otherGroups = [...otherGroups.filter(group => !used.has(group)), ...otherGroups.filter(group => used.has(group))];
  }
}
