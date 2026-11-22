// 세션 단위 AI Orchestrator(공통 백엔드). 의도를 해석해 Agent A(웹 탐색·실행)와
// Agent B(복지 정보·대화)에 일을 나누고, 공통 작업 상태(승인 대기, 되묻기, 중단)를 관리한다.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ExecContext, type WebExecutionAgent } from "../agents/web/agent.ts";
import { stillNeedsAuth } from "../agents/web/auth_page.ts";
import type { DownloadStore } from "../agents/web/downloads.ts";
import { linkReference } from "../agents/web/link_choices.ts";
import { fieldVocabulary, type FieldProfile } from "../agents/web/profile.ts";
import { BrowseSkill } from "../agents/web/skills/browse.ts";
import { browseState, isFormOpen } from "../agents/web/skills/common.ts";
import { FormSkill } from "../agents/web/skills/form.ts";
import { GuidedFill } from "../agents/web/skills/guided.ts";
import type { VisionModel } from "../agents/web/visual_step.ts";
import { speakAnswerCard, type WelfareInformationAgent } from "../agents/welfare/agent.ts";
import { PROFILE_ORDER, parseProfileAnswer, profileQuestion, type ProfileSlot, type UserProfile } from "../agents/welfare/discovery.ts";
import { OpenData, type PlaceFinder } from "../agents/welfare/open_data/index.ts";
import { raceAbort } from "../core/abort.ts";
import { CHOICE_TURNS, choiceLabel, type ChoiceKey } from "../core/choices.ts";
import { APPROVAL_TTL_S, DialogueState, type Approval } from "../core/dialogue.ts";
import type { EventSink } from "../core/events.ts";
import type { Intent } from "../core/intents.ts";
import { ackKind, agree, approval, authInputDone, cancelReply, doneReply, foreignApproval, permitsOfferedAction, wholeRejection } from "../core/lexicon.ts";
import { ModelTransportError, type Redacted, type StructuredLlm } from "../core/llm.ts";
import { TurnQueue } from "../core/mutex.ts";
import type { PlaceAsk } from "../core/places.ts";
import { backendActivity, backendTrace, Progress } from "../core/progress.ts";
import { omitAbsent } from "../core/schema.ts";
import { PUBLIC_AGENCIES } from "../core/sites.ts";
import { hasText, rstripChars, strip, stripChars } from "../core/text.ts";
import { AGENT_IDS, LANGS, draft, parseTurnResult, type Draft, type HumanAuthHandoff, type Lang, type SemanticAction, type SessionState,
  type SourceCitation, type TraceEntry, type TurnResult } from "../core/turn.ts";
import { tryUrl } from "../core/url.ts";
import { recheck } from "../agents/web/approval.ts";
import { approvalAction, approvalNarration, approvalPresentation, type ApprovalNotice, type ClickPresentation, FIXED, detectLangSwitch, detectScriptLang, parseForeignFieldFill, translateIn, translateOut } from "../language/i18n.ts";
import { ActionLog, localDay } from "../personal/action_log.ts";
import { dueReminder, foreignVaultSave, parsePersonalCommand } from "../personal/commands.ts";
import { PersonalDialogue, vaultReply } from "../personal/dialogue.ts";
import { GuardianDialogue, PreviewSender, guardianRequest, type GuardianSender } from "../personal/guardian.ts";
import { PersonalStore, VAULT_LABELS, type Vault } from "../personal/store.ts";
import { consentRefusal, gateRefusal, type Consent, type GateRefusal } from "../safety/gates.ts";
import { guardPatterns } from "../safety/guard.ts";
import type { PiiScanner } from "../safety/pii_model.ts";
import { REDACTED, detectSensitive, disclosureNotice, historyLine, maskValue, redactPictureText, redactText, redactTextWindow,
  type SecretSpan } from "../safety/privacy.ts";
import { josa, speakCallName, speakLabel } from "../speech/phrasing.ts";
import { Narrator } from "../speech/screen.ts";
import { isQuestionLike, stripAddress, stripFiller, vagueQuestion } from "../understanding/filters.ts";
import { RuleBasedIntentProvider, afterProgressQuestion, interactionLimit, isProgressQuestion, isStopUtterance, requestedControl, type IntentProvider } from "../understanding/rules.ts";
import { nearSiteGuess, requestedSiteName, serviceTopic, siteLabel } from "../understanding/sites.ts";
import { Understanding, type Understood } from "../understanding/understand.ts";
import { ApplicationCommands } from "./application.ts";
import { fullMatch, sessionPatterns } from "./patterns.ts";
import { boundedDialogue, PLANNER_EXCHANGES, utf8Prefix, type DialogueExchange } from "./planner_dialogue.ts";
import { FirstRunGuide } from "./first_run.ts";
import { spokenPlanNames } from "../agents/web/skills/known_plan.ts";
import { PublicPlanner, type QuietAnswer } from "./public_plan.ts";
import { PublicTask, publicDestinations, RESEARCH_UNDELIVERED, type PublicTurn } from "./public_task.ts";
import { SessionNeed } from "./session_need.ts";
import { SessionReplies } from "./replies.ts";
import { LIVE_DIFFICULTY, REVIEW_LIMITS, ReviewLoop, ReviewedTask, isDifficulty } from "./review_loop.ts";
import { VOCAB, interpretSpeech } from "./speech_repair.ts";
import { decisionReply } from "../understanding/decision_reply.ts";

export interface OrchestratorDeps {
  setAvatarVisible?: (visible: boolean, signal: AbortSignal) => Promise<boolean>;
  intentProvider: IntentProvider;
  web: WebExecutionAgent;
  welfare: WelfareInformationAgent;
  events?: EventSink;
  /** true면 시작 동의 전에는 화면을 읽거나 조작하지 않는다(서버 기본값). */
  requireConsent?: boolean;
  /** 의도 계획·자유 대화·쉬운 말 다시 설명(없으면 규칙 기반으로만 동작) */
  llm?: StructuredLlm;
  /** 목표 수행(browse_step). 없으면 llm. */
  goalLlm?: StructuredLlm;
  /** 검색 답·화면 요약. 없으면 llm. */
  webLlm?: StructuredLlm;
  fileLlm?: StructuredLlm;
  visionLlm?: VisionModel;
  recoveryLlm?: StructuredLlm;
  scanner?: PiiScanner;
  /** 웹 검색 주소 틀({q} 자리에 검색어). 기본 네이버. 테스트는 로컬 포털 검색을 쓴다. */
  searchUrlTemplate?: string;
  /** false면 실제 사이트 모드: 연습(모의) 사이트를 기본으로 쓰지 않는다("연습"이라고 할 때만). 기본 true. */
  practiceMode?: boolean;
  initialRegion?: string;
  initialLanguage?: Lang;
  initialService?: readonly [agency: string, topic: string];
  rememberService?: (agency: string, topic: string) => void;
  /** 첫 실행 설정을 이어 갈 단계(끝났으면 없음)와 진행을 적는 함수 */
  firstRunStep?: string;
  firstRunProgress?: (step: string) => void;
  recallNotes?: (text: string) => Promise<string[]>;
  delegateResearch?: (id: string, goal: string) => Promise<boolean>;
  readResearch?: (lang: Lang) => Promise<Draft | undefined>;
  /** 개인 정보 금고·신청 기록 저장소(없으면 이번 대화 메모리에만) */
  personal?: PersonalStore;
  routeDevice?: () => boolean;
  /** 암호화된 조작 기록(없으면 '오늘 한 일'은 비어 있다고 답함) */
  actionLog?: ActionLog;
  /** 보호자 문자 보내는 길. 주지 않으면 미리 보기만 하고, null이면 보내는 길이 없다. */
  guardianSender?: GuardianSender | null;
  downloads?: DownloadStore;
  sharedBrowser?: boolean;
  /** 승인을 물은 뒤 지난 시간을 재는 시계(초). 테스트가 세션을 만든 뒤 바꾸므로 부를 때마다 읽는다. */
  clock?: () => number;
  today?: () => string;
  places?: PlaceFinder;
  publicPlanning?: boolean;
  quietSearch?: (task: PublicTask, lang: Lang, signal: AbortSignal, requestedSteps?: readonly string[]) => Promise<QuietAnswer>;
  browsePublicSources?: (task: PublicTask, ctx: ExecContext, maxSteps?: number, requirements?: readonly string[]) => Promise<Draft | undefined>;
  /** 알려지지 않은 기관의 공식 누리집 후보를 공공 도메인 안에서 찾는다(없으면 목표 수행이 이 길을 쓰지 않는다). */
  findPortal?: (query: string, signal: AbortSignal) => Promise<readonly { url: string; title: string }[]>;
}
export type ModelRoles = Partial<Pick<OrchestratorDeps, "llm" | "goalLlm" | "webLlm" | "fileLlm" | "visionLlm" | "recoveryLlm">>;
export type Detection = ReturnType<typeof detectSensitive>;
export type View = NonNullable<Draft["view"]>;
type HistoryRow = { turnId: string; role: "user" | "assistant"; text: Redacted; at: string; state: SessionState; intentType?: string };
export interface Turn {
  id: string; text: Redacted; intentType: string; started: number; epoch: number; trace: TraceEntry[]; ctx: ExecContext;
  /** 외국어로 말했을 때의 (비식별) 원문. text는 한국어 번역. */
  original?: Redacted;
  fromVoice: boolean; linkQuestion: boolean; staleLinkOffer: boolean;
  plannerDialogue?: readonly DialogueExchange[];
  progressReply: string; researchState: string; researchEvidence: string;
  researchOutcome?: boolean;
  initialApprovalId?: string; initialApproval?: Approval; approvalNotice?: ApprovalNotice;
}
export interface TurnOptions {
  approvalId?: string;
  fromVoice?: boolean;
  linkOfferId?: string;
  difficulty?: string;
  plannerDialogue?: readonly DialogueExchange[];
  /** 받아쓴 글이 길 때 앞에서 이만큼(코드 포인트)만 받는다. 가리기는 전체 글을 보고 한다. */
  maxCodePoints?: number;
}
interface ProcessOptions { fromVoice?: boolean; staleLinkOffer?: boolean; proposalReply?: boolean; plannerDialogue?: readonly DialogueExchange[] | undefined }
interface Offer { turnId: string; keys: ChoiceKey[]; handoffId?: string; authKind?: string; url?: string; navigationHandoff?: Draft["navigationHandoff"] }
/** 공공업무 판단에 주는 지난 대화 한 줄. 기관을 모르면 agency는 null(모델에 가는 JSON 그대로). */
export type { PublicTurn } from "./public_task.ts";
export interface RecoveryCheckpoint {
  state: SessionState; lang: Lang; consent: Consent; stopGeneration?: number; approvalKind?: string; progressSeq: number; step?: number;
}
export type RecoveryResume = { interrupted: true } | (Record<string, unknown> & { state: SessionState; authHandoff: HumanAuthHandoff | null });

// 이 종류만 모인 여러 질문은 답에 번호를 붙여 읽는다.
export const QUESTION_TYPES: ReadonlySet<string> = new Set(["POLICY_QUESTION", "PRECHECK", "PREPARE_APPLY", "SERVICE_DETAIL",
  "ABOUT_SITE", "CURRENT_STEP", "DESCRIBE_SCREEN", "UNKNOWN"]);
// 이 상태가 되면 여러 명령 실행을 멈추고 사용자에게 묻는다.
export const PLAN_STOP_STATES: ReadonlySet<SessionState> = new Set(["NEEDS_CLARIFICATION", "VALIDATION_ERROR", "WAITING_FOR_USER_CONFIRMATION", "AUTH_HANDOFF", "STOPPED", "RECOVERING"]);
// 승인을 물은 뒤 이만큼 지나 받은 승인은 실행하지 않고 요약을 다시 읽어 묻는다(주인 결정 2026-11-18)
export { APPROVAL_TTL_S };
export const NO_SECRET: Detection = { kinds: [], hasSecretValue: false };
const READ_ONLY_QUESTIONS: ReadonlySet<string> = new Set(["UNKNOWN", "ABOUT_SITE", "CURRENT_STEP", "DESCRIBE_SCREEN", "READ_MAIN"]);
const NAVIGATION: ReadonlySet<string> = new Set(["OPEN_SITE", "OPEN_OFFICIAL", "FOLLOW_LINK", "NEXT", "PREV", "GOAL", "SEARCH"]);
const SPEECH_REPAIR_STATES: ReadonlySet<SessionState> = new Set(["IDLE", "BROWSING", "NEEDS_CLARIFICATION"]);
const START_GUIDE = "청음은 요청하신 웹사이트를 열고, 화면과 신청 절차를 읽고, 말씀하신 항목을 누르거나 칸에 입력해 드립니다. " +
  "음성과 읽어 드릴 문장은 설정한 음성 API에 전달하고, 질문과 화면 글은 설정한 AI로 보낼 수 있어요. " +
  "화면 설명은 먼저 글로 확인해요. 그림을 봐야 답할 수 있으면 입력란을 가린 페이지 사진도 OpenAI에 보내요. 글로만 들으려면 '사진 없이 화면 설명해줘'라고 하세요. " +
  "비밀번호와 본인 인증은 사이트에서 직접 입력해 주세요. 비밀번호나 주민등록번호는 소리 내어 말하지 마세요. " +
  "언제든 '멈춰'라고 말씀해 주세요.";

const SiteGuessSchema = z.object({
  text: z.string().optional(), label: z.string().optional(), heard: z.boolean().optional(), prompt: z.string().optional(),
  options: z.array(z.object({ text: z.string(), label: z.string() })).optional(),
});

/** Python dataclasses.replace(ctx, ...): 승인·중단 신호는 그대로 두고 조작 한도와 조회 전용 표시만 바꾼 새 문맥 */
export function withContext(ctx: ExecContext, changes: Partial<Pick<ExecContext, "counter" | "publicLookup" | "actionLimit" | "browsingScope" | "signal">>): ExecContext {
  return new ExecContext({ ...ctx, ...changes });
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function replaceValues(text: string, values: readonly string[]): string {
  for (const value of values) text = text.replaceAll(value, REDACTED);
  return text;
}

export const byLengthDesc = (a: string, b: string) => Array.from(b).length - Array.from(a).length;

function asProfileSlot(slot: string): ProfileSlot {
  const found = PROFILE_ORDER.find(known => known === slot);
  if (found === undefined) throw new RangeError(`모르는 맞춤 질문: ${slot}`);
  return found;
}

export class SessionOrchestrator {
  readonly id = randomUUID();
  readonly deps: OrchestratorDeps;
  readonly dialogue: DialogueState<FieldProfile>;
  readonly progress = new Progress();
  readonly narrator: Narrator;
  readonly form: FormSkill;
  readonly browse: BrowseSkill;
  readonly guided: GuidedFill;
  readonly personal: PersonalStore;
  readonly guardian: GuardianDialogue;
  readonly personalDialogue: PersonalDialogue;
  readonly firstRun: FirstRunGuide;
  readonly rules: RuleBasedIntentProvider;
  readonly understanding: Understanding;
  readonly replies: SessionReplies;
  readonly application: ApplicationCommands;
  readonly planner: PublicPlanner;
  readonly review: ReviewLoop;
  /** 맞춤 복지 찾기: 이번 대화에서만 쓰는 사용자 정보 */
  profile: UserProfile;
  /** 직전에 Agent B가 근거를 찾아 답한 서비스. 다음 신청 요청 때 Agent A로 인계한다. */
  grounded?: { servNm: string; sources: SourceCitation[] };
  /** 직전 응답의 종류(되묻기를 연달아 하지 않으려고) */
  lastSemantic?: SemanticAction;
  /** 대화 언어. 한국어가 아니면 번역 계층을 거친다(i18n.ts). */
  lang: Lang;
  /** 지금 이야기하는 공공기관과 업무. 이어 묻는 말("필요한 서류는?")이 여기에 붙는다. */
  activeService?: readonly [agency: string, topic: string];
  publicTask = new PublicTask();
  readonly need = new SessionNeed();
  readonly #suppliedOrigins = new Set<string>();
  /** 검토하던 일이 사용자 대답을 기다리는 자리(되물음·본인인증·지역 물음) */
  reviewQuestion?: readonly [PublicTask, ReviewedTask];
  inspectedScreen?: {task: PublicTask; confirmedPageKey: string};
  authReview?: readonly [handoffId: string, ReviewedTask];
  placeReview?: readonly [PlaceAsk, ReviewedTask];
  /** 공공업무 판단에 주는 최근 대화(네 턴까지) */
  readonly publicTurns: PublicTurn[] = [];
  #consent: Consent;
  #history: HistoryRow[] = [];
  #plannerTurns: { id: string; exchange: DialogueExchange; localize: boolean }[] = [];
  #plannerDialogueGeneration = 0;

  #queue = new TurnQueue();
  #clickPresentations = new WeakMap<object, ClickPresentation>();
  #controller = new AbortController();
  #approvals = new Set<string>();
  #busy = false;
  readonly #researchReceipts = new Map<string, Pick<TurnResult, "turnId" | "lang" | "speech">>();
  #pendingResearch?: {turnId: string; lang: Lang};
  // 마지막 응답이 제안한 선택지. 다음 응답·멈춤·종료 때 바뀐다.
  #offer?: Offer;
  #nextModels: ModelRoles = {};
  #nextPreferences: { language?: Lang; region?: string } = {};
  // 직전 말에서 비밀번호·인증번호를 값 없이 언급함 / 비밀값일 수 있어 막은 말의 해시(같은 말을 다시 하면 통과)
  #secretHint = false;
  #secretGuarded?: string;
  #noPlaces?: PlaceFinder;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    const clock = () => this.clock();
    deps.web.clock = () => clock() * 1000;
    this.#consent = deps.requireConsent === true ? "pending" : "granted";
    this.dialogue = new DialogueState(this.#consent === "pending" ? "AWAITING_CONSENT" : "IDLE", clock);
    this.narrator = new Narrator(deps);
    this.form = new FormSkill(deps.web, this.dialogue, this.narrator);
    const region = () => ({ ctpv: this.profile.ctpv, sgg: this.profile.sgg });
    this.browse = new BrowseSkill({
      web: deps.web, dialogue: this.dialogue, narrator: this.narrator, form: this.form, deps, progress: this.progress,
      replyLanguage: () => this.lang,
      routeStore: () => deps.personal?.canRememberRoutes === true && deps.routeDevice?.() === true ? deps.personal : undefined,
      routePrivateValues: () => this.privateValuesForRedaction(),
      officialText: url => deps.welfare.readableService(url),
      applicationGuideUrl: name => deps.welfare.applicationGuideUrl(name, region()),
      resolveGuideTarget: (question, { subject, siteUrl } = {}) => deps.welfare.resolveGuideTarget(question, { subject, siteUrl, ...region() }),
      resolveSiteLink: target => deps.welfare.resolveSiteLink(target, region()),
      planningContext: (goal, siteUrl) => this.planner.planningContext(goal, siteUrl),
    });
    this.activeService = deps.initialService;
    this.profile = deps.initialRegion !== undefined && deps.initialRegion.length > 0 ? { ctpv: deps.initialRegion } : {};
    this.personal = deps.personal ?? new PersonalStore();
    this.guardian = new GuardianDialogue(this.personal, this.dialogue, deps.guardianSender === undefined ? new PreviewSender() : deps.guardianSender ?? undefined);
    this.personalDialogue = new PersonalDialogue(this.personal, this.dialogue, prefs => { this.progress.spoken = prefs.progressSpoken; }, deps.actionLog);
    this.progress.spoken = this.personal.speech().progressSpoken;
    this.lang = deps.initialLanguage ?? "ko";
    const vocabulary = fieldVocabulary(deps.web.profile);
    this.rules = new RuleBasedIntentProvider(vocabulary);
    this.firstRun = new FirstRunGuide(this.dialogue, {
      step: deps.firstRunStep, progress: deps.firstRunProgress, lang: () => this.lang, callName: () => this.callName,
      remember: name => this.rememberCallName(name),
      isCommand: text => detectLangSwitch(text) !== undefined || this.rules.parseSync(text, { state: this.state }).type !== "UNKNOWN",
    });
    this.understanding = new Understanding(this.rules, deps, vocabulary);
    this.guided = new GuidedFill(deps.web, this.dialogue, this.narrator, this.rules, {
      savedValue: label => this.personalDialogue.savedFor(label),
      siteAllowed: origin => this.personal.siteAllowed(origin), allowSite: origin => this.personal.allowSite(origin),
    });
    this.browse.guidedResume = (view, ctx) => this.guided.resumeAfterAuth(view, ctx);
    this.replies = new SessionReplies(this);
    this.application = new ApplicationCommands(this);
    this.planner = new PublicPlanner(this);
    this.review = new ReviewLoop(this);
  }

  get generation() { return this.#queue.epoch; }
  get consentStatus() { return this.#consent; }
  get web() { return this.deps.web; }
  get state() { return this.dialogue.state; }
  get today() { return this.deps.today?.() ?? localDay(); }
  /** 청음이 부르는 이름: 개인 PC면 금고, 아니면 이번 대화(세션 메모리 금고)에만 있다. */
  get callName() { return this.personal.callName(); }
  get linkOfferId() { return this.browse.linkChoices?.offerId ?? ""; }
  get places(): PlaceFinder { return this.deps.places ?? (this.#noPlaces ??= OpenData.empty().places); }
  clock() { return this.deps.clock?.() ?? performance.now() / 1000; }

  // ---------------------------------------------------------------- 공개 API

  /**
   * 시작 동의(화면 읽기·브라우저 조작·음성 외부 전송 안내에 대한 사용자 승인).
   * 동의 전에는 받아쓰기도 하지 않도록 클라이언트는 키보드/버튼으로만 동의를 받는다.
   */
  async consentTo(granted: boolean): Promise<TurnResult> {
    return this.#enqueue(async () => {
      const turn = this.beginTurn(redactText(granted ? "[동의함]" : "[동의하지 않음]"));
      turn.intentType = "CONSENT";
      const d = this.dialogue;
      if (d.authWaiting && granted) return this.finish(turn, this.browse.authWait());
      this.#consent = granted ? "granted" : "declined";
      if (d.approval?.kind === "file") d.clearApproval();
      if (!granted) {
        this.#pendingResearch = undefined;
        this.#researchReceipts.clear();
        this.need.clear();
        this.publicTask = new PublicTask();
        this.inspectedScreen = undefined;
        this.reviewQuestion = this.authReview = this.placeReview = undefined;
        d.finishAuth("cancelled");
        d.takeVaultConfirm();
        d.clearApproval();
        return this.finish(turn, draft("IDLE", "consent", "알겠어요. 화면은 읽거나 조작하지 않고, 복지 제도 질문에만 답할게요."));
      }
      if (this.web.currentView === undefined) await this.prepare();
      // 신청 기록에 기한이 가까운 것이 있으면 시작할 때 알린다
      const due = this.reminders();
      const name = this.callName;
      const hello = name !== undefined && name.length > 0 ? `${speakCallName(name)}, 반가워요.` : "동의해 주셔서 감사합니다.";
      // 첫 실행이면 시작 인사 뒤에 음성 단계(마이크 확인부터, 또는 끊긴 단계)를 묻는다
      const setup = this.firstRun.begin();
      const tail = setup !== undefined && setup.length > 0 ? ` ${setup}` : due === undefined ? "" : ` 알려 드릴 게 있어요. ${due}`;
      return this.finish(turn, draft("IDLE", "consent", `${hello} 시작할게요.${tail}`));
    });
  }

  /** 부르는 이름을 기억한다. 이 PC에 저장했으면 true, 공용 PC라 이번 대화에서만 기억하면 false. */
  rememberCallName(name: string): boolean {
    this.personal.setCallName(name);
    this.redactEarlierMentions([name]);
    return this.deps.personal !== undefined;
  }

  changedLinkReply(): Draft {
    const choices = this.browse.linkChoices;
    if (choices !== undefined) choices.proposed = undefined;
    return draft(this.state, "follow-link", "링크 선택지가 바뀌었어요. 현재 화면에서 원하는 번호나 이름을 다시 말씀해 주세요.",
      { offersLinks: choices !== undefined && choices.offerId.length > 0 && choices.options.length > 0 });
  }

  /** 발화를 정규화하고 비밀값과 대기 중인 결정을 로컬에서 확인한 뒤 처리한다. */
  async handleTurn(raw: string, options: TurnOptions | number = {}): Promise<TurnResult> {
    const { approvalId, fromVoice = false, linkOfferId, difficulty, maxCodePoints, plannerDialogue }: TurnOptions = typeof options === "number" ? { maxCodePoints: options } : options;
    // 받아쓰기·입력이 자모 분리형(NFD)으로 올 수 있어 민감정보 판정·규칙 비교 전에 맞춘다
    const normalize = (s: string) => strip(s.normalize("NFC")).replace(sessionPatterns.spaces, " ");
    const normalized = normalize(raw);
    const prefix = maxCodePoints === undefined ? raw : Array.from(raw).slice(0, maxCodePoints).join("");
    const limit = prefix === raw ? undefined : Array.from(normalize(prefix)).length;
    const safeText = (spans: readonly SecretSpan[] = []) => limit === undefined
      ? redactText(normalized, spans) : redactTextWindow(normalized, 0, limit, spans);
    const text = safeText();
    if (isStopUtterance(text)) return this.#stop(text);
    const called = stripAddress(text);
    if (called.length === 0) return this.#enqueue(async () => this.fixedReply(text, "네, 말씀하세요.", "ko"));
    if (isProgressQuestion(called)) return this.#progressReply(redactText(called));
    const d = this.dialogue;
    const askedVault = d.vaultConfirm, askedAction = d.approval, askedHandoff = d.authHandoff, askedTask = this.publicTask;
    const dialogueGeneration = this.#plannerDialogueGeneration;
    const offered = linkOfferId ?? this.linkOfferId;
    const proposedLinks = this.browse.linkChoices;
    const navigation = this.#offer?.navigationHandoff;
    const presented = approvalId ?? (fromVoice ? "" : d.confirmation?.actionId ?? "");

    const work = async (): Promise<TurnResult> => {
      backendActivity("planning");
      const epoch = this.#queue.epoch;
      // 로컬 개인정보 모델은 비동기라 차례가 온 뒤에 본다. 그 사이 멈췄으면 실행하지 않는다.
      const spans = (await this.deps.scanner?.scan([normalized]))?.[0];
      if (epoch !== this.#queue.epoch) return this.voided();
      const spoken = redactText(stripAddress(safeText(spans)));
      const sensitive = detectSensitive(normalized, spans);
      if (!sensitive.hasSecretValue && navigation !== undefined) {
        const spokenLabel = stripChars(spoken, " .!?。！？").replace(/\s+/gu, "").toLowerCase();
        if (LANGS.some(lang => choiceLabel("resume-navigation", lang).replace(/\s+/gu, "").toLowerCase() === spokenLabel)) {
          if (navigation !== this.#offer?.navigationHandoff) return this.fixedReply(redactText("[계속하기]"), "안내하던 작업이 바뀌었어요. 지금 하려는 일을 알려 주세요.", "ko");
          return this.process(spoken, sensitive, {type: "RESUME"}, {fromVoice});
        }
      }
      const staleLinkOffer = offered !== this.linkOfferId;
      if (staleLinkOffer && !d.hasPendingInteraction && this.publicTask.question.length === 0 &&
          (linkReference(spoken, this.browse.linkChoices) !== undefined || agree(spoken) !== undefined)) {
        return this.localize(this.finish(this.beginTurn(redactText("[링크 확인]")), this.changedLinkReply()));
      }
      const confirm = redactText("[확인]");
      if (this.publicTask !== askedTask && this.publicTask.question.length > 0 && agree(spoken) !== undefined) {
        return this.fixedReply(confirm, this.publicTask.question, this.lang);
      }
      if (d.authHandoff !== askedHandoff && d.authWaiting) {
        return this.fixedReply(confirm, "직접 확인할 작업이 바뀌었어요. 새 안내를 확인해 주세요.", "ko");
      }
      const currentId = d.confirmation?.actionId ?? "";
      const current = d.vaultConfirm;
      if (current?.confirmation !== undefined) {
        const decision = vaultReply(spoken, current.kind, this.lang);
        if (decision !== undefined) {
          if (current !== askedVault || presented !== currentId) return this.fixedReply(confirm, FIXED.changedApproval[this.lang], this.lang);
          return this.process(spoken, sensitive, { type: decision ? "APPROVE" : "REJECT" }, { fromVoice });
        }
      } else if (d.approval !== askedAction || presented !== currentId) {
        const parsed = this.rules.parseSync(spoken, { state: "WAITING_FOR_USER_CONFIRMATION" });
        if (parsed.type === "APPROVE" || parsed.type === "REJECT" || foreignApproval(spoken, this.lang) !== undefined) {
          return this.fixedReply(confirm, FIXED.changedApproval[this.lang], this.lang);
        }
      }
      if (current !== askedVault && current?.kind.startsWith("guardian-") === true &&
          (approval(spoken) === "approve" || foreignApproval(spoken, this.lang) === "approve")) {
        return this.fixedReply(confirm, "방금 읽어 드린 보호자 요청을 확인한 뒤 다시 말씀해 주세요.", "ko");
      }
      const hint = this.#secretHint;
      this.#secretHint = !sensitive.hasSecretValue && sensitive.kinds.some(k => k === "password" || k === "otp");
      if (!sensitive.hasSecretValue && !d.authWaiting && this.#maybeSpokenSecret(spoken, hint)) {
        const turn = this.beginTurn(redactText(REDACTED));
        turn.intentType = "SECRET_DISCLOSURE";
        return this.finish(turn, this.#possibleSecret());
      }
      // 제안 없이 맞장구만 한 경우는 명령이 아니다. 사이트의 글이나 버튼 이름을 이 판정에 보내지 않는다.
      const boundClick = askedAction?.kind === "click" && presented === askedAction.confirmation.actionId;
      const boundLink = offered.length > 0 && proposedLinks?.proposed !== undefined && askedAction === undefined && !d.hasPendingInteraction;
      if ((boundClick || boundLink) && !d.authWaiting && this.state !== "AUTH_HANDOFF" && this.state !== "STOPPED" &&
          this.#consent === "granted" && !hint && !sensitive.hasSecretValue && sensitive.kinds.length === 0 &&
          guardianRequest(spoken, this.web.guard.directActions) === undefined && foreignVaultSave(spoken) === undefined &&
          parsePersonalCommand(spoken, this.today)?.kind.startsWith("vault-") !== true) {
        const parsed = this.rules.parseSync(spoken, { state: this.state });
        const linked = boundLink ? linkReference(spoken, proposedLinks) : undefined;
        const recognized = boundClick && (approval(spoken, this.lang) === "approve" || wholeRejection(spoken, this.lang));
        const generalReply = (parsed.type === "UNKNOWN" || parsed.type === "APPROVE" || parsed.type === "REJECT") && linked === undefined;
        if (!recognized && (generalReply || permitsOfferedAction(spoken))) {
          const reply = await decisionReply(spoken, this.lang, this.deps.webLlm ?? this.deps.llm, this.#controller.signal);
          if (this.#queue.epoch !== epoch) return this.voided();
          if (reply !== undefined && boundClick) {
            if (askedAction !== d.approval || presented !== d.confirmation?.actionId) return this.fixedReply(confirm, FIXED.changedApproval[this.lang], this.lang);
            return this.process(spoken, sensitive, {type: reply === "approve" ? "APPROVE" : "REJECT"}, {fromVoice, proposalReply: true});
          }
          if (reply !== undefined && boundLink) {
            const turn = this.beginTurn(spoken);
            turn.fromVoice = fromVoice;
            if (proposedLinks !== this.browse.linkChoices || offered !== this.linkOfferId) return this.localize(this.finish(turn, this.changedLinkReply()));
            const before = this.web.currentView;
            return this.localize(await this.planner.command(turn, "FOLLOW_LINK", async () => {
              const result = await this.browse.chooseLink({action: reply === "approve" ? "open" : "decline", index: proposedLinks.proposed, matchDescription: false},
                spoken, turn.ctx, {redact: value => this.historySpeech(value)});
              return this.browse.recognizeAuthPage(result, before, turn.ctx);
            }));
          }
        }
      }
      if ((d.firstRun !== undefined && d.firstRun.length > 0) || (this.#consent === "granted" && this.state === "IDLE" &&
          !d.hasPendingInteraction && this.firstRun.wantsNameChange(spoken))) {
        const guided = await this.#firstRunTurn(spoken, sensitive, fromVoice);
        if (guided !== undefined) return guided;
      }
      const preceding = plannerDialogue !== undefined && dialogueGeneration !== this.#plannerDialogueGeneration ? [] : plannerDialogue;
      return this.process(spoken, sensitive, undefined, { fromVoice, staleLinkOffer, plannerDialogue: preceding });
    };

    // 요청마다 격리한다. 기다리는 다음 발화나 동시에 온 중단 요청에 난이도가 섞이지 않는다.
    return LIVE_DIFFICULTY.run(fromVoice && isDifficulty(difficulty) ? difficulty : undefined, () => this.#enqueue(work));
  }

  /** 첫 실행 3단계의 대답. 다른 명령이면 undefined(평소처럼 처리). */
  async #firstRunTurn(spoken: Redacted, sensitive: Detection, fromVoice: boolean): Promise<TurnResult | undefined> {
    const asked = this.dialogue.firstRun;
    const reply = this.firstRun.answer(spoken);
    if (reply === undefined) return undefined;
    // 연습 사이트는 장애인연금 모의 신청서다(연습이라고 말한 것과 같은 길)
    if (reply === "practice") return this.process(redactText("장애인연금 연습 신청서 열어줘"), sensitive, { type: "START_APPLICATION" }, { fromVoice });
    // 이름을 말한 차례는 기록에 남기지 않는다(LLM에 가는 최근 대화에 들어가므로)
    const nameReply = asked === "name" || asked === "name-confirm" || asked === "rename" || reply.privateHistory === true;
    const turn = this.beginTurn(nameReply ? redactText(REDACTED) : spoken);
    turn.intentType = "FIRST_RUN";
    return this.finish(turn, { ...reply, lang: this.lang });
  }

  /** UI의 언어 선택. 음성 "영어로 말해줘"와 같은 경로. */
  setLanguage(lang: Lang) { return this.#enqueue(async () => this.#switchLanguage(redactText("[언어 선택]"), lang)); }

  /** 버튼과 음성은 같은 승인 문을 사용한다. */
  confirm(approve: boolean, actionId?: string): Promise<TurnResult> {
    const asked = this.dialogue.confirmation;
    return this.#enqueue(async () => {
      const pending = this.dialogue.confirmation;
      if (pending !== asked || (actionId !== undefined && (pending?.actionId ?? "") !== actionId)) {
        return this.fixedReply(redactText("[확인 버튼]"), FIXED.changedApproval[this.lang], this.lang);
      }
      return this.process(redactText(approve ? "[승인 버튼]" : "[거절 버튼]"), NO_SECRET, { type: approve ? "APPROVE" : "REJECT" });
    });
  }

  /**
   * 제안한 선택지 고르기(아바타·대화 창 버튼). 그 제안을 낸 응답·인계 번호·화면이 지금도 같을 때만
   * 말로 한 것과 같은 길로 실행한다. 확인과 실행은 같은 대기열 차례 안에서. 지난 제안이면 undefined(아무것도 하지 않음).
   */
  choose(turnId: string, key: string, handoffId?: string | null): Promise<TurnResult | undefined> {
    return this.#enqueue(async () => {
      const offer = this.#offer;
      const chosen = offer?.keys.find(k => k === key);
      if (offer === undefined || chosen === undefined || offer.turnId !== turnId || offer.handoffId !== (handoffId ?? undefined)) return undefined;
      const handoff = this.dialogue.authHandoff;
      if (handoffId != null && handoffId.length > 0 && !(this.dialogue.authWaiting && handoff?.id === handoffId)) return undefined;
      if (offer.url !== undefined && offer.url.length > 0) {
        const check = this.beginTurn(redactText("[선택지 화면 확인]"));
        const view = await this.web.observe(check.ctx).catch(() => undefined);
        if (view?.url !== offer.url) return undefined;
      }
      if (chosen !== "resume-navigation") this.#offer = undefined;
      const { text, intent } = CHOICE_TURNS[chosen];
      return this.process(redactText(text ?? choiceLabel(chosen, "ko", offer.authKind)), NO_SECRET, { ...intent });
    });
  }

  async #resumeNavigation(handoff: NonNullable<Draft["navigationHandoff"]>, turn: Turn): Promise<Draft> {
    this.#offer = undefined;
    const refused = this.gate(["GOAL"]);
    if (refused !== undefined) return refused;
    const result = await this.browse.resumeNavigation(handoff, turn.ctx);
    const reviewed = handoff.reviewedTask;
    return reviewed instanceof ReviewedTask ? this.review.run(reviewed, turn, result) : result;
  }

  /** 이 응답 뒤에 버튼으로 고를 수 있는 것. 승인을 기다리면 승인 카드가 맡으므로 내지 않는다. */
  #offerFor(turn: Turn, state: SessionState, out: Draft, view: View | undefined): Offer | undefined {
    if (this.dialogue.approval !== undefined || state === "STOPPED") return undefined;
    const handoff = this.dialogue.authHandoff;
    if (this.dialogue.authWaiting && handoff !== undefined) {
      return { turnId: turn.id, keys: ["auth-done", "auth-cancel"], handoffId: handoff.id, authKind: handoff.kind };
    }
    if (out.navigationHandoff !== undefined) return {turnId: turn.id, keys: ["resume-navigation"], navigationHandoff: out.navigationHandoff};
    if (state === "BROWSING" && (out.semanticAction === "open-site" || out.semanticAction === "follow-link" || out.semanticAction === "back") &&
        view !== undefined && view.url.length > 0) {
      return { turnId: turn.id, keys: ["read-main"], url: view.url };
    }
    return undefined;
  }

  cancel(): TurnResult { return this.#stop(redactText("[멈춤 버튼]")); }

  /** 그 멈춤 뒤에만 새 입력을 받는다. 취소한 일을 다시 하지 않는다. */
  wake(stopGeneration: number): Promise<SessionState | undefined> {
    return this.#queue.enqueue<SessionState | undefined>(async () => {
      if (this.#queue.epoch !== stopGeneration) return undefined;
      if (this.state === "STOPPED") this.dialogue.commit("IDLE");
      return this.state;
    }, () => undefined);
  }

  /** 세션 시작 직후 한 번: 브라우저 창에 모의 사이트 첫 화면을 띄운다. 실패해도 세션은 쓸 수 있다. */
  async prepare() {
    // 실제 사이트 모드는 미리 아무 창도 띄우지 않는다(사용자가 말한 사이트를 그때 연다)
    if (this.deps.practiceMode === false) return;
    try { await this.web.openHome(this.beginTurn(redactText("[세션 준비]")).ctx); }
    catch { /* 첫 화면을 못 열어도 대화를 시작할 수 있다. */ }
  }

  #approvalPresentation() {
    const waiting = this.dialogue.approval ?? this.dialogue.vaultConfirm;
    const page = waiting?.kind === "click" ? this.#clickPresentations.get(waiting.action) : undefined;
    return approvalPresentation(waiting, this.lang, this.personal.persistent, page);
  }

  snapshot() {
    const guard = this.web.guard.config;
    const offer = this.#offer;
    return omitAbsent({
      sessionId: this.id, state: this.state, stopGeneration: this.state === "STOPPED" ? this.#queue.epoch : undefined,
      platform: "pc" as const, observation: this.summarize(this.web.currentView),
      pendingConfirmation: this.#approvalPresentation()?.card ?? this.dialogue.confirmation, awaitingField: this.dialogue.awaiting, history: this.exportHistory(),
      authHandoff: this.dialogue.authWaiting && this.dialogue.authHandoff !== undefined ? this.dialogue.authHandoff.public() : undefined,
      ...(offer === undefined ? {} : {
        turnId: offer.turnId,
        offeredChoices: offer.keys.map(key => ({ key, label: choiceLabel(key, this.lang, offer.authKind) })),
      }),
      mockOnly: guard.readOnlyWeb !== true && guard.allowedOrigins.every(origin => origin === this.web.profile.origin),
      speechPrefs: this.personal.speech(),
    });
  }

  exportHistory(): HistoryRow[] { return this.#history.map(row => ({ ...row })); }

  researchReceipts() {
    for (const item of this.#researchReceipts.values()) {
      if (!this.speakable(item.speech) || detectSensitive(item.speech).kinds.length > 0) item.speech = RESEARCH_UNDELIVERED[item.lang];
    }
    return {working: this.#busy, outcomes: Array.from(this.#researchReceipts.values())};
  }

  startResearchDelivery(turnId: string) { this.#pendingResearch = {turnId, lang: this.lang}; }
  acknowledgeResearch(turnId: string) { this.#researchReceipts.delete(turnId); }

  /** 실시간 음성의 시작 문맥. 길이를 묶고 보내기 전에 한 번 더 가린다. */
  recentVoiceDialogue(): { role: "user" | "assistant"; text: string }[] {
    const history: { role: "user" | "assistant"; text: string }[] = [];
    // 시작 문맥에 메시지 틀이 들어갈 자리를 남긴다.
    let remaining = 6400;
    for (const message of this.#history.slice(-64).reverse()) {
      const text = this.#dialogueText(message.text);
      if (text.length === 0) continue;
      const excerpt = utf8Prefix(text, 800);
      const bytes = Buffer.byteLength(excerpt);
      if (bytes > remaining) break;
      history.push({ role: message.role, text: excerpt });
      remaining -= bytes;
    }
    return history.reverse();
  }

  get plannerTurns(): readonly { readonly id: string; readonly exchange: DialogueExchange }[] {
    return this.#plannerTurns.map(({id, exchange}) => ({id, exchange}));
  }

  get plannerDialogueGeneration(): number { return this.#plannerDialogueGeneration; }

  #clearPlannerDialogue(): void {
    this.#plannerTurns = [];
    this.publicTurns.length = 0;
    this.#plannerDialogueGeneration++;
  }

  #dialogueText(text: string): string {
    return strip(redactPictureText(this.modelSpeech(text)));
  }

  plannerDialogue(live: readonly DialogueExchange[] = [], preceding?: readonly DialogueExchange[]): DialogueExchange[] {
    if (this.#consent !== "granted" || this.dialogue.authWaiting || this.state === "STOPPED") return [];
    const prior = preceding ?? this.#plannerTurns.map(turn => turn.exchange);
    return boundedDialogue([...prior, ...live], (text, role) => {
      const command = role === "user" ? parsePersonalCommand(text, this.today)?.kind : undefined;
      if (detectSensitive(text).hasSecretValue || text === REDACTED || foreignVaultSave(text) || guardianRequest(text, this.web.guard.directActions) ||
          (command !== undefined && (command.startsWith("vault-") || command.startsWith("app-") || command === "action-log-read"))) return "";
      return this.#dialogueText(text);
    });
  }

  /** 기한이 3일 이내인 신청 알림(없으면 undefined). 시작할 때와 주기적으로 쓴다. */
  reminders() { return dueReminder(this.personal.applications(), this.today); }

  /** 저장해 둔 조사 한 건을 한다. 격리된 새 작업 세션에서만 부른다. */
  researchPublic(...args: Parameters<PublicPlanner["research"]>) {
    const work = () => this.#trackBackend(() => this.planner.research(...args));
    return this.web.adapter.withTask?.(work) ?? work();
  }

  /** 받아쓴 말이 비었을 때 다시 말해 달라는 안내 */
  missedSpeechHint(): string {
    if (this.lang !== "ko") return FIXED.retry[this.lang];
    if (this.activeService !== undefined) {
      const [agency, topic] = this.activeService;
      return `소리가 잘 들리지 않았어요. ${topic.length > 0 ? topic : agency}에서 궁금한 점을 짧게 말씀해 주세요.`;
    }
    return "소리가 잘 들리지 않았어요. 어떤 일로 도움이 필요하신지 한 번 더 말씀해 주세요.";
  }

  /** 현재 작업은 멈추고, 재접속에는 값 없는 단계만 남긴다. */
  detachForRecovery(): RecoveryCheckpoint {
    const approvalKind = this.dialogue.confirmation?.kind;
    const state = this.state;
    const view = this.web.currentView;
    if (this.#pendingResearch !== undefined) {
      const {turnId, lang} = this.#pendingResearch;
      this.#researchReceipts.set(turnId, {turnId, lang, speech: RESEARCH_UNDELIVERED[lang]});
      this.#pendingResearch = undefined;
    }
    this.#interrupt();
    this.progress.close();
    this.web.forgetNative();
    this.#approvals.clear();
    this.#offer = undefined;
    this.dialogue.stop({ preserveAuth: true });
    this.browse.linkChoices = undefined;
    this.guardian.takePending();
    this.#history = [];
    this.need.clear();
    this.activeService = undefined;
    this.publicTask = new PublicTask();
    this.inspectedScreen = undefined;
    this.reviewQuestion = this.authReview = this.placeReview = undefined;
    this.profile = {};
    this.grounded = undefined;
    this.#secretHint = false;
    this.#secretGuarded = undefined;
    if (state === "WAITING_FOR_USER_CONFIRMATION") this.dialogue.commit(view === undefined ? "IDLE" : browseState(view));
    return omitAbsent({
      state: this.state, lang: this.lang, consent: this.consentStatus,
      stopGeneration: this.state === "STOPPED" ? this.#queue.epoch : undefined,
      approvalKind, progressSeq: this.progress.snapshot().seq, step: view?.step?.index,
    });
  }

  resumeForRecovery(checkpoint: Record<string, unknown>): Promise<RecoveryResume | TurnResult> {
    return this.#enqueue<RecoveryResume | TurnResult>(async () => {
      const turn = this.beginTurn(redactText("[작업 재연결]"));
      if (this.consentStatus === "granted" && this.web.currentView !== undefined) {
        let view;
        try { view = await this.web.observe(turn.ctx); }
        catch { return { interrupted: true }; }
        if (this.state !== "STOPPED") this.dialogue.commit(this.dialogue.authWaiting ? "AUTH_HANDOFF" : browseState(view));
      }
      if (this.dialogue.authWaiting) {
        const ended = this.browse.authEndIfUnavailable(turn.ctx);
        if (ended !== undefined) this.dialogue.commit(ended.state);
      }
      const handoff = this.dialogue.authHandoff;
      const offer = this.dialogue.authWaiting
        ? this.#offerFor(turn, this.state, this.browse.authWait(), this.web.currentView)
        : undefined;
      this.#offer = offer;
      return {
        ...checkpoint, state: this.state, ...(this.state === "STOPPED" ? { stopGeneration: this.#queue.epoch } : {}),
        authHandoff: this.dialogue.authWaiting && handoff !== undefined ? handoff.public() : null,
        ...(offer === undefined ? {} : { turnId: offer.turnId,
          offeredChoices: offer.keys.map(key => ({ key, label: choiceLabel(key, this.lang, offer.authKind) })) }),
      };
    });
  }

  async close() {
    this.progress.close();
    this.#clearPlannerDialogue();
    this.#suppliedOrigins.clear();
    this.#pendingResearch = undefined;
    this.#researchReceipts.clear();
    this.need.clear();
    this.publicTask = new PublicTask();
    this.inspectedScreen = undefined;
    this.reviewQuestion = this.authReview = this.placeReview = undefined;
    this.#queue.invalidate();
    this.#controller.abort();
    this.#offer = undefined;
    this.dialogue.stop();
    await this.web.close();
  }

  // ---------------------------------------------------------------- 큐·중단

  /** 다음 턴부터 쓸 모델과 이용 설정. 도는 턴은 지금 것으로 끝낸다. */
  stageSettings(models: ModelRoles, { language, region }: { language?: Lang; region?: string } = {}) {
    this.#nextModels = models;
    if (language !== undefined) this.#nextPreferences.language = language;
    if (region !== undefined) this.#nextPreferences.region = region;
  }

  #enqueue<T = TurnResult>(work: () => Promise<T>): Promise<T | TurnResult> {
    return this.#queue.enqueue<T | TurnResult>(async () => {
      this.#busy = true;
      try {
        if (Object.keys(this.#nextModels).length > 0) {
          Object.assign(this.deps, this.#nextModels);
          this.deps.welfare.llm = this.deps.webLlm;
          this.#nextModels = {};
          this.lang = this.#nextPreferences.language ?? this.lang;
          if (this.#nextPreferences.region !== undefined) this.profile.ctpv = this.#nextPreferences.region;
          this.#nextPreferences = {};
        }
        return await this.#trackBackend(() => this.web.adapter.withTask?.(work) ?? work());
      } finally { this.#busy = false; }
    }, () => this.voided());
  }

  #trackBackend<T>(work: () => Promise<T>) {
    return this.progress.trackBackend(() => this.lang, async line => {
      if (line.length > 160 || /[\r\n\p{Cc}\p{Cf}<>]|https?:\/\/|www\./iu.test(line) ||
          line.includes(REDACTED) || !this.speakable(line) || redactPictureText(line) !== line) return false;
      const [spans] = await this.deps.scanner?.scan([line]) ?? [];
      return redactPictureText(line, spans) === line && !detectSensitive(line, spans).hasSecretValue;
    }, work);
  }

  #interrupt() {
    this.#clearPlannerDialogue();
    this.#queue.invalidate();
    this.progress.interrupt();
    this.#controller.abort();
    this.#controller = new AbortController();
  }

  voided(): TurnResult {
    return this.finish(this.beginTurn(redactText("[중단으로 취소된 요청]")), draft("STOPPED", "none", "중단 요청 때문에 이 요청은 실행하지 않았습니다."));
  }

  #stop(text: Redacted): TurnResult {
    this.#pendingResearch = undefined;
    this.#researchReceipts.clear();
    this.inspectedScreen = undefined;
    this.reviewQuestion = this.authReview = this.placeReview = undefined;
    this.browse.linkChoices = undefined;
    this.publicTask = new PublicTask();
    const busy = this.#busy;
    // 멈추기 전에 이미 바뀐 화면은 되돌리지 않고(멈춘 뒤의 조작이 되므로) 바뀌었다는 사실을 바로 말한다(주인 결정 2026-11-19)
    const moved = busy && this.web.movedSinceLastView();
    this.#interrupt();
    // 사이트의 질문(confirm())에 대신 답할 수 있던 기록도 버린다. 멈춘 뒤의 '응'이 예전 질문에 답하는 일은 없다.
    this.web.forgetNative();
    const dropped = this.lang === "ko" ? this.#droppedOnStop() : "";
    const privateReadback = !this.speakable(dropped);
    const praise = this.firstRun.afterStop();
    this.dialogue.stop();
    this.#approvals.clear();
    const turn = this.beginTurn(text);
    turn.intentType = "STOP";
    turn.ctx.trace("INTENT_DETECTED", AGENT_IDS.orchestrator, "STOP (규칙 즉시 판정)");
    if (praise !== undefined && praise.length > 0) {
      // 첫 실행의 '멈춰' 연습: 칭찬하고 소개를 들을지 묻는다(dialogue.stop()이 지운 뒤 다시 세운다)
      this.firstRun.praised();
      return this.finish(turn, draft("STOPPED", "stop", praise, { lang: this.lang }));
    }
    let stopped: string = FIXED[busy ? "stopBusy" : "stop"][this.lang];
    if (moved) {
      // "하던 일을 멈췄습니다. [화면이 바뀌었어요.] 이어서 하려면 …"
      const gap = sessionPatterns.sentenceGap.exec(stopped);
      const parts = gap === null ? [stopped] : [stopped.slice(0, gap.index), stopped.slice(gap.index + gap[0].length)];
      stopped = [parts[0] ?? "", FIXED.stopMoved[this.lang], ...parts.slice(1)].join(" ");
    }
    return this.finish(turn, draft("STOPPED", "stop", strip(`${stopped} ${dropped}`), { lang: this.lang, privateHistory: privateReadback }));
  }

  /** '지금 어디까지 했어?': 멈춤처럼 턴 대기열을 거치지 않고 진행 기록에서 바로 답한다(일하는 중에도, 멈춘 뒤에도). */
  #progressReply(text: Redacted): TurnResult {
    const turn = this.beginTurn(text);
    turn.intentType = "PROGRESS";
    turn.ctx.trace("INTENT_DETECTED", AGENT_IDS.orchestrator, "PROGRESS (규칙 즉시 판정)");
    return this.finish(turn, this.progressDraft(this.#busy));
  }

  /** busy: 다른 턴이 대기열을 잡고 일하는 중(목표 수행이 아니면 단계 기록이 없다) */
  progressDraft(busy: boolean): Draft {
    const navigationHandoff = this.#offer?.navigationHandoff;
    if (!busy && navigationHandoff !== undefined) return draft(this.state, "read-state", navigationHandoff.prompt, {navigationHandoff});
    const p = this.progress;
    if (busy && p.backendStatus.length > 0) return draft(this.state, "read-state", p.backendStatus, {lang: this.lang});
    const latest = p.latest !== undefined && p.latest.length > 0 ? p.latest : undefined;
    const speech = p.running && latest !== undefined ? `지금까지 ${p.count}단계 했어요. 방금 ${latest}` :
      p.running ? "막 시작해서 화면을 보고 있어요." :
      busy ? "말씀하신 일을 하고 있어요. 조금만 기다려 주세요." :
      latest === undefined ? "지금 하고 있는 일은 없어요." : `지금 하고 있는 일은 없어요. 마지막으로 ${latest}`;
    return draft(this.state, "read-state", speech);
  }

  /** 멈추면서 접은 일을 소리로 알린다(화면을 볼 수 없으니 무엇이 취소됐는지 말해야 안다). */
  #droppedOnStop(): string {
    const d = this.dialogue, notes: string[] = [];
    if (d.approval?.kind === "file") notes.push("승인 대기 중인 파일을 보내지 않았어요.");
    else if (d.approval !== undefined) notes.push("승인을 기다리던 일은 하지 않았어요.");
    const pending = d.vaultConfirm;
    if (pending?.kind === "vault-save") {
      const labels = new Map<string, string>(Object.entries(VAULT_LABELS));
      const listed = Object.entries(pending.values).map(([key, value]) => `${labels.get(key) ?? key} ${value}`).join(", ");
      notes.push(`저장하려던 ${josa(listed, "은", "는")} 저장하지 않았어요.`);
    } else if (pending?.kind.startsWith("guardian-") === true) notes.push("보호자 요청을 취소했어요.");
    else if (pending !== undefined) notes.push("내 정보는 지우지 않았어요.");
    if (d.guided !== undefined) notes.push("입력 칸 채우기도 멈췄어요.");
    if (d.profileQuestion !== undefined && d.profileQuestion.length > 0) notes.push("맞춤 복지 질문도 그만할게요.");
    return notes.join(" ");
  }

  // ---------------------------------------------------------------- 턴 처리

  beginTurn(text: Redacted): Turn {
    // 이전 턴에 받은 주소가 열린 채로 새 탐색을 시작해도 경로는 기기에 남긴다.
    for (const origin of publicDestinations(text).urls.keys()) this.#suppliedOrigins.add(origin);
    const epoch = this.#queue.epoch;
    const started = performance.now();
    const trace: TraceEntry[] = [];
    const id = randomUUID();
    return {
      id, text, intentType: "NONE", initialApprovalId: this.dialogue.confirmation?.actionId, initialApproval: this.dialogue.approval, started, epoch, trace, fromVoice: false, linkQuestion: false, staleLinkOffer: false,
      progressReply: "", researchState: "incomplete", researchEvidence: "",
      ctx: new ExecContext({
        signal: this.#controller.signal, approvals: this.#approvals,
        isStopped: () => epoch !== this.#queue.epoch || this.state === "STOPPED",
        trace: (phase, agent, note) => {
          trace.push(omitAbsent({ phase, agent, note, atMs: Math.floor(performance.now() - started) }));
          backendTrace(phase, agent);
        },
        counter: { actions: 0 }, sessionId: this.id, taskId: id, requestedControl: requestedControl(text), suppliedOrigins: this.#suppliedOrigins,
      }),
    };
  }

  /** 이 턴이 시작한 뒤 멈춤이 있었는지 */
  superseded(turn: Turn) { return turn.epoch !== this.#queue.epoch; }

  // ---------------------------------------------------------------- 다국어(번역 계층)

  /**
   * 한 턴: 언어 바꾸기 명령 → (외국어면) 한국어로 옮겨 기존 흐름 → 응답을 사용자 언어로.
   * 승인 대기 중에는 번역 결과가 '승인'으로 읽혀도 원문이 언어별 승인 단어가 아니면 받지 않는다.
   */
  async process(text: Redacted, sensitive: Detection, forced?: Intent, { fromVoice = false, staleLinkOffer = false, proposalReply = false, plannerDialogue }: ProcessOptions = {}): Promise<TurnResult> {
    const d = this.dialogue;
    if (forced === undefined && (d.expectsConfirmation || d.vaultConfirm !== undefined) && approval(text, this.lang) !== "approve" &&
        LANGS.some(lang => lang !== this.lang && approval(text, lang) === "approve")) {
      return this.fixedReply(redactText("[확인]"), FIXED.approveHint[this.lang], this.lang);
    }
    if (d.authWaiting) {
      // '영어로 말해줘' 같은 언어 바꾸기는 규칙으로만 알아듣는 짧은 명령이라 비밀값일 수 없다: 인증 대기 중에도 받는다
      const to = forced === undefined ? detectLangSwitch(text) : undefined;
      if (to !== undefined) return this.#switchLanguage(text, to);
      return this.#korean(text, sensitive, forced);
    }
    if (forced !== undefined) return this.localize(await this.#korean(text, sensitive, forced, undefined, {fromVoice, staleLinkOffer, proposalReply}));
    // 비밀값은 번역(외부 LLM)에 넘기기 전에 막는다: 어느 언어든 바로 경고만 한다
    if (sensitive.hasSecretValue) {
      this.guardian.takePending();
      return this.localize(await this.#korean(text, sensitive));
    }
    if (guardianRequest(text, this.web.guard.directActions) !== undefined) return this.#korean(text, sensitive);
    const localSave = foreignVaultSave(text);
    if (localSave !== undefined) {
      const [sourceLang, values] = localSave;
      if (this.deps.llm !== undefined) this.lang = sourceLang;
      // 대화와 동의 문은 로컬 명령으로 본다. 적어 준 값은 금고만 받는다.
      return this.localize(await this.#korean(redactText("내 정보 저장해줘"), sensitive, undefined, text,
        { fromVoice, vaultValues: sensitive.kinds.length > 0 ? {} : values }));
    }
    const to = detectLangSwitch(text);
    if (to !== undefined) return this.#switchLanguage(text, to);
    // 글자가 분명히 다른 언어면 그 언어로 바꾼다(텍스트 입력, 또는 그 언어로 받아쓴 경우)
    let script = detectScriptLang(text);
    if (this.publicTask.question.length > 0 && this.publicTask.choices.includes(stripChars(text, " .!?。"))) script = undefined;
    const llm = this.deps.llm;
    if (script !== undefined && script !== this.lang && (script === "ko" || llm !== undefined)) this.lang = script;
    const lang = this.lang;
    if (lang === "ko" || script === "ko" || llm === undefined ||
        (sessionPatterns.hangul.test(text) && parsePersonalCommand(text, this.today)?.kind.startsWith("vault-") === true)) {
      return this.#korean(text, sensitive, undefined, undefined, { fromVoice, staleLinkOffer, plannerDialogue });
    }
    if (this.linkOfferId.length > 0 && !d.hasPendingInteraction && this.publicTask.question.length === 0 && agree(text) !== undefined) {
      return this.localize(await this.#korean(text, sensitive, undefined, undefined, { fromVoice, staleLinkOffer, plannerDialogue }));
    }
    if (!d.expectsConfirmation && !this.#secretHint) {
      const labels = (this.web.currentView?.fields ?? []).filter(f => f.visible && !f.sensitive).map(f => f.label);
      const localFills = parseForeignFieldFill(text, lang, labels);
      if (localFills !== undefined) {
        return this.localize(await this.#korean(redactText("[입력 요청]"), sensitive,
          { type: "FILL", fills: localFills }, text, { fromVoice, staleLinkOffer, plannerDialogue }));
      }
    }
    // 외국어 공공업무는 원문에서 바로 판단한다. 별도 입력 번역으로 기관·부정·요구사항을 잃지 않는다.
    if (this.planner.canPlan(text, sensitive) && !this.#secretHint) {
      const turn = this.beginTurn(text);
      turn.fromVoice = fromVoice;
      if (plannerDialogue !== undefined) turn.plannerDialogue = plannerDialogue;
      const planned = await this.planner.plan(text, turn);
      if (planned !== undefined) return this.localize(planned);
    }
    const awaitingApproval = d.expectsConfirmation;
    const confirmation = foreignApproval(text, lang);
    let korean: Redacted;
    // 금고 대답은 들어올 때 원문 전체로 이미 확인했다.
    if (awaitingApproval && confirmation !== undefined && d.vaultConfirm?.confirmation === undefined) {
      korean = redactText(confirmation === "approve" ? "승인" : "거절");
    } else {
      const translated = await translateIn(this.deps.webLlm ?? llm, text, lang, this.#controller.signal);
      if (translated === undefined || translated.length === 0) return this.fixedReply(text, FIXED.retry[lang], lang);
      if (awaitingApproval && (await this.rules.parse(translated, { state: this.state })).type === "APPROVE") {
        return this.fixedReply(text, FIXED.approveHint[lang], lang);
      }
      korean = redactText(translated);
    }
    return this.localize(await this.#korean(korean, sensitive, undefined, text, { fromVoice, staleLinkOffer, plannerDialogue }));
  }

  // ---------------------------------------------------------------- 한국어 흐름

  /** 맞장구("알았어")·부정("아니")만 한 말에 대한 짧은 응답. 해당하지 않으면 undefined. */
  #shortReply(text: string): Draft | undefined {
    const kind = ackKind(text);
    if (kind === undefined) return undefined;
    const no = kind === "no";
    // 승인 대기 중: 승인은 분명한 말로만, "아니"는 거절 흐름(기존 규칙)에 맡긴다
    if (this.dialogue.approval !== undefined) return no ? undefined : draft(this.state, "clarify",
      "아직 확인을 기다리고 있어요. 진행하려면 '승인' 또는 '응', 하지 않으려면 '아니'라고 말씀해 주세요.");
    const awaiting = this.dialogue.awaiting;
    if (awaiting !== undefined && awaiting.length > 0 && isFormOpen(this.web.currentView)) {
      const label = speakLabel(this.web.field(awaiting)?.label ?? "그 항목");
      return draft(this.state, "clarify", no ? `알겠어요. ${josa(label, "은", "는")} 아직 비워 둘게요. 다른 값을 말씀하시거나 '다음으로', '멈춰'라고 해 주세요.` :
        `네. ${josa(label, "을", "를")} 말씀해 주세요.`);
    }
    this.dialogue.clearChoice();
    return draft(this.state, "none", no ? "알겠어요. 그럼 무엇을 도와드릴까요?" : "네.");
  }

  fixedReply(text: Redacted, speech: string, lang: Lang): TurnResult {
    const turn = this.beginTurn(text);
    turn.intentType = "CLARIFY";
    return this.finish(turn, draft(this.state, "clarify", speech, { lang }));
  }

  #switchLanguage(text: Redacted, to: Lang): TurnResult {
    this.guardian.takePending();
    const turn = this.beginTurn(text);
    turn.intentType = "SET_LANGUAGE";
    if (to !== "ko" && this.deps.llm === undefined) return this.finish(turn, draft(this.state, "set-language", FIXED.needLlm[this.lang], { lang: this.lang }));
    this.lang = to;
    turn.ctx.trace("INTENT_DETECTED", AGENT_IDS.orchestrator, `SET_LANGUAGE ${to} (규칙)`);
    turn.approvalNotice = "switch";
    return this.finish(turn, draft(this.state, "set-language", FIXED.switched[to], { lang: to }));
  }

  /** 한국어 응답을 사용자 언어로. 숫자가 바뀌면 원문 한국어를 들려준다(지어낸 숫자 방지). */
  async localize(r: TurnResult): Promise<TurnResult> {
    const result = await this.#localized(r);
    this.#keepResearch(result);
    return result;
  }

  #keepResearch(result: TurnResult) {
    if (result.researchDelivery !== "outcome" || result.state === "STOPPED" || this.#consent !== "granted") return;
    const {turnId, lang} = result;
    if (this.#pendingResearch?.turnId === turnId) this.#pendingResearch = undefined;
    if (result.localSpeechOnly === true) return;
    const speech = this.speakable(result.speech) && detectSensitive(result.speech).kinds.length === 0 ? result.speech : RESEARCH_UNDELIVERED[lang];
    this.#researchReceipts.set(turnId, {turnId, speech, lang});
  }

  async #localized(r: TurnResult): Promise<TurnResult> {
    const lang = this.lang, reviewer = this.deps.llm;
    if (lang === "ko" || r.lang === lang || reviewer === undefined || r.localSpeechOnly === true) return r;
    const started = performance.now();
    const epoch = this.#queue.epoch;
    const signal = this.#controller.signal;
    const card = r.answerCard;
    const translator = this.deps.webLlm ?? reviewer;
    const subject = r.sources.length > 0 && (r.intentType === "GOAL" || r.intentType === "POLICY_QUESTION") ? this.publicTask.subject : "";
    let localized: typeof card;
    let out: string | undefined;
    try {
      if (card !== undefined) {
        const options = { verified: true, subject: card.serviceName.length > 0 ? card.serviceName : subject, reviewer };
        const answer = await translateOut(translator, card.answer, lang, signal, options);
        const nextAction = answer === undefined || answer.length === 0 ? undefined : await translateOut(translator, card.nextAction, lang, signal, options);
        if (answer !== undefined && nextAction !== undefined && nextAction.length > 0) localized = { ...card, answer, nextAction };
        out = localized === undefined ? undefined : speakAnswerCard(localized, lang);
      } else {
        out = await translateOut(translator, r.speech, lang, signal, { verified: r.sources.length > 0, subject, reviewer });
      }
    } catch { out = undefined; }
    if (epoch !== this.#queue.epoch) {
      return { ...r, speech: FIXED.stopBusy[lang], state: "STOPPED", stopGeneration: this.#queue.epoch, lang, offeredChoices: [] };
    }
    const spoken = out !== undefined && out.length > 0 ? out : undefined;
    const previous = this.#plannerTurns.at(-1);
    if (spoken !== undefined && previous?.id === r.turnId && previous.localize) {
      const [localizedExchange] = this.plannerDialogue([], [{ ...previous.exchange, assistant: spoken }]);
      if (localizedExchange) previous.exchange = localizedExchange;
      else this.#clearPlannerDialogue();
    }
    return {
      ...r, ...(localized !== undefined && spoken !== undefined ? { answerCard: localized } : {}),
      speech: spoken ?? `${FIXED.translateFail[lang]} ${r.speech}`, lang: spoken === undefined ? "ko" : lang,
      trace: [...r.trace, {
        phase: "SPEAKING", agent: AGENT_IDS.orchestrator, atMs: (r.trace.at(-1)?.atMs ?? 0) + Math.floor(performance.now() - started),
        note: spoken === undefined ? "응답 번역 실패(숫자 불일치 등) → 한국어 원문" : `응답 번역 ko→${lang}`,
      }],
    };
  }

  /** 턴 시작의 동의·멈춤 문 */
  gate(types: Parameters<typeof gateRefusal>[0]): Draft | undefined {
    return this.#refused(gateRefusal(types, this.#consent, this.state));
  }

  /** 질문마다, 실행 직전마다의 동의 문(멈춤은 턴 시작에서 이미 봤다) */
  consentGate(intent: Intent): Draft | undefined {
    return this.#refused(consentRefusal([intent.type], this.#consent));
  }

  #refused(refusal: GateRefusal | undefined): Draft | undefined {
    return refusal === undefined ? undefined : draft(refusal.state ?? this.state, refusal.semanticAction, refusal.speech);
  }

  async #guardianTurn(text: Redacted, turn: Turn, forced: Intent | undefined): Promise<TurnResult | undefined> {
    const pending = this.guardian.takePending();
    if (pending !== undefined) {
      const word = rstripChars(strip(text), ".!。");
      const approved = approval(text) === "approve" && (turn.original === undefined || foreignApproval(turn.original, this.lang) === "approve");
      if (approved || forced !== undefined || ["아니", "아니요", "아뇨", "거절", "취소"].includes(word)) {
        turn.intentType = "GUARDIAN_CONFIRM";
        const refused = this.gate(["GUARDIAN_CONFIRM"]);
        if (refused !== undefined) return this.finish(turn, refused);
        if (!approved) return this.finish(turn, draft(pending.resume, "none", "보호자 요청을 취소했어요."));
        const view = pending.kind === "guardian-send" ? await this.web.observe(turn.ctx) : undefined;
        if (turn.ctx.signal.aborted) return this.voided();
        return this.finish(turn, await this.guardian.approved(pending, view, this.clock(), APPROVAL_TTL_S));
      }
    }
    const command = forced === undefined ? guardianRequest(text, this.web.guard.directActions) : undefined;
    if (command === undefined) return undefined;
    turn.intentType = "GUARDIAN_CONTACT";
    turn.text = redactText(REDACTED);
    turn.original = undefined;
    const refused = this.gate(["GUARDIAN_CONTACT"]);
    if (refused !== undefined) return this.finish(turn, refused);
    const current = this.web.currentView;
    const resume = this.state === "WAITING_FOR_USER_CONFIRMATION" ? (current === undefined ? "IDLE" : browseState(current)) : this.state;
    this.dialogue.takeVaultConfirm();
    this.dialogue.clearApproval();
    const view = command.kind === "guardian-send" && this.personal.guardian() !== undefined ? await this.web.observe(turn.ctx) : undefined;
    if (turn.ctx.signal.aborted) return this.voided();
    const response = this.guardian.ask(command, view, this.clock(), resume);
    if (this.web.guard.directActions && response.state === "WAITING_FOR_USER_CONFIRMATION") {
      const requested = this.guardian.takePending();
      if (requested) return this.finish(turn, await this.guardian.approved(requested, view, this.clock(), APPROVAL_TTL_S));
    }
    return this.finish(turn, response);
  }

  async #korean(text: Redacted, sensitive: Detection, forced?: Intent, original?: Redacted,
    { fromVoice = false, staleLinkOffer = false, proposalReply = false, vaultValues, plannerDialogue }: ProcessOptions & { vaultValues?: Vault } = {}): Promise<TurnResult> {
    const turn = this.beginTurn(text);
    turn.original = original;
    turn.fromVoice = fromVoice;
    if (plannerDialogue !== undefined) turn.plannerDialogue = plannerDialogue;
    turn.staleLinkOffer = staleLinkOffer;
    turn.ctx.trace("TRANSCRIBED", AGENT_IDS.orchestrator, vaultValues !== undefined ? "기기 내 금고 요청" : original === undefined ? undefined : `번역 ${this.lang}→ko`);
    const d = this.dialogue;
    const settle = () => { d.commit(this.web.currentView === undefined ? "IDLE" : browseState(this.web.currentView)); };
    try {
      if (sensitive.hasSecretValue) {
        turn.intentType = "SECRET_DISCLOSURE";
        return this.finish(turn, this.#handleSecret(sensitive));
      }
      if (d.authWaiting) return this.finish(turn, await this.#authTurn(turn, forced));
      if (forced === undefined && sensitive.kinds.length === 0) {
        const request = afterProgressQuestion(text);
        if (request !== undefined && request.length > 0) {
          turn.progressReply = this.progressDraft(false).speech;
          // 기다리는 질문의 대답은 말 전체로 확인해야 한다.
          if (!d.hasPendingInteraction && this.publicTask.question.length === 0) text = redactText(request);
        }
      }
      const ask = d.takePlaceAsk();
      const placeReview = this.placeReview;
      this.placeReview = undefined;
      if (ask !== undefined && forced === undefined && this.rules.parseSync(text, { state: this.state }).type === "UNKNOWN") {
        const reply = this.places.followUp(ask, text, { lang: this.lang });
        if (reply !== undefined) {
          turn.intentType = "FIND_PLACE";
          let result = this.gate(["FIND_PLACE"]) ?? this.replies.placeReply(reply);
          if (placeReview?.[0] === ask) result = await this.review.run(placeReview[1], turn, result);
          return this.finish(turn, result);
        }
      }
      const taken = d.takeSiteGuess();
      const guess = taken === undefined ? undefined : SiteGuessSchema.parse(taken);
      if (guess !== undefined && forced === undefined) {
        const answer = text.replace(sessionPatterns.answerTail, "");
        const options = guess.options ?? [];
        const said = agree(answer);
        if (options.length > 0) {
          const choice = fullMatch(sessionPatterns.numberedChoice, answer);
          if (choice !== null) {
            const picked = options[choice[1] === undefined ? Number(answer.startsWith("두")) : Number(choice[1]) - 1];
            if (picked === undefined) throw new RangeError("없는 선택지");
            text = turn.text = redactText(picked.text);
          } else if (said === "yes") {
            d.askSite(guess);
            turn.intentType = "CLARIFY";
            return this.finish(turn, draft(this.state, "clarify", guess.prompt ?? "", { publicSuggestions: options.map(o => o.label) }));
          } else if (said === "no") {
            turn.intentType = "CLARIFY";
            return this.finish(turn, draft(this.state, "clarify", "찾으시는 업무나 기관 이름을 말씀해 주세요."));
          } else {
            const name = answer.replace(sessionPatterns.politeEnding, "");
            const matches = options.filter(o => name.length > 0 && o.label.includes(name));
            if (matches.length === 1 && matches[0] !== undefined) text = turn.text = redactText(matches[0].text);
          }
        } else if (said === "yes") {
          text = turn.text = redactText(guess.text ?? "");
        } else if (said === "no") {
          turn.intentType = "CLARIFY";
          if (guess.heard === true) return this.finish(turn, draft(this.state, "clarify", "알겠어요. 찾으시는 업무나 기관 이름을 말씀해 주세요."));
          return this.finish(turn, draft(this.state, "clarify",
            `알겠어요. ${josa(guess.label ?? "", "으로", "로")} 가지 않을게요. 어느 사이트인지, 또는 무엇을 도와드릴지 다시 말씀해 주세요.`));
        }
      }
      const waitingKind = d.approval?.kind;
      if (forced === undefined && (waitingKind === "file" || waitingKind === "visual" || waitingKind === "research" || waitingKind === "plan")) {
        if (approval(text) === "approve" && (original === undefined || foreignApproval(original, this.lang) === "approve")) forced = { type: "APPROVE" };
        else if (fullMatch(sessionPatterns.declineSending, text) !== null) forced = { type: "REJECT" };
        else {
          d.clearApproval();
          settle();
        }
      }
      const guardian = await this.#guardianTurn(text, turn, forced);
      if (guardian !== undefined) return guardian;
      if (d.vaultConfirm !== undefined) {
        if (forced?.type === "APPROVE" || forced?.type === "REJECT") {
          turn.intentType = "VAULT_CONFIRM";
          return this.finish(turn, this.gate(["VAULT_CONFIRM"]) ?? this.personalDialogue.confirm(forced.type === "APPROVE"));
        }
        d.takeVaultConfirm();
        if (this.state === "WAITING_FOR_USER_CONFIRMATION") settle();
      }
      // 맞춤 복지 질문에 대한 답이면 이어서 진행(다른 명령이면 질문을 접고 그 명령을 처리)
      const asked = d.profileQuestion;
      if (forced === undefined && asked !== undefined && asked.length > 0) {
        const slot = asProfileSlot(asked);
        const other = this.rules.parseSync(text, { state: this.state });
        const answer = other.type === "FIND_PLACE" || other.type === "OPEN_SITE" || other.type === "GOAL" ? {} : parseProfileAnswer(text, slot, this.profile);
        if (Object.keys(answer).length > 0) {
          turn.intentType = "PROFILE_ANSWER";
          this.profile = { ...this.profile, ...answer };
          return this.finish(turn, await this.replies.discoverStep(turn, false));
        }
        // 대답을 못 알아들었고 다른 명령도 아니면, 처음부터 다시 묻지 말고 그 질문만 짧게 다시 묻는다
        const looksLikeAnswer = Array.from(text).length <= 20 && !sessionPatterns.profileCommand.test(text);
        if (other.type === "UNKNOWN" && looksLikeAnswer && parsePersonalCommand(text, this.today) === undefined && detectLangSwitch(text) === undefined) {
          turn.intentType = "PROFILE_ANSWER";
          return this.finish(turn, draft(this.state, "discover", `제가 잘 못 알아들었어요. ${profileQuestion(slot, this.profile)}`));
        }
        d.profileDone();
      }
      if (forced === undefined) {
        const savedResearch = /^(?:맡긴 조사 결과 읽어\s*줘|저장한 조사 결과 읽어\s*줘|read (?:my |the )?saved research(?: results?)?|朗读(?:已保存的)?调查结果|保存した調査結果を読んで)[.!?。]?$/iu;
        if (this.deps.readResearch !== undefined && !d.hasPendingInteraction && savedResearch.test(original ?? text)) {
          turn.intentType = "READ_RESEARCH";
          const result = await this.deps.readResearch(this.lang);
          if (result !== undefined) return this.finish(turn, { ...result, state: this.state });
        }
        // 라벨(intentType)은 await 전에 적는다. 그 안에서 예외가 나면 RECOVERING 결과가 이 라벨을 보고한다.
        // 실제 사이트 칸 채우기. 진행 중이면 그 대답으로 받고, 아니면 '하나씩 채워줘'로 시작한다.
        // 승인 대기(칸에 넣을지 물음) 중이면 칸 채우기 대답으로 가로채지 않고 승인 문으로 보낸다.
        if (this.guided.active() && d.approval === undefined) {
          turn.intentType = "GUIDED_FILL";
          const answered = await this.guided.answer(text, turn.ctx);
          if (answered !== undefined) return this.finish(turn, answered);
        }
        if (this.guided.wantsStart(text)) {
          turn.intentType = "GUIDED_FILL";
          return this.finish(turn, this.gate(["GUIDED_FILL"]) ?? await this.guided.start(turn.ctx));
        }
        // 금고·신청 기록 명령. 다른 명령처럼 동의 문과 멈춤 문을 지난다.
        const command = vaultValues === undefined ? parsePersonalCommand(text, this.today) : { kind: "vault-save" as const, values: vaultValues };
        const planning = guess === undefined && original === undefined && this.planner.canPlan(text, sensitive);
        const recordCandidate = command?.kind === "app-status" || command?.kind === "app-done";
        if (planning && recordCandidate) {
          const planned = await this.planner.plan(text, turn);
          if (planned !== undefined) return planned;
        }
        if (command !== undefined) {
          const type: `PERSONAL_${string}` = `PERSONAL_${command.kind.toUpperCase().replace("-", "_")}`;
          turn.intentType = type;
          if (command.kind === "vault-save") this.redactEarlierMentions(Object.values(command.values));
          const refused = this.gate([type]);
          if (refused !== undefined) return this.finish(turn, command.kind.startsWith("vault-") ? {...refused, privateHistory: true} : refused);
          const done = this.personalDialogue.run(command, { lang: this.lang, direct: this.web.guard.directActions });
          if (done !== undefined) return this.finish(turn, done);
        }
        const free = guess === undefined && sensitive.kinds.length === 0;
        if (free && !d.hasPendingInteraction && this.publicTask.question.length === 0) {
          if (!this.web.guard.directActions && original === undefined && this.#consent === "granted" && (this.state === "BROWSING" || this.state === "APPLICATION_OPEN") && this.lang === "ko" &&
              !turn.staleLinkOffer && turn.text === text) {
            const names = spokenPlanNames(this.rules.splitCommands(text));
            if (names !== undefined) {
              const plan = await this.browse.knownPlans.spoken(text, names, turn.ctx);
              if (plan !== undefined) {
                turn.intentType = "PLAN(FOLLOW_LINK)";
                return this.finish(turn, plan);
              }
            }
          }
          const reference = linkReference(text, this.browse.linkChoices);
          if (reference !== undefined) {
            if (turn.staleLinkOffer) return this.finish(turn, this.changedLinkReply());
            const type = reference.action === "open" ? "FOLLOW_LINK" : "LIST_LINKS";
            turn.intentType = type;
            const refused = this.gate([type]);
            if (refused !== undefined) return this.finish(turn, refused);
            const said = text;
            if (reference.action === "question") {
              turn.linkQuestion = true;
              let intents = (await raceAbort(() => this.understand(said, turn), turn.ctx.signal)).intents;
              if (intents.some(i => !READ_ONLY_QUESTIONS.has(i.type))) intents = [{ type: "UNKNOWN", text: said }];
              return this.finish(turn, await this.runPlan(intents, turn));
            }
            return this.planner.command(turn, type, async () => {
              const before = this.web.currentView;
              const result = await raceAbort(() => this.browse.chooseLink(reference, said, turn.ctx, { redact: speech => this.historySpeech(speech) }), turn.ctx.signal);
              return this.browse.recognizeAuthPage(result, before, turn.ctx);
            });
          }
        }
        if (planning && !recordCandidate) {
          const planned = await this.planner.plan(text, turn);
          if (planned !== undefined) return planned;
        }
        // "알았어", "아니" 같은 짧은 대답은 명령이 아니다: 입력값으로 넣거나 다음으로 넘어가지 않는다.
        const short = this.#shortReply(text);
        if (short !== undefined) {
          turn.intentType = "ACK";
          return this.finish(turn, short);
        }
        // "알았고 다음으로 가줘", "아니 네이버 말고 다음 열어줘": 앞의 맞장구·군말은 떼고 본다
        if (this.deps.llm === undefined && d.approval === undefined) text = redactText(stripFiller(text));
        if (fromVoice && free && this.#consent === "granted" && SPEECH_REPAIR_STATES.has(this.state) &&
            (d.awaiting === undefined || d.awaiting.length === 0) && d.approval === undefined && d.clarification === undefined) {
          const state = this.state;
          const parse = (phrase: string) => this.rules.parseSync(phrase, { state }).type;
          if (this.planner.followup(text) === undefined) {
            const [options, clear] = await interpretSpeech(text, parse(text), this.planner.planningContext(text), this.deps.llm, turn.ctx.signal, parse);
            if (turn.ctx.signal.aborted) return this.finish(turn, draft("STOPPED", "stop", "멈췄어요."));
            const [option, second] = options;
            if (clear && option !== undefined) text = turn.text = redactText(option.text);
            else if (option !== undefined) {
              let prompt: string;
              if (second === undefined) {
                prompt = `'${option.text}'라는 뜻인가요?`;
                d.askSite({ heard: true, label: option.label, text: option.text });
              } else {
                prompt = `1번 ${option.label}, 2번 ${second.label} 중 어떤 업무를 찾으세요?`;
                d.askSite({ options: options.map(o => ({ text: o.text, label: o.label })), prompt });
              }
              turn.intentType = "CLARIFY";
              return this.finish(turn, draft(this.state, "clarify", prompt, { publicSuggestions: options.map(o => o.label) }));
            }
          }
        }
      }
      // 승인을 기다리는 중의 "눌러", "진행해"는 두루뭉술한 말이 아니라 승인이다.
      const vague = forced !== undefined || d.approval !== undefined ? undefined : vagueQuestion(text);
      if (vague !== undefined) {
        turn.intentType = "CLARIFY";
        return this.finish(turn, draft(this.state, "clarify", vague));
      }
      const heard = text;
      const understood: Understood = forced !== undefined ? { intents: [forced], by: proposalReply ? "context" : "ui" } : await raceAbort(() => this.understand(heard, turn), turn.ctx.signal);
      if (turn.ctx.signal.aborted) return this.voided();
      const intents = understood.intents;
      if (forced === undefined && intents.some(i => i.type === "APPROVE") && approval(original ?? turn.text, this.lang) !== "approve") {
        return this.finish(turn, draft(this.state, "clarify", FIXED.approveHint[this.lang]));
      }
      const [intent, ...rest] = intents;
      if (intent === undefined) throw new RangeError("빈 의도 목록");
      turn.intentType = rest.length > 0 ? `PLAN(${intents.map(i => i.type).join(">")})` : intent.type;
      turn.ctx.trace("INTENT_DETECTED", AGENT_IDS.orchestrator, `${turn.intentType} via ${understood.by}`);
      const refused = this.gate([intent.type, ...rest.map(i => i.type)]);
      if (refused !== undefined) return this.finish(turn, refused);
      const llm = this.deps.llm;
      if (forced === undefined && this.deps.publicPlanning !== false && llm !== undefined && this.#consent === "granted" &&
          intents.length >= 3 && intents.some(i => NAVIGATION.has(i.type)) && sensitive.kinds.length === 0 &&
          intents.every(i => ReviewLoop.intentAllowed(i.type, []))) {
        // 실제 주소를 직접 말했거나 신청서 안에서 시작해 일반 계획기로 온 복합 요청도 같은 최종 검토를 거친다.
        const request = original ?? heard;
        const clauses = this.rules.splitCommands(request).filter(part => request.includes(part));
        const run = new ReviewedTask({
          request, task: new PublicTask({ goal: request }), requirements: clauses.length > 0 ? clauses : [request], route: "existing",
          difficulty: LIVE_DIFFICULTY.getStore() ?? "medium", counter: turn.ctx.counter,
          remaining: intents.map(i => [i, heard]), originalOperations: new Set(intents.map(i => JSON.stringify(i))),
        });
        turn.intentType = "REVIEW_BEFORE_OUTPUT";
        return this.finish(turn, await this.review.run(run, turn));
      }
      // 전체 발화를 되풀이한 단계가 빠져 질문 하나만 남아도 모델이 쓴 질문으로 처리한다.
      const splitQuestion = intent.type === "UNKNOWN" && llm !== undefined && understood.by === llm.name && intent.text !== heard;
      if (rest.length > 0 || splitQuestion) return this.finish(turn, await this.runPlan(intents, turn));
      return await this.planner.command(turn, intent.type, () => this.route(intent, turn));
    } catch (error) {
      if (isAbort(error)) return this.voided();
      if (error instanceof ModelTransportError) {
        return this.finish(turn, draft("RECOVERING", "none", "웹 탐색에 필요한 AI 서비스에 연결하지 못했어요. 잠시 뒤 다시 말씀해 주세요."));
      }
      const name = error instanceof Error ? error.name : "Error";
      return this.finish(turn, draft("RECOVERING", "none", `처리 중 문제가 생겨 실행을 멈췄습니다(${name}). 다시 말씀해 주세요.`));
    }
  }

  async #authTurn(turn: Turn, forced: Intent | undefined): Promise<Draft> {
    const text = turn.text;
    const d = this.dialogue;
    const inspection = this.authReview?.[1].inspection !== undefined;
    if (inspection) turn.ctx = withContext(turn.ctx, { browsingScope: "personal-inspection" });
    const loginSubmit = () => { const waiting = d.approval; return waiting?.kind === "click" && waiting.then === "login-submit"; };
    const parsed = forced ?? this.rules.parseSync(text, { state: d.approval === undefined ? "AUTH_HANDOFF" : "WAITING_FOR_USER_CONFIRMATION" });
    let intent: string = parsed.type;
    const ended = this.browse.authEndIfUnavailable(turn.ctx);
    if (ended !== undefined) {
      this.authReview = undefined;
      turn.text = redactText(REDACTED);
      return ended;
    }
    const lang = this.lang;
    if (cancelReply(text)) {
      this.authReview = undefined;
      turn.intentType = "REJECT";
      return { ...this.browse.finishAuth("cancelled", FIXED.authCancelled[lang]), lang };
    }
    if (forced === undefined && loginSubmit()) {
      const reply = approval(text, lang);
      if (reply === "approve") intent = "APPROVE";
      else if (wholeRejection(text, lang)) intent = "REJECT";
      else if (reply === "reject" || intent === "APPROVE" || intent === "REJECT") {
        turn.text = redactText(REDACTED);
        turn.intentType = "CLARIFY";
        return draft(this.state, "clarify", FIXED.approveHint[lang], { lang });
      }
    }
    // 인증 대기 중에는 말을 번역 모델에 보내지 않으므로 다른 언어의 '다 했어'는 규칙으로 알아듣는다
    if (forced === undefined && intent === "UNKNOWN" && doneReply(text)) intent = "AUTH_DONE";
    turn.intentType = intent;
    const handoff = d.authHandoff;
    const waiting = this.authReview;
    const sameGoal = waiting !== undefined && handoff?.id === waiting[0] && waiting[1].continuation !== undefined;
    if (sameGoal) turn.ctx = waiting[1].context(turn.ctx);
    const enteredCredentials = !inspection && handoff?.kind === "login" && authInputDone(text) &&
      (intent === "LOGIN" || (intent === "AUTH_DONE" && this.web.guard.directActions));
    if (enteredCredentials || intent === "AUTH_DONE" || (sameGoal && intent === "APPROVE" && loginSubmit())) {
      if (intent === "AUTH_DONE") d.clearApproval();
      const journey = handoff?.id === waiting?.[0] ? waiting?.[1].journey : undefined;
      const result = enteredCredentials ? await this.browse.login(text, turn.ctx)
        : intent === "AUTH_DONE" ? await this.browse.authDone(turn.ctx, inspection ? journey : undefined)
          : await this.application.approve(turn);
      if (waiting !== undefined && handoff?.id === waiting[0] && handoff.status === "completed") {
        this.authReview = undefined;
        journey?.resumeAfterAuth();
        return this.review.run(waiting[1], turn, result);
      }
      if (waiting && !d.authWaiting) this.authReview = undefined;
      return result;
    }
    if ((intent === "APPROVE" || intent === "REJECT") && loginSubmit()) {
      if (intent === "APPROVE") return this.#approve(turn);
      d.clearApproval();
      return this.browse.authWait("로그인 버튼을 누르지 않았어요. 사이트에서 직접 진행해 주세요.");
    }
    if (intent === "HELP_HUMAN") return this.replies.helpHuman();
    turn.text = redactText(REDACTED);
    if (intent === "UNKNOWN") {
      turn.intentType = "SECRET_DISCLOSURE";
      return { ...this.#possibleSecret(), state: "AUTH_HANDOFF", speech: FIXED.possibleSecretAuth[lang], lang };
    }
    return { ...this.browse.authWait(FIXED.authWait[lang]), lang };
  }

  /** 실제 승인 경로를 한 번 실행하고, 반환된 결과에서 확인할 수 있는 사유만 현지화한다. */
  async #approve(turn: Turn): Promise<Draft> {
    const previous = this.dialogue.approval;
    const expiresAt = this.clock() + APPROVAL_TTL_S - this.dialogue.approvalAge;
    const out = await this.application.approve(turn);
    if (this.lang === "ko" || previous === undefined || !("fingerprint" in previous) || this.superseded(turn)) return out;
    const next = this.dialogue.approval;
    if (next === undefined && out.view !== undefined && out.semanticAction === "none" && (out.actions?.length ?? 0) === 0) {
      const actions = previous.kind === "assist" ? previous.actions : [previous.action];
      if (previous.url !== out.view.url || recheck(previous.fingerprint, out.view, actions)[1] !== undefined) turn.approvalNotice = "changed";
    } else if (next !== undefined && "fingerprint" in next && next.action === previous.action &&
        next.confirmation.actionId !== previous.confirmation.actionId && out.state === "WAITING_FOR_USER_CONFIRMATION") {
      if (this.clock() >= expiresAt && (out.actions?.length ?? 0) === 0) turn.approvalNotice = "expired";
      else if (out.actions?.some(a => a.result?.ok === false) === true) turn.approvalNotice = "unverified";
    }
    return out;
  }

  finish(turn: Turn, out: Draft): TurnResult {
    const stopped = this.superseded(turn) && out.semanticAction !== "stop";
    const state = stopped ? "STOPPED" : out.state;
    let speech: string = stopped ? FIXED.stopBusy[this.lang] : out.speech;
    const d = this.dialogue;
    const pending = d.approval;
    const renewedSame = turn.intentType === "APPROVE" && pending !== undefined && turn.initialApproval !== undefined &&
      "action" in pending && "action" in turn.initialApproval && pending.action === turn.initialApproval.action;
    const newRequest = (pending !== undefined || d.vaultConfirm?.kind === "vault-clear") && d.confirmation?.actionId !== turn.initialApprovalId &&
      out.state === "WAITING_FOR_USER_CONFIRMATION" && !renewedSame;
    if (newRequest && pending?.kind === "click") {
      this.#clickPresentations.set(pending.action, {
        title: hasText(out.view?.title) ? out.view.title : pending.confirmation.site,
        inspection: turn.ctx.browsingScope === "personal-inspection" && out.lang !== undefined,
      });
    }
    const shown = stopped ? undefined : this.#approvalPresentation();
    const approvalNotice = turn.approvalNotice ?? (newRequest ? "ask" : undefined);
    const containsValue = d.confirmation?.values.some(({ value }) => value.length > 0 && speech.includes(value)) === true;
    const localApproval = shown !== undefined && (approvalNotice !== undefined || containsValue);
    const privateHistory = localApproval || turn.intentType.startsWith("GUARDIAN_") || out.privateHistory === true || turn.ctx.browsingScope === "personal-inspection";
    // 금고 값(저장 대기 포함)은 사용자에게는 읽어 주되, LLM에 가는 기록에는 넣지 않는다.
    let recorded = privateHistory ? REDACTED : this.#withoutSecrets(speech);
    let localSpeechOnly = privateHistory || recorded !== speech || d.approval?.kind === "plan";
    if (!localSpeechOnly && d.confirmation === undefined && turn.intentType !== "READ_START_GUIDE" &&
        (out.pictureHistory === undefined || out.pictureHistory.length === 0) && out.answerCard === undefined && out.review === undefined) {
      speech = recorded = this.#trimSpeech(speech);
    }
    if (turn.progressReply.length > 0 && !stopped) {
      speech = `${turn.progressReply} ${speech}`;
      const lead = this.#withoutSecrets(turn.progressReply);
      localSpeechOnly ||= lead !== turn.progressReply;
      if (!privateHistory) recorded = `${lead} ${recorded}`;
    }
    if (!stopped) {
      d.commit(state);
      this.lastSemantic = out.semanticAction;
      const choices = this.browse.linkChoices;
      if (choices !== undefined) {
        choices.offerId = out.offersLinks === true ? turn.id : "";
        if (choices.offerId.length === 0) choices.proposed = undefined;
      }
    }
    turn.ctx.trace("SPEAKING", AGENT_IDS.orchestrator);

    const view: View | undefined = out.view ?? this.web.currentView;
    const offer = stopped ? undefined : this.#offerFor(turn, state, out, view);
    const at = new Date().toISOString();
    if (!stopped) {
      this.#offer = offer;
      const userText = privateHistory || turn.intentType === "PERSONAL_VAULT_SAVE" ? redactText(REDACTED) : this.historySpeech(turn.text);
      const reply = out.pictureHistory !== undefined && out.pictureHistory.length > 0 ? redactText(out.pictureHistory) :
        recorded === out.speech && out.historySpeech !== undefined ? out.historySpeech : redactText(recorded);
      this.#history.push({ turnId: turn.id, role: "user", text: userText, at, state, intentType: turn.intentType },
        { turnId: turn.id, role: "assistant", text: reply, at, state });
      if (localSpeechOnly || state === "AUTH_HANDOFF" || state === "STOPPED" || turn.intentType.startsWith("PERSONAL_") ||
          turn.intentType === "SECRET_DISCLOSURE" || userText === REDACTED || this.#consent !== "granted") {
        this.#clearPlannerDialogue();
      } else {
        const [exchange] = this.plannerDialogue([], [{user: turn.original ?? userText, assistant: reply}]);
        if (exchange) {
          this.#plannerTurns.push({ id: turn.id, exchange: { ...exchange, turnId: turn.id }, localize: reply === speech && out.pictureHistory === undefined && out.historySpeech === undefined });
          if (this.#plannerTurns.length > PLANNER_EXCHANGES) this.#plannerTurns.shift();
          this.#rememberPublicTurn(turn, out, state, view, userText, reply);
        } else this.#clearPlannerDialogue();
      }
    }
    const actions = (out.actions ?? []).map(a => {
      const r = a.result;
      this.deps.events?.record(omitAbsent({ sessionId: this.id, turnId: turn.id, actionType: a.action.type, success: r?.ok ?? false,
        latencyMs: r?.latencyMs ?? 0, errorCode: r?.errorCode ?? (a.policy.allowed ? undefined : a.policy.code), at }));
      if (r?.errorCode !== "LOG_FAILED") return a;
      return { ...a, result: { actionId: a.action.id, ok: false, verified: false, errorCode: "UNKNOWN", latencyMs: 0, message: "조작 기록을 남기지 못했습니다." } };
    });
    const suggestions = (out.publicSuggestions ?? []).filter(label => VOCAB.has(label));
    const approvalReply = stopped ? undefined : approvalNarration(approvalNotice, this.lang, speech, shown?.speech);
    const result = parseTurnResult({
      sessionId: this.id, turnId: turn.id, userUtterance: turn.original ?? turn.text, localSpeechOnly: localSpeechOnly ? true : undefined,
      intentType: turn.intentType, state, stopGeneration: state === "STOPPED" ? this.#queue.epoch : undefined,
      semanticAction: out.semanticAction, publicSuggestions: suggestions.length > 0 ? suggestions : undefined,
      field: out.field, value: out.value, page: view?.pageId, accessMode: view === undefined ? undefined : this.web.guard.tierOf(view.url),
      speech: approvalReply ?? speech, lang: approvalReply === undefined ? out.lang ?? "ko" : this.lang, trace: turn.trace,
      actions: this.lang === "ko" ? actions : actions.map(a => approvalAction(a, this.lang)),
      observation: this.summarize(view), verification: out.verification,
      review: out.review, pendingConfirmation: shown?.card ?? d.confirmation, authHandoff: d.authHandoff?.public(), handoff: out.handoff,
      answerCard: stopped ? undefined : out.answerCard, introScript: stopped ? undefined : out.introScript,
      sources: out.sources ?? [], missingFields: out.missingFields ?? [], pendingActions: 0, realSubmission: false,
      flags: { secretDetected: out.secretDetected === true, masked: out.masked === true }, latencyMs: Math.floor(performance.now() - turn.started),
      speechPrefs: this.personal.speech(), researchDelivery: stopped || d.confirmation !== undefined || d.authWaiting ? undefined :
        out.researchDelivery ?? (turn.researchOutcome === true || this.#pendingResearch?.turnId === turn.id ? "outcome" : undefined),
      // 응답 말은 뒤에서 대화 언어로 옮겨지므로 버튼 이름도 대화 언어로
      offeredChoices: offer?.keys.map(key => ({ key, label: choiceLabel(key, this.lang, offer.authKind) })),
    });
    if (result.researchDelivery === undefined && this.#pendingResearch?.turnId === turn.id) this.#pendingResearch = undefined;
    if (result.lang === this.lang || this.deps.llm === undefined) this.#keepResearch(result);
    return result;
  }

  /** 이 응답이 어느 공공기관 일이었는지 적어 둔다. 다음 공공업무 판단과 이어 묻는 말이 읽는다. */
  #rememberPublicTurn(turn: Turn, out: Draft, state: SessionState, view: View | undefined, userText: Redacted, reply: Redacted) {
    if (turn.ctx.browsingScope === "personal-inspection") return;
    const lookup = turn.ctx.publicLookup;
    const clip = (text: string, size: number) => Array.from(this.#dialogueText(text)).slice(0, size).join("");
    const known = this.publicTask.agency ?? "";
    let label = "";
    if (lookup && out.semanticAction === "web-answer") {
      label = known;
      if (label.length === 0) this.#pushPublicTurn({ turnId: turn.id, agency: null, request: clip(userText, 180), reply: clip(reply, 200) });
    } else if (state === "BROWSING" && view !== undefined && ["GOAL", "OPEN_SITE", "SEARCH_WEB", "FOLLOW_LINK"].includes(turn.intentType)) {
      label = siteLabel(view.url);
    } else if (lookup && turn.intentType === "POLICY_QUESTION" && (out.sources ?? []).length > 0) {
      label = known.length > 0 ? known : "복지로";
    }
    const agency = PUBLIC_AGENCIES.get(label);
    if (agency === undefined) return;
    const text = this.historySpeech(turn.text);
    const active = this.publicTask;
    const previous = this.activeService?.[0] === agency.label ? this.activeService[1] : "";
    const subject = lookup && (known.length === 0 || known === agency.label) ? active.subject : "";
    const topic = [serviceTopic(agency, subject), serviceTopic(agency, text), previous].find(found => found.length > 0) ?? "";
    this.activeService = [agency.label, topic];
    if (!lookup && (known !== agency.label || (active.question.length > 0 && turn.intentType === "OPEN_SITE"))) {
      this.publicTask = new PublicTask({ agency: agency.label, subject: topic, revision: active.revision + 1 });
    }
    this.#pushPublicTurn({ turnId: turn.id, agency: agency.label, request: clip(text, 180), reply: clip(reply, 200) });
    try { this.deps.rememberService?.(agency.label, topic); }
    catch (error) {
      // 이 대화는 저장 공간을 쓸 수 없을 때에도 계속한다.
      if (!(error instanceof Error && "code" in error)) throw error;
    }
  }

  #pushPublicTurn(entry: PublicTurn) {
    this.publicTurns.push(entry);
    if (this.publicTurns.length > 4) this.publicTurns.shift();
  }

  /** 답 길이가 '짧게'이면 긴 답을 첫 두 문장까지 줄인다. 말하기 설정 명령 답은 그대로. */
  #trimSpeech(speech: string): string {
    if (this.personal.speech().length !== "short" || Array.from(speech).length < 100) return speech;
    // 설정 알려 주는 문장은 줄이지 않는다
    if (speech.includes("말하는 속도") || speech.includes("말하기 설정")) return speech;
    const parts = speech.split(sessionPatterns.sentences).map(strip).filter(s => s.length > 0);
    return parts.length <= 2 ? speech : parts.slice(0, 2).join(" ");
  }

  /** 화면 관찰을 UI/로그용으로 요약하면서 개인정보 마스킹 규칙을 적용한다. */
  summarize(view?: View) {
    if (view === undefined) return undefined;
    const hidden = this.dialogue.authWaiting || stillNeedsAuth(view);
    const url = hidden ? tryUrl(view.url) : undefined;
    const fields = view.fields.map(f => {
      // 비밀번호·인증번호·주민등록번호 같은 칸은 화면 종류와 상관없이 값을 남기지 않는다
      if (hidden || f.sensitive || guardPatterns.secretLabel.test(f.label)) return { ...f, value: "" };
      return { ...f, value: this.web.field(f.fieldId)?.maskOnReadback === true && f.value.length > 0 ? maskValue(f.value) : f.value };
    });
    return omitAbsent({
      page: view.pageId, url: url === undefined ? view.url : `${url.origin}${url.pathname}`, title: hidden ? "직접 인증" : view.title,
      step: view.step, errors: hidden ? [] : view.errors, status: hidden ? undefined : view.status, fields,
    });
  }

  // ---------------------------------------------------------------- 라우팅

  privateValuesForRedaction(): string[] {
    const secrets = new Set(Object.values(this.personal.vault()));
    // 부르는 이름도 금고 값처럼 LLM에 가는 기록에는 넣지 않는다
    for (const name of [this.personal.callName(), this.firstRun.pendingName]) {
      if (name !== undefined && name.length > 0) secrets.add(name);
    }
    const pending = this.dialogue.vaultConfirm;
    if (pending?.kind === "vault-save") for (const value of Object.values(pending.values)) secrets.add(value);
    return [...secrets].filter(value => value.length > 0).sort(byLengthDesc);
  }

  #withoutSecrets(speech: string): string { return replaceValues(speech, this.privateValuesForRedaction()); }

  /** 보조 턴 기록용: 금고에 있거나 저장 확인 대기 중인 값을 [비공개]로 바꾼다(들은 말은 그대로). */
  historySpeech(speech: string): Redacted { return redactText(this.#withoutSecrets(speech)); }

  modelSpeech(speech: string): Redacted { return publicDestinations(this.historySpeech(speech)).text; }

  /** 금고 값이 들어 있지 않은 글인지 */
  speakable(text: string): boolean { return this.#withoutSecrets(text) === text; }

  /** 값이 개인 정보라고 밝혀지기 전에 이미 대화에 나왔을 수 있다. */
  redactEarlierMentions(mentioned: readonly string[]) {
    const values = [...new Set(mentioned.filter(value => value.length > 0))].sort(byLengthDesc);
    if (values.length === 0) return;
    this.need.forget(values);
    for (const item of this.#researchReceipts.values()) {
      if (values.some(value => item.speech.includes(value))) item.speech = RESEARCH_UNDELIVERED[item.lang];
    }
    for (const entry of this.#history) entry.text = redactText(replaceValues(entry.text, values));
    for (const entry of this.#plannerTurns) {
      const { user, assistant } = entry.exchange;
      entry.exchange = { ...entry.exchange, user: replaceValues(user, values), assistant: replaceValues(assistant, values) };
    }
    for (const entry of this.publicTurns) {
      entry.request = replaceValues(entry.request, values);
      entry.reply = replaceValues(entry.reply, values);
    }
    const task = this.publicTask;
    if ([task.goal, task.subject, task.question, ...task.facts, ...task.exclusions, ...task.choices].some(field => values.some(value => field.includes(value)))) {
      this.publicTask = new PublicTask({ revision: task.revision + 1 });
    }
    const topic = this.activeService?.[1];
    if (topic !== undefined && values.some(value => topic.includes(value))) this.activeService = undefined;
  }

  recentDialogue(n = 6) {
    return this.#history.slice(-n).map(row => historyLine(row.role, this.modelSpeech(row.text)));
  }

  get history(): readonly HistoryRow[] { return this.#history; }

  #possibleSecret(): Draft {
    return draft(this.state, "auth-handoff", FIXED[this.dialogue.authWaiting ? "possibleSecretAuth" : "possibleSecret"][this.lang],
      { lang: this.lang, secretDetected: true });
  }

  #handleSecret(sensitive: Detection): Draft {
    const auth = sensitive.kinds.some(k => k === "password" || k === "otp") || this.state === "AUTH_HANDOFF";
    return draft(auth ? "AUTH_HANDOFF" : this.state, "auth-handoff",
      disclosureNotice(sensitive.kinds, this.web.currentView?.pageId === "mock-login"), { secretDetected: true });
  }

  /**
   * 비밀번호를 키워드 없이 값만 말했을 수 있는 순간(본인인증 인계 중, 로그인 화면, 직전에 비밀번호를 언급)의
   * 명령이 아닌 짧은 말은 비밀값일 수 있다: LLM·기록에 넘기지 않는다(예: 로그인 화면에서 "사과나무").
   * 같은 말을 바로 한 번 더 하면 명령으로 보고 통과시킨다. 번역하기 전 원문에 적용한다.
   */
  #maybeSpokenSecret(text: string, hint: boolean): boolean {
    const d = this.dialogue;
    if (!hint && this.state !== "AUTH_HANDOFF" && this.web.currentView?.pageId !== "mock-login") {
      this.#secretGuarded = undefined;
      return false;
    }
    // 값을 기다리는 칸(비밀이 아닌 칸)·칸 채우기·금고 확인·맞춤 찾기 질문의 대답이면 그쪽이 받는다
    const answering = (d.awaiting !== undefined && d.awaiting.length > 0) || d.guided !== undefined || d.vaultConfirm !== undefined ||
      (d.profileQuestion !== undefined && d.profileQuestion.length > 0);
    if (!hint && answering) return false;
    const t = strip(text.replace(sessionPatterns.phraseEnd, ""));
    if (t.length === 0 || (Array.from(t).length > 30 && t.includes(" ")) || isQuestionLike(t) || ackKind(t) !== undefined || doneReply(t, { whole: true })) return false;
    if (d.expectsConfirmation && approval(text, this.lang) !== undefined) return false;
    if (detectLangSwitch(t) !== undefined || guardianRequest(t, this.web.guard.directActions) !== undefined || parsePersonalCommand(t, this.today) !== undefined) return false;
    if (this.rules.parseSync(t, { state: this.state }).type !== "UNKNOWN") return false;
    // 원문 대신 해시만 기억한다(비밀값일 수 있으므로)
    const digest = createHash("sha256").update(t, "utf8").digest("hex");
    if (this.#secretGuarded === digest) {
      this.#secretGuarded = undefined;
      return false;
    }
    this.#secretGuarded = digest;
    return true;
  }

  /** 이번 턴의 대화 상태를 붙여 말 이해(understanding/understand.ts)에 맡긴다. */
  async understand(text: Redacted, turn: Turn, { maxSteps = 6 }: { maxSteps?: number } = {}): Promise<Understood> {
    const awaiting = this.dialogue.awaiting !== undefined && this.dialogue.awaiting.length > 0 ? this.dialogue.awaiting : undefined;
    const current = this.web.currentView;
    const need = this.dialogue.hasPendingInteraction ? undefined : this.need.context();
    const followup = this.deps.llm === undefined || need === undefined ? this.planner.followup(text) : undefined;
    if (this.web.guard.directActions && !this.dialogue.hasPendingInteraction && current?.pageId === "external") {
      const name = requestedControl(text);
      if (name !== undefined && current.outline?.items?.some(item => !item.disabled && item.name === name) === true) {
        return {intents: [{type: "FOLLOW_LINK", name}], by: "rules"};
      }
    }
    if (followup !== undefined) return { intents: [{ type: "GOAL", goal: followup }], by: "context" };
    const understood = await this.understanding.understand(text, { state: this.state, need,
      avatarControl: this.deps.setAvatarVisible !== undefined && !this.dialogue.hasPendingInteraction,
      awaitingFieldId: awaiting === undefined ? undefined : redactText(awaiting) }, {
      awaited: awaiting === undefined ? undefined : this.web.field(awaiting), clarifying: this.dialogue.clarification !== undefined,
      page: current === undefined ? undefined : this.modelSpeech(current.title), recent: this.recentDialogue(4), maxSteps,
      trace: note => turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, note),
    });
    if (awaiting === undefined && understood.intents.length === 1 && understood.intents[0]?.type === "UNKNOWN" && sessionPatterns.goThere.test(text)) {
      const name = requestedSiteName(text);
      if (name !== undefined && !this.dialogue.hasPendingInteraction) {
        if (current?.outline?.items?.some(item => !item.disabled && item.name === name) === true &&
            !/(?:누리집|사이트|홈페이지)/u.test(text)) {
          return { intents: [{ type: "FOLLOW_LINK", name }], by: "rules" };
        }
        return { intents: [{ type: "OPEN_SITE", target: text }], by: "rules" };
      }
      const direct = await this.deps.welfare.resolveSiteLink(text, { ctpv: this.profile.ctpv, sgg: this.profile.sgg });
      if (direct?.url !== undefined && direct.url.length > 0) return { intents: [{ type: "OPEN_SITE", target: text }], by: "direct-link" };
    }
    return understood;
  }

  /** 여러 명령을 차례로 실행. 확인·승인이 필요한 단계에서 멈추고 남은 일을 알려 준다. */
  async runPlan(intents: readonly Intent[], turn: Turn): Promise<Draft> {
    const drafts: Draft[] = [];
    for (const [i, intent] of intents.entries()) {
      if (this.superseded(turn)) break;
      turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, `단계 ${i + 1}/${intents.length}: ${intent.type}`);
      let step = turn;
      if (intent.type === "UNKNOWN") step = { ...turn, text: redactText(intent.text) };
      else if (intent.type === "FIND_PLACE") {
        const parts = this.rules.splitCommands(turn.text);
        const part = parts[i];
        if (parts.length !== intents.length || part === undefined) {
          drafts.push(draft(this.state, "clarify", "찾으시는 기관 이름과 지역을 함께 다시 말씀해 주세요."));
          break;
        }
        step = { ...turn, text: redactText(part) };
      }
      const d = await this.route(intent, step, { plannedQuestion: intent.type === "UNKNOWN" });
      drafts.push(d);
      if (PLAN_STOP_STATES.has(d.state) || d.semanticAction === "consent" || this.dialogue.placeAsk !== undefined) break;
    }
    const last = drafts.at(-1);
    if (last === undefined) return draft("STOPPED", "stop", "멈췄어요.");
    const said = (d: Draft) => d.summary ?? d.speech;
    const parts = drafts.length > 1 && intents.every(intent => QUESTION_TYPES.has(intent.type))
      ? drafts.map((d, i) => `${i + 1}. ${said(d)}`) : [...drafts.slice(0, -1).map(said), last.speech];
    const skipped = intents.length - drafts.length;
    if (skipped > 0) parts.push(`나머지 ${skipped}가지 요청은 이것부터 해결한 뒤 다시 말씀해 주세요.`);
    return {
      ...last, summary: undefined, speech: parts.filter(part => part.length > 0).join(" "),
      actions: drafts.flatMap(d => d.actions ?? []), sources: drafts.flatMap(d => d.sources ?? []),
      ...(drafts.some(d => d.privateHistory === true) ? { privateHistory: true } : {}),
      ...(drafts.some(d => d.pictureHistory !== undefined && d.pictureHistory.length > 0) ? { pictureHistory: "화면 사진 설명 요청을 처리했어요." } : {}),
    };
  }

  async route(intent: Intent, turn: Turn, { plannedQuestion = false, exclusions, confirmPicture = false }: {
    plannedQuestion?: boolean; exclusions?: readonly string[]; confirmPicture?: boolean;
  } = {}): Promise<Draft> {
    if (intent.type === "FOLLOW_LINK" && turn.staleLinkOffer) return this.changedLinkReply();
    if (this.web.guard.directActions && ["FOLLOW_LINK", "FILL", "LOGIN", "PREPARE_SUBMIT", "OPEN_SITE", "NEXT"].includes(intent.type)) {
      const limit = interactionLimit(turn.text, intent.type === "FOLLOW_LINK" ? intent.name : undefined);
      if (limit === "decline") return draft(this.state, "none", "현재 화면을 그대로 둘게요.");
      if (limit === "question") return draft(this.state, "chat", "현재 화면에서 확인할 수 있는 안내를 읽어 드릴 수 있어요. 누른 뒤의 결과는 아직 확인할 수 없어요.");
    }
    // 모델이 풀어 쓴 질문을 번호 선택이나 입력 칸의 값으로 받아들이지 않는다.
    if (plannedQuestion) {
      const refused = this.consentGate(intent);
      if (refused !== undefined) return refused;
      const before = this.web.currentView;
      return this.browse.recognizeAuthPage(await this.replies.freeChat(turn.text, turn), before, turn.ctx);
    }
    // '복지루·복지관에서'처럼 사이트 이름이 한 글자 다르면 가기 전에 소리로 확인한다(주인 결정 2026-11-19)
    if (intent.type === "GOAL" || intent.type === "OPEN_SITE") {
      const guess = nearSiteGuess(turn.text, this.browse.mockSites());
      if (guess !== undefined) {
        const [site, word] = guess;
        this.dialogue.askSite({ text: turn.text.replace(word, () => site.label), label: site.label });
        return draft(this.state, "clarify", `'${site.label}' 말씀이세요? 맞으면 '네', 아니면 '아니'라고 말씀해 주세요.`);
      }
    }
    // 되묻기에 대한 답(예: "실거주지 주소")
    const clarification = this.dialogue.clarification;
    const shortReply = Array.from(turn.text).length <= 20 && !sessionPatterns.digit.test(turn.text);
    if (clarification !== undefined && (shortReply || intent.type === "UNKNOWN")) {
      const picked = this.web.pickCandidate(turn.text, clarification.candidates);
      if (picked !== undefined) {
        this.dialogue.clearChoice();
        const run = clarification.reviewedTask;
        if (run instanceof ReviewedTask) {
          const view = await this.web.observe(turn.ctx);
          if (this.#consent !== "granted" || turn.ctx.signal.aborted || view.url !== clarification.reviewedUrl) {
            return draft(this.state, "none", "입력할 페이지가 바뀌어 작업을 중단했어요.");
          }
          turn.ctx = withContext(turn.ctx, { counter: run.counter, actionLimit: REVIEW_LIMITS[run.difficulty][2] });
          return this.review.run(run, turn, await this.form.fillOne(picked, clarification.value, turn.ctx));
        }
        return this.form.fillOne(picked, clarification.value, turn.ctx);
      }
    }
    if (intent.type !== "UNKNOWN") this.dialogue.clearChoice();

    // 맞춤 찾기 목록 속 제도를 가리키면("1번 신청하고 싶어", "너가 찾은 기장군 교통비 지원") 그 제도로 이어 간다.
    // (링크 목록을 막 읽어 준 뒤의 "2번"은 링크 고르기라 제외)
    const listJustRead = this.lastSemantic === "list-links" || this.lastSemantic === "describe-picture" ||
      (this.lastSemantic === "describe-screen" && this.browse.linkChoices !== undefined);
    const welfare = this.deps.welfare;
    if (welfare.hasMatches && !listJustRead && ["START_APPLICATION", "DISCOVER", "UNKNOWN", "POLICY_QUESTION"].includes(intent.type)) {
      const hit = welfare.findInMatches(turn.text);
      if (hit !== undefined) {
        welfare.pick(turn.text);
        this.grounded = undefined;
        turn.ctx.trace("PLANNING", AGENT_IDS.welfare, `찾기 결과에서 고름: ${hit.servNm}`);
        if (sessionPatterns.applyMatch.test(turn.text)) intent = { type: "START_APPLICATION" };
        else if (intent.type !== "POLICY_QUESTION") return this.replies.welfareDraft(await welfare.serviceDetail(hit.servNm), "discover");
      }
    }
    const refused = this.consentGate(intent);
    if (refused !== undefined) return refused;
    const before = this.web.currentView;
    return this.browse.recognizeAuthPage(await this.dispatch(intent, turn, exclusions, confirmPicture), before, turn.ctx);
  }

  /** 의도 종류 → 처리(동의 문을 지난 뒤). 의도 표의 종류가 모두 있는지는 registry 테스트가 본다. */
  async dispatch(intent: Intent, turn: Turn, exclusions: readonly string[] = [], confirmPicture = false): Promise<Draft> {
    const ctx = turn.ctx;
    const welfare = this.deps.welfare;
    const discoverySubject = this.lastSemantic === "discover" ? welfare.discoverySubject : undefined;
    if (intent.type === "SHOW_AVATAR" || intent.type === "HIDE_AVATAR") {
      const visible = intent.type === "SHOW_AVATAR";
      const updated = await this.deps.setAvatarVisible?.(visible, ctx.signal);
      return draft(this.state, "none", updated === true ? (visible ? "마스코트를 다시 열었어요." : "마스코트를 닫았어요.") : "마스코트 창을 변경할 수 없었어요.");
    }
    switch (intent.type) {
      case "START_APPLICATION": return this.application.start(turn);
      case "OPEN_OFFICIAL": return this.application.openOfficial(intent.service, turn);
      case "LOGIN": return this.browse.login(turn.text, ctx);
      case "CLEAR_LOGIN": return this.browse.clearLogin(ctx);
      case "READ_DOWNLOAD": return this.browse.readDownload(intent, turn.text, ctx);
      case "AUTH_DONE": return this.browse.authDone(ctx);
      case "FILL": return this.form.fill(intent.fills, ctx);
      case "READ_FIELD": return this.replies.readField(intent.fieldMention, turn);
      case "EDIT_FIELD": return this.form.editField(intent.fieldMention, ctx);
      case "NEXT": return this.web.guard.directActions && this.web.currentView?.pageId === "external"
        ? this.browse.followLink("다음", ctx) : this.form.next(ctx);
      case "PREV": return isFormOpen(this.web.currentView) ? this.form.prev(ctx) : this.browse.back(ctx);
      case "OPEN_SITE": return this.browse.openSite(intent.target, ctx);
      case "FOLLOW_LINK": return this.browse.followLink(intent.name, ctx);
      case "READ_MAIN": return this.browse.readMain(intent.more, ctx);
      case "LIST_LINKS": return this.browse.listLinks(intent.more, ctx);
      case "SEARCH": return this.browse.search(intent.query, intent.site, ctx);
      case "REVIEW": return this.form.review(ctx);
      case "EXPLAIN": return this.application.explain(intent.fieldMention, turn);
      case "PREPARE_SUBMIT": {
        const send = /(?:접수|제출)(?:을|를)?\s*(?:해\s*(?:줘요?|주세요|주실래요?|주시겠어요?)|하자|할게요?|진행해\s*(?:줘요?|주세요))[.!?。？！~]*$/u.exec(turn.text.trim());
        if (this.web.guard.directActions && this.web.currentView?.pageId === "external") {
          return send ? this.browse.followLink(send[0].startsWith("접수") ? "접수" : "제출", ctx) : this.browse.readMain(false, ctx);
        }
        return this.form.prepareSubmit(ctx, send !== null);
      }
      case "APPROVE": return this.#approve(turn);
      case "REJECT": return this.form.reject();
      case "RESUME": return this.#offer?.navigationHandoff === undefined ? this.browse.resume(ctx) : this.#resumeNavigation(this.#offer.navigationHandoff, turn);
      case "CURRENT_STEP": return this.browse.currentStep(ctx);
      case "DESCRIBE_PICTURE": return this.browse.picture(intent.question, ctx);
      case "DESCRIBE_SCREEN": return this.replies.describeScreen(turn, exclusions, confirmPicture);
      case "ABOUT_SITE": return this.browse.aboutSite();
      case "REPHRASE": return this.replies.rephrase(turn);
      case "GOAL": return this.review.goal(intent.goal, turn, exclusions);
      case "DISCOVER": return this.replies.discover(turn);
      case "FIND_PLACE": return this.replies.findPlace(turn);
      case "SERVICE_DETAIL": return this.replies.welfareReply(welfare.serviceDetail(intent.service ?? discoverySubject), "discover");
      case "PRECHECK": return this.replies.welfareSteps(welfare.precheck(intent.service ?? discoverySubject, this.profile), "precheck", turn);
      case "PREPARE_APPLY": return this.replies.welfareSteps(welfare.prepare(intent.service ?? discoverySubject), "prepare-apply", turn);
      case "OPEN_BROWSER": return this.replies.openBrowser(turn);
      case "POLICY_QUESTION": return this.replies.policyQuestion(intent.topic, turn);
      case "HELP_HUMAN": return this.replies.helpHuman();
      case "READ_START_GUIDE": return draft(this.state, "help", START_GUIDE);
      case "WHAT_CAN_I_SAY": return this.replies.whatCanISay(intent.more);
      case "INTRO_REPLAY": return this.firstRun.introDraft({ replay: true });
      // 화면이 처음 설정을 연다(화면이 intentType을 보고). 동의 전에도 된다.
      case "SETUP_RESTART": return draft(this.state, "help", "처음 설정을 다시 열게요. 숫자 키와 Enter로 답해 주세요.");
      case "STOP": return draft("STOPPED", "stop", "멈췄습니다.");
      // 보통은 handleTurn이 대기열 앞에서 답한다. 여기 오는 것은 여러 명령·질문 속의 물음뿐(대기열은 이 턴 자신이 잡고 있다).
      case "PROGRESS": return this.progressDraft(false);
      case "UNKNOWN": return this.replies.unknown(redactText(intent.text), turn);
    }
  }
}
