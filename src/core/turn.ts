import type { Redacted } from "./llm.ts";
import { z } from "zod";
import {
  ActionSchema, ActionResultSchema, ObservedFieldSchema, StepInfoSchema, UrlStringSchema,
  type Observation,
} from "./actions.ts";
import { ChoiceKeySchema } from "./choices.ts";
import { integer, omitAbsent, optional } from "./schema.ts";

export const SESSION_STATES = [
  "AWAITING_CONSENT", "IDLE", "LISTENING", "TRANSCRIBED",
  "INTENT_DETECTED", "OBSERVING", "PLANNING", "POLICY_CHECK",
  "EXECUTING", "VERIFYING", "SPEAKING", "APPLICATION_OPEN",
  "BROWSING", "NEEDS_CLARIFICATION", "AWAITING_FIELD_VALUE", "VALIDATION_ERROR",
  "WAITING_FOR_USER_CONFIRMATION", "AUTH_HANDOFF", "RECOVERING", "PAUSED",
  "STOPPED", "MOCK_SUBMITTED", "DONE",
] as const;
export const SessionStateSchema = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof SessionStateSchema>;
export const STATE_LABELS_KO = {
  AWAITING_CONSENT: "동의 대기",
  IDLE: "대기",
  LISTENING: "듣는 중",
  TRANSCRIBED: "전사 완료",
  INTENT_DETECTED: "의도 파악",
  OBSERVING: "화면 확인 중",
  PLANNING: "계획 중",
  POLICY_CHECK: "안전 확인 중",
  EXECUTING: "실행 중",
  VERIFYING: "결과 확인 중",
  SPEAKING: "안내 중",
  APPLICATION_OPEN: "신청서 작성 중",
  BROWSING: "웹 페이지 읽는 중(읽기 전용)",
  NEEDS_CLARIFICATION: "확인 필요",
  AWAITING_FIELD_VALUE: "새 값 기다리는 중",
  VALIDATION_ERROR: "입력 오류",
  WAITING_FOR_USER_CONFIRMATION: "승인 대기",
  AUTH_HANDOFF: "직접 인증 필요",
  RECOVERING: "오류 복구 중",
  PAUSED: "일시정지",
  STOPPED: "중단됨",
  MOCK_SUBMITTED: "모의접수 완료",
  DONE: "완료",
} satisfies Record<SessionState, string>;
export const PIPELINE_PHASES = [
  "TRANSCRIBED", "INTENT_DETECTED", "OBSERVING", "PLANNING", "POLICY_CHECK", "EXECUTING", "VERIFYING", "SPEAKING",
] as const;
export const AGENT_IDS = {
  orchestrator: "orchestrator", welfare: "welfare-information-and-dialogue", web: "web-navigation-and-execution",
  screen: "screen-understanding", verifier: "answer-verifier",
} as const;
export const LANGS = ["ko", "en", "zh", "ja"] as const;
export const LangSchema = z.enum(LANGS);
export type Lang = z.infer<typeof LangSchema>;
export const SEMANTIC_ACTIONS = [
  "review-before-output", "navigate", "fill", "read", "navigate-next", "navigate-prev", "explain-field",
  "review", "prepare-submit", "submit", "reject", "stop", "resume",
  "auth-handoff", "read-state", "agent-handoff", "rephrase", "set-language", "about-site",
  "goal", "open-browser", "discover", "find-place", "precheck", "prepare-apply", "chat",
  "web-answer", "open-site", "follow-link", "confirm-click", "back", "read-main",
  "list-links", "search", "consent", "describe-screen", "describe-picture", "welfare-retrieval", "edit-field",
  "clarify", "help", "help-list", "none",
] as const;
export const SemanticActionSchema = z.enum(SEMANTIC_ACTIONS);
export type SemanticAction = z.infer<typeof SemanticActionSchema>;

const text = z.string();
const natural = integer.nonnegative();
// 원본의 Literal[False]와 Literal[True]는 JSON 값 0과 1도 각각 정해진 불리언으로 정리한다.
const literalFalse = z.preprocess(value => value === 0 ? false : value, z.literal(false));
const literalTrue = z.preprocess(value => value === 1 ? true : value, z.literal(true));
export const SourceCitationSchema = z.object({
  title: text, url: UrlStringSchema, lastCheckedAt: text, version: optional(text), note: optional(text),
}).transform(omitAbsent);
export type SourceCitation = z.infer<typeof SourceCitationSchema>;
export const PolicyDecisionSchema = z.object({ allowed: z.boolean(), code: text, reason: text });
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export const ExecutedActionSchema = z.object({
  agent: text, action: ActionSchema, policy: PolicyDecisionSchema, result: optional(ActionResultSchema),
}).transform(omitAbsent);
export type ExecutedAction = z.infer<typeof ExecutedActionSchema>;
export const PENDING_CONFIRMATION_KINDS = [
  "field-entry", "click", "file-transfer", "visual-navigation", "practice-submission", "public-research", "vault-save", "vault-clear",
] as const;
export const PendingConfirmationSchema = z.object({
  actionId: text, kind: optional(z.enum(PENDING_CONFIRMATION_KINDS)), purpose: text, site: text, description: optional(text),
  values: z.array(z.object({ label: text, value: text })), realSubmission: literalFalse,
}).transform(omitAbsent);
export type PendingConfirmation = z.infer<typeof PendingConfirmationSchema>;
export const GroundedAnswerCardSchema = z.object({
  answer: text, serviceId: text, serviceName: text, fields: z.array(text), grounded: z.boolean(), source: SourceCitationSchema,
  dataKind: z.enum(["live", "stored", "private-program"]), dataOrigin: text, dataDate: optional(text), nextAction: text,
}).transform(omitAbsent);
export type GroundedAnswerCard = z.infer<typeof GroundedAnswerCardSchema>;
export const HumanAuthHandoffSchema = z.object({
  id: text, taskId: text, kind: z.enum(["login", "verification", "captcha"]),
  status: z.enum(["waiting", "completed", "cancelled", "expired", "interrupted", "blocked"]), site: text,
});
export type HumanAuthHandoff = z.infer<typeof HumanAuthHandoffSchema>;
/** 서버가 제안한 선택지 하나(core/choices.ts). 고를 때는 key와 이 응답의 turnId를 보낸다. */
export const OfferedChoiceSchema = z.object({ key: ChoiceKeySchema, label: text });
export type OfferedChoice = z.infer<typeof OfferedChoiceSchema>;
export const ObservationSummarySchema = z.object({
  page: text, url: text, title: text, step: optional(StepInfoSchema), fields: z.array(ObservedFieldSchema),
  errors: z.array(text), status: optional(text),
}).transform(omitAbsent);
export type ObservationSummary = z.infer<typeof ObservationSummarySchema>;
export const TraceEntrySchema = z.object({ phase: text, agent: text, atMs: integer, note: optional(text) }).transform(omitAbsent);
export type TraceEntry = z.infer<typeof TraceEntrySchema>;
export const AgentHandoffSchema = z.preprocess(value => {
  if (typeof value === "object" && value !== null && !("from" in value) && "from_" in value) {
    return { ...value, from: value.from_ };
  }
  return value;
}, z.object({
  from: z.literal(AGENT_IDS.welfare), to: z.literal(AGENT_IDS.web), taskId: text, goal: text,
  targetUrl: text, sources: z.array(SourceCitationSchema), requiresApprovedDomain: literalTrue,
  domainApproved: z.boolean(), officialUrl: optional(text),
}).transform(omitAbsent));
export type AgentHandoff = z.infer<typeof AgentHandoffSchema>;
export const VerificationSchema = z.object({
  requiredFieldsComplete: optional(z.boolean()), fieldValueMatches: optional(z.boolean()), receipt: optional(text),
}).transform(omitAbsent);
export type Verification = z.infer<typeof VerificationSchema>;
export const SpeechPrefsSchema = z.object({
  rate: z.number().default(1.25), length: z.enum(["short", "normal", "detailed"]).default("normal"),
  voice: optional(text), progressSpoken: z.boolean().default(true),
}).transform(omitAbsent);
export type SpeechPrefs = z.infer<typeof SpeechPrefsSchema>;
export const INTRO_POSES = ["welcome", "listening", "screen-reading", "confirmation", "auth-handoff", "stopped", "complete"] as const;
/** 청음 소개 한 줄: 말할 문장과 그동안 아바타가 할 동작(cheongeum-avatar.glb의 클립 이름). ask는 건너뛰어도 말할 줄(소개 끝의 연습 신청서 제안). */
export const IntroLineSchema = z.object({ text, pose: z.enum(INTRO_POSES), ask: optional(z.boolean()) }).transform(omitAbsent);
export type IntroLine = z.infer<typeof IntroLineSchema>;
export const TaskReviewSummarySchema = z.object({
  status: z.enum(["completed", "incomplete", "needs_input"]), difficulty: z.enum(["easy", "medium", "hard"]),
  rounds: natural, maxRounds: integer.min(1), browserIterations: natural,
});
export type TaskReviewSummary = z.infer<typeof TaskReviewSummarySchema>;
export const TurnResultSchema = z.object({
  sessionId: text, turnId: text, userUtterance: text, intentType: text, state: SessionStateSchema, stopGeneration: optional(natural),
  semanticAction: SemanticActionSchema, field: optional(text), value: optional(text), page: optional(text),
  speech: text, localSpeechOnly: optional(literalTrue), lang: LangSchema.default("ko"), trace: z.array(TraceEntrySchema),
  actions: z.array(ExecutedActionSchema), observation: optional(ObservationSummarySchema), verification: optional(VerificationSchema),
  review: optional(TaskReviewSummarySchema), pendingConfirmation: optional(PendingConfirmationSchema),
  authHandoff: optional(HumanAuthHandoffSchema), answerCard: optional(GroundedAnswerCardSchema), handoff: optional(AgentHandoffSchema),
  accessMode: optional(z.enum(["full", "read-only", "none"])), sources: z.array(SourceCitationSchema),
  missingFields: z.array(text), pendingActions: natural, realSubmission: literalFalse,
  flags: z.object({ secretDetected: z.boolean(), masked: z.boolean() }), latencyMs: natural, speechPrefs: optional(SpeechPrefsSchema),
  // 이 응답 뒤에 고를 수 있는 것(없으면 빠진다. 승인은 pendingConfirmation이 따로 맡는다)
  offeredChoices: optional(z.array(OfferedChoiceSchema)),
  // 화면에서 되묻는 공개 목록 이름(받아쓰기와 따로 둔다)
  publicSuggestions: optional(z.array(text).max(2)),
  // 청음 소개(첫 실행·'청음 소개 다시 해줘'): 줄마다 아바타 동작과 함께 차례로 말한다
  introScript: optional(z.array(IntroLineSchema)),
}).transform(omitAbsent);
export type TurnResult = z.infer<typeof TurnResultSchema>;
export function parseTurnResult(raw: unknown): TurnResult {
  return TurnResultSchema.parse(raw);
}

/** 목표 수행이 실제로 본 화면 하나. 주소의 쿼리와 입력값은 빼고 가린 글이며, 검토(task_review)의 증거가 된다. */
export interface ReviewPage {
  afterActionId: string;
  urlKey: string;
  url: string;
  title: string;
  headings: string[];
  selected: string[];
  text: string;
}

export type DraftAction = Omit<ExecutedAction, "result"> & {
  result?: ExecutedAction["result"] | { ok: false; errorCode: "LOG_FAILED"; latencyMs: 0 };
};
type DraftExtras = Partial<Pick<TurnResult,
  "field" | "value" | "verification" | "handoff" | "sources" | "missingFields" | "lang" | "review" | "answerCard" | "introScript" | "publicSuggestions"
>> & {
  actions?: DraftAction[];
  /** 실행 결과를 만든 곳에서만 표시하는 승인 낭독의 구분. */
  approvalSpeech?: "ask" | "switch" | "expired" | "changed" | "unverified";
  view?: Observation & { pageId: string };
  masked?: boolean;
  secretDetected?: boolean;
  summary?: string;
  historySpeech?: Redacted;
  /** 방금 안내한 링크 선택지를 이어서 고를 수 있는 응답 */
  offersLinks?: boolean;
  /** 기록에 남길 화면 사진 설명 말(사진 내용 대신) */
  pictureHistory?: string;
  /** 기록에 말 대신 가림 표시만 남기는 응답 */
  privateHistory?: boolean;
  /** 목표 수행이 브라우저를 움직인 횟수 */
  browserIterations?: number;
  reviewPages?: readonly ReviewPage[];
  reviewQuotes?: readonly string[];
  reviewQuoteSources?: Readonly<Record<string, readonly string[]>>;
  /** 공개 안내 조사가 사용자에게 되물을 말 */
  taskQuestion?: string;
  /** 사진에서만 보인 메뉴를 사용자가 연 뒤 같은 작업으로 돌아오는 세션 내부 표식. */
  navigationHandoff?: { readonly origin: string; readonly prompt: string; reviewedTask?: unknown };
  /** 공개 안내 조사에서 찾은 근거 글과 그 판정(completed·partial·incomplete·needs_input) */
  researchEvidence?: string;
  researchState?: string;
};
export type Draft = Pick<TurnResult, "state" | "semanticAction" | "speech"> & DraftExtras;
export function draft(state: SessionState, semanticAction: SemanticAction, speech: string, extra: DraftExtras = {}): Draft {
  return omitAbsent({ ...extra, state, semanticAction, speech });
}
