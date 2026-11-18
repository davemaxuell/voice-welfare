import { z } from "zod";
import {
  ActionSchema, ActionResultSchema, ObservedFieldSchema, StepInfoSchema, UrlStringSchema,
  type Observation,
} from "./actions.ts";
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
  "navigate", "fill", "read", "navigate-next", "navigate-prev", "explain-field",
  "review", "prepare-submit", "submit", "reject", "stop", "resume",
  "auth-handoff", "read-state", "agent-handoff", "rephrase", "set-language", "about-site",
  "goal", "open-browser", "discover", "precheck", "prepare-apply", "chat",
  "web-answer", "open-site", "follow-link", "confirm-click", "back", "read-main",
  "list-links", "search", "consent", "describe-screen", "welfare-retrieval", "edit-field",
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
export const PendingConfirmationSchema = z.object({
  actionId: text, purpose: text, site: text, values: z.array(z.object({ label: text, value: text })), realSubmission: literalFalse,
});
export type PendingConfirmation = z.infer<typeof PendingConfirmationSchema>;
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
export const TurnResultSchema = z.object({
  sessionId: text, turnId: text, userUtterance: text, intentType: text, state: SessionStateSchema,
  semanticAction: SemanticActionSchema, field: optional(text), value: optional(text), page: optional(text),
  speech: text, lang: LangSchema.default("ko"), trace: z.array(TraceEntrySchema), actions: z.array(ExecutedActionSchema),
  observation: optional(ObservationSummarySchema), verification: optional(VerificationSchema),
  pendingConfirmation: optional(PendingConfirmationSchema), handoff: optional(AgentHandoffSchema),
  accessMode: optional(z.enum(["full", "read-only", "none"])), sources: z.array(SourceCitationSchema),
  missingFields: z.array(text), pendingActions: natural, realSubmission: literalFalse,
  flags: z.object({ secretDetected: z.boolean(), masked: z.boolean() }), latencyMs: natural, speechPrefs: optional(SpeechPrefsSchema),
}).transform(omitAbsent);
export type TurnResult = z.infer<typeof TurnResultSchema>;
export function parseTurnResult(raw: unknown): TurnResult {
  return TurnResultSchema.parse(raw);
}

type DraftExtras = Partial<Pick<TurnResult, "field" | "value" | "actions" | "verification" | "handoff" | "sources" | "missingFields" | "lang">> & {
  view?: Observation & { pageId: string };
  masked?: boolean;
  secretDetected?: boolean;
  summary?: string;
};
export type Draft = Pick<TurnResult, "state" | "semanticAction" | "speech"> & DraftExtras;
export function draft(state: SessionState, semanticAction: SemanticAction, speech: string, extra: DraftExtras = {}): Draft {
  return omitAbsent({ ...extra, state, semanticAction, speech });
}
