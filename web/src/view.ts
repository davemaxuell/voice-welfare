import { koreanConsentGuide } from "./onboarding-text.ts";
// 화면 상태 → 화면에 보일 것. Python app.js의 render()가 하던 판단을 DOM 없이 계산한다(App.tsx는 이 결과만 그린다).
import { STATE_LABELS_KO, type Lang, type SessionState } from "../../src/core/turn.ts";
import type { AnswerCard, IntroPose, ObservedField, Source } from "./api.ts";
import { APPROVE_LABELS, type Consent, type Decision, type LastTurn } from "./companion.ts";
import type { Microphone } from "./mic.ts";
import { fullGuide } from "./onboarding.ts";
import { workspaceText } from "./workspace-language.ts";

import { presentationOf, issues, issueActions, type Capture, type Phase, type IssueKey } from "./presentation.ts";
export type { Phase } from "./presentation.ts";

export const EXAMPLES = [
  "장애인연금 신청 도와줘",
  "이름은 김하늘",
  "주소는 부산광역시 예시구 예시로 10",
  "주소 다시 읽어줘",
  "다음으로",
  "이 항목은 무슨 뜻이야?",
  "화면 설명해줘",
  "복지로 열어줘",
  "정부24에서 주민등록등본 발급 방법 찾아줘",
  "장학재단에서 국가장학금 신청 기간 알려줘",
  "국민신문고 열어줘",
  "본문 읽어줘",
  "링크 목록 알려줘",
  "장애인연금 얼마 받아?",
  "지금까지 쓴 내용 읽어줘",
  "모의 접수 내용을 확인했어",
];

export const UNSUPPORTED = ["실제 사이트에서의 제출·로그인·본인인증(사용자가 직접)", "사람 상담 연결"];

/** 처음 화면의 요청 예시. consent가 있으면 그 동의 상태에서만 보인다. */
export const STARTERS: readonly { request: string; label: string; art: string; consent?: Consent }[] = [
  { request: "장애인연금 얼마 받아?", label: "장애인연금 알아보기", art: "pension-art" },
  { request: "복지로 열어줘", label: "복지로 열기", art: "site-art", consent: "granted" },
  { request: "정부24에서 주민등록등본 발급 방법 찾아줘", label: "정부24 민원 찾기", art: "gov-art", consent: "granted" },
  { request: "장학재단에서 국가장학금 신청 안내 찾아줘", label: "국가장학금 알아보기", art: "scholar-art", consent: "granted" },
  { request: "화면 설명해줘", label: "화면 설명 듣기", art: "screen-art", consent: "granted" },
  { request: "장애인연금 지원 대상이 누구야?", label: "지원 대상 알아보기", art: "site-art", consent: "declined" },
  { request: "장애인연금 신청할 때 필요한 서류가 뭐야?", label: "준비 서류 알아보기", art: "screen-art", consent: "declined" },
];

export const GREETINGS: Readonly<Record<Lang, string>> = {
  ko: "무엇을 도와드릴까요? 띵 소리 뒤에 말씀하세요.",
  en: "How can I help? Speak after the tone.",
  zh: "需要什么帮助？请在提示音后说话。",
  ja: "どのようなお手伝いが必要ですか。合図のあとにお話しください。",
};

export interface VoiceMode {
  sttProvider?: string | undefined; ttsProvider?: string | undefined;
  known: boolean; stt: boolean; tts: boolean; edge?: string | undefined; label: string;
  llmRoles: Readonly<Record<string, string | null>>;
}
/** 데스크톱 백그라운드 실행(창 없이 단축키로만)인지, Mac 키 이름을 쓸지. 동의 안내 문장이 달라진다. */
export interface Env { background: boolean; mac: boolean }

export interface LogEntry {
  id: string;
  role: "user" | "assistant" | "system";
  who: string;
  lang?: string | undefined;
  text: string;
  summary?: string;
  /** 시작 안내와 동의 기록(하나만): 다시 듣기 단추 이름(음성 안내가 있을 때)과 덧붙인 결과 */
  consentRecord?: { replay?: string; outcomes: { text: string; lang: Lang }[] };
}
export type CardView = Decision & { id: string; lang: string };
export interface Recovery { choice: "resume" | "retry" | "new"; title: string; message: string; yes: string; no: string; busy: boolean }
export interface FocusRequest { id: string; seq: number; scroll?: string; fallback?: string }

export interface UiState {
  sessionId?: string | undefined;
  state: SessionState;
  last?: LastTurn | undefined;
  lang: Lang;
  busy: boolean;
  hasTurn: boolean;
  practiceMode: boolean;
  workspaceAvailable: boolean;
  settingsAvailable: boolean;
  listening: boolean;
  voiceMode: VoiceMode;
  tts: boolean;
  contrast: boolean;
  error?: IssueKey | undefined;
  offline?: boolean;
  cancelUnconfirmed?: boolean;
  phase: Phase;
  baseSpeed: number;
  consent: Consent | undefined;
  mics: Microphone[];
  micId?: string | undefined;
  /** 대화 창 밖 상태(Python의 desk·모듈 변수 중 화면에 나오는 것) */
  speaking: boolean;
  capture?: Capture;
  stopping?: boolean;
  sleeping?: boolean;
  card?: CardView | undefined;
  cardTaken: boolean;
  recovery?: Recovery | undefined;
  sessionNew: boolean;
  checkingMic: boolean;
  micCheckResult: string;
  edge: boolean;
  conversationMode: "native" | "dictate";
  intro?: { text: string; pose: IntroPose } | undefined;
  liveCaption: string;
  /** 긴 일이 진행되는 동안 보여주는 한 줄. 없으면 칸을 숨긴다. */
  activity?: string | null;
  messages: LogEntry[];
  announcement: { text: string; seq: number };
  focus?: FocusRequest | undefined;
}

/** 진행 응답에서 화면에 보일 줄과, 끝났을 때만 읽을 줄을 고른다. 사실 단계 문장은 읽지 않는다. */
export function progressUpdate(
  p: { activity?: string | null; activitySpoken?: boolean; activitySeq?: number; running?: boolean; spoken?: boolean; seq?: number; latest?: string | null },
  previousSeq: number,
): { activity: string | null; speak?: string; seq: number } {
  const activity = p.activity ?? null;
  const seq = p.activitySeq ?? p.seq ?? previousSeq;
  const speak = p.spoken !== false && p.activitySpoken === true && activity !== null && activity.length > 0 && seq > previousSeq ? activity : undefined;
  return { activity, speak, seq };
}

export function dictationHelp(lang: string) {
  return workspaceText("음성 입력과 안내를 쓰려면 이용 설정에 OpenAI API 키를 등록해 주세요. 글로도 질문할 수 있어요.", lang);
}

export function voiceRouteText(ui: Pick<UiState, "voiceMode" | "lang">) {
  const t = (text: string) => workspaceText(text, ui.lang);
  if (!ui.voiceMode.known) return t("음성 설정을 확인하고 있어요.");
  if (!ui.voiceMode.stt && !ui.voiceMode.tts) return dictationHelp(ui.lang);
  return t("음성 입력과 안내 문장은 음성 API로 전송됩니다. 청음은 녹음을 저장하지 않습니다.") +
    (ui.voiceMode.edge !== undefined && ui.voiceMode.edge.length > 0 ? " " + t("실시간 음성 대화를 시작할 때는 감지된 개인정보를 가린 최근 대화 일부도 OpenAI로 보냅니다.") : "");
}

const ROLE_LABELS: Readonly<Record<string, string>> = { understand: "말씀 이해", goal: "목표 수행", web: "화면·검색 요약" };
/** 역할별 LLM이 어디로 가는지(/api/health.llmRoles). rules·mock은 밖으로 안 나감. */
export function llmRouteText(ui: Pick<UiState, "voiceMode"> & { lang?: Lang }) {
  const t = (text: string) => workspaceText(text, ui.lang);
  if (!ui.voiceMode.known) return t("질문과 화면에서 읽은 글은 이해와 요약을 위해 외부 인공지능 서비스로 전송될 수 있습니다.");
  const external = Object.entries(ui.voiceMode.llmRoles)
    .filter((entry): entry is [string, string] => Object.hasOwn(ROLE_LABELS, entry[0]) && entry[1] !== null && entry[1].length > 0 && !/^(rules|mock)/i.test(entry[1]))
    .map(([k, v]) => workspaceText("{role}은 {provider}", ui.lang, { role: t(ROLE_LABELS[k] ?? k), provider: v }));
  if (external.length === 0) return t("글 이해는 이 컴퓨터의 규칙으로만 처리합니다.");
  return workspaceText("글 이해에 쓰는 인공지능은 역할마다 다를 수 있어요. {roles}.", ui.lang, { roles: external.join(", ") });
}

/** 시작 동의 안내: 무엇을 하는지, 무엇이 외부로 나가는지, 무엇을 하지 않는지, 어떻게 멈추는지 */
export function consentText(ui: Pick<UiState, "voiceMode" | "lang">, env: Env, lang: string = ui.lang) {
  const translated = fullGuide(lang, ui.voiceMode, env.background, env.mac ? "Command" : "Control");
  if (translated.length > 0) return translated;
  return koreanConsentGuide(ui.voiceMode.llmRoles.vision === "disabled", voiceRouteText(ui), llmRouteText(ui), env.background, env.mac);
}

const MODE_LABELS: Readonly<Partial<Record<string, readonly [string, string, string]>>> = {
  ko: ["대화 방식", "말하는 중에도 끼어드는 실시간 대화", "한 번씩 받아쓰고 답변 듣기"],
  en: ["Voice mode", "Talk live and interrupt anytime", "Transcribe each turn and hear a reply"],
  ja: ["音声モード", "話の途中でも割り込めるリアルタイム会話", "発話ごとに文字起こしして応答"],
  zh: ["语音模式", "可随时打断的实时对话", "逐次转写并朗读回答"],
};

const ORIGIN_LABELS: Readonly<Record<AnswerCard["dataKind"], string>> = { live: "공식 API 실시간 조회", stored: "저장된 자료", "private-program": "공공데이터에 실린 민간 사업" };

export interface FieldRow { key: string; name: string; between: string; value: string; after: string; state: "invalid" | "private" | "filled" | "empty" }
export interface ActionRow { key: string; reason: string; result: string; resultIsWords: boolean; state: "blocked" | "ok" | "failed" }

function fieldRow(f: ObservedField, i: number, t: (text: string) => string): FieldRow {
  // 화면에는 이름과 값만 보이고(상태는 아이콘), 화면 낭독기는 예전 문장 그대로 듣는다
  return {
    key: `${f.label}-${i}`,
    name: f.label,
    between: ` ${f.required ? t("(필수)") : ""} — ${!f.sensitive && f.filled ? t("입력됨:") + " " : ""}`,
    value: f.sensitive ? t("직접 입력 항목") : f.filled ? f.value ?? "" : t("비어 있음"),
    after: f.invalid ? " " + t("· 오류") : "",
    state: f.invalid ? "invalid" : f.sensitive ? "private" : f.filled ? "filled" : "empty",
  };
}

export function stageOf(ui: UiState) {
  const sessionReady = ui.sessionId !== undefined && ui.recovery === undefined && (ui.consent === "granted" || ui.consent === "declined");
  return { sessionReady, stage: sessionReady ? (ui.hasTurn ? "active" : "ready") : "onboarding" } as const;
}

export function viewOf(ui: UiState, env: Env) {
  const { sessionId, state, last, listening, voiceMode, tts, contrast, error, phase, consent, mics, lang, card: decision } = ui;
  const busy = ui.busy && ui.offline !== true && ui.cancelUnconfirmed !== true;
  const t = (text: string) => workspaceText(text, lang);
  const hasSession = sessionId !== undefined;
  const recovering = ui.recovery !== undefined;
  const decisionTaken = decision !== undefined && ui.cardTaken;
  const signingIn = last?.authHandoff?.status === "waiting";
  const consentShown = consent === "intro" || consent === "ask";
  const { sessionReady, stage } = stageOf(ui);

  const display = presentationOf(ui);
  const actions = error === undefined ? [] : [...issues[error][1]];
  if (ui.offline === true && !actions.includes("reconnect")) actions.push("reconnect");
  const phaseLabel = display.phase === phase ? t("음성 대화") + ": " + t(display.phaseKey) : t(display.phaseKey);

  const obs = last?.observation;
  const step = obs?.step;
  const hasStep = step !== undefined && Number.isFinite(step.index) && Number.isFinite(step.total) && step.total > 0;
  const pending = state === "WAITING_FOR_USER_CONFIRMATION" ? last?.pendingConfirmation : undefined;
  const authCard = decision?.kind === "offer" && decision.ref.handoffId !== undefined && decision.ref.handoffId.length > 0 ? decision : undefined;
  const readMain = decision?.kind === "offer" ? decision.choices.find(choice => choice.key === "read-main") : undefined;
  const receipt = state === "MOCK_SUBMITTED" ? last?.verification?.receipt : undefined;
  const answer = last?.answerCard;
  const providers = [
    voiceMode.edge !== undefined && voiceMode.edge.length > 0 && t("실시간 대화") + " " + voiceMode.edge,
    voiceMode.sttProvider !== undefined && voiceMode.sttProvider.length > 0 && t("받아쓰기") + " " + voiceMode.sttProvider,
    voiceMode.ttsProvider !== undefined && voiceMode.ttsProvider.length > 0 && t("음성 안내") + " " + voiceMode.ttsProvider,
  ].filter(Boolean).join(" · ");
  const modeLabels = MODE_LABELS[lang] ?? ["Voice mode", "Live conversation", "Dictate and hear a reply"];

  return {
    appClass: contrast ? "app high-contrast" : "app",
    stage,
    lang,
    practiceBanner: ui.practiceMode,
    openSettings: ui.settingsAvailable,
    tts: { pressed: tts, label: t(tts ? "음성 안내 켜짐" : "음성 안내 꺼짐"), disabled: !voiceMode.tts },
    soundCheckDisabled: !voiceMode.tts,
    consentFullDisabled: !voiceMode.tts,
    contrast: { pressed: contrast, label: t(contrast ? "고대비 켜짐" : "고대비 꺼짐") },
    sessionEndDisabled: !hasSession,
    micCheckDisabled: ui.checkingMic || !hasSession || consent !== "granted" || signingIn || state === "STOPPED",
    micCheckResult: ui.micCheckResult,
    starters: STARTERS.map(s => ({ ...s, hidden: s.consent !== undefined && s.consent !== consent, disabled: !sessionReady || busy })),
    consent: consentShown ? {
      text: consentText(ui, env),
      hear: consent === "intro",
      hearDisabled: !hasSession,
      ask: consent === "ask",
    } : undefined,
    recovery: ui.recovery,
    sessionNew: ui.sessionNew,
    intro: ui.intro,
    conversation: {
      startShown: phase === "off",
      startDisabled: !hasSession || consent !== "granted" || signingIn || !voiceMode.stt,
      endShown: phase !== "off",
      phase: display.phase,
      phaseLabel,
      showPhase: display.task === "idle" || display.task === "working" || display.playback === "speaking" ||
        (display.capture === "on" && (phase === "listening" || phase === "hearing")),
      captureLabel: t(display.captureKey),
      taskLabel: t(display.taskKey),
      hint: phase !== "off" ? t(ui.edge ? "자연스럽게 말씀하세요. 답변 중에도 끼어들 수 있어요." : "띵 소리 뒤에 말씀하세요. 스페이스 키나 박수 두 번으로 안내를 끊거나, 하던 말을 바로 보낼 수 있어요.") : undefined,
      caption: ui.liveCaption,
    },
    mics: mics.length > 1 ? mics : undefined,
    micId: ui.micId ?? "",
    modeChoice: voiceMode.edge !== undefined && voiceMode.edge.length > 0 ? {
      label: modeLabels[0],
      native: modeLabels[1] + " · " + voiceMode.edge,
      dictate: modeLabels[2] + " · gpt-live-transcribe",
    } : undefined,
    error: error === undefined ? undefined : {
      text: t(issues[error][0]), actions: actions.map(key => ({ key, label: t(issueActions[key]) })),
    },
    command: {
      disabled: !hasSession || recovering,
      sendDisabled: !hasSession || busy || recovering || ui.offline === true || ui.cancelUnconfirmed === true,
      busy,
      sendLabel: t(busy ? "처리 중…" : "보내기"),
      typing: busy && hasSession,
      micShown: phase === "off",
      micPressed: listening,
      micDisabled: !hasSession || signingIn || consent !== "granted" || (busy && !listening) || !voiceMode.stt,
      micLabel: t(listening ? "말하기 끝 (보내기)" : "음성 입력"),
      dictation: !sessionReady || consent !== "granted" || voiceMode.stt ? undefined : dictationHelp(lang),
      talkShown: phase !== "off",
      talkDisabled: phase === "starting" || phase === "thinking",
      talkLabel: t(phase === "speaking" ? "지금 말하기 (안내 끊기)" : phase === "hearing" && !ui.edge ? "말 끝 (바로 보내기)" : "듣는 중 — 말씀하세요"),
      help: t("비밀번호, 주민등록번호, 계좌번호는 입력하거나 말하지 마세요."),
      examplesDisabled: !hasSession || recovering || busy,
    },
    voiceDetails: [voiceRouteText(ui), providers.length > 0 ? providers : voiceMode.label, llmRouteText(ui)].filter(Boolean).join(" "),
    status: {
      progress: hasStep ? { max: step.total, value: step.index, ratio: step.index / step.total } : undefined,
      state,
      stateLabel: t(STATE_LABELS_KO[state]),
      step: hasStep ? `${step.index}/${step.total} — ${step.name}` : undefined,
      title: obs?.title !== undefined && obs.title.length > 0 ? obs.title : undefined,
      accessMode: last?.accessMode ?? "none",
      access: last?.accessMode === "full" ? t("지원 사이트(연습 신청 가능)") : last?.accessMode === "read-only" ? t("읽기 전용(읽기·이동·검색만)") : undefined,
      fields: (obs?.fields.filter((f) => f.visible && f.type !== "checkbox") ?? []).map((f, i) => fieldRow(f, i, t)),
      activity: ui.activity ?? null,
    },
    confirm: pending !== undefined ? {
      approveLabel: t(pending.kind !== undefined ? APPROVE_LABELS[pending.kind] : "이 동작 승인"),
      edit: pending.kind === "practice-submission",
      hint: pending.description !== undefined && pending.description.length > 0 ? pending.description : undefined,
      purpose: pending.purpose,
      site: pending.site,
      values: pending.values,
    } : undefined,
    readMain: decision !== undefined && readMain !== undefined ? { id: decision.id, label: readMain.label } : undefined,
    confirmCard: decision?.kind === "approval" ? decision.id : "",
    decisionDisabled: busy || decisionTaken || ui.offline === true || ui.cancelUnconfirmed === true ||
      (pending !== undefined && decision?.kind !== "approval"),
    auth: signingIn ? {
      cardId: authCard?.id ?? last.turnId ?? "",
      viaCard: authCard !== undefined,
      doneLabel: authCard?.choices.find((c) => c.key === "auth-done")?.label ?? t("직접 확인을 마쳤어요"),
    } : undefined,
    receipt: receipt !== undefined && receipt.length > 0 ? receipt : undefined,
    answer: answer !== undefined ? {
      text: answer.answer,
      lang: last?.lang ?? lang,
      source: answer.source,
      origin: answer.dataOrigin === "fixture" ? t("연습용 예시 · 저장된 자료") : t(ORIGIN_LABELS[answer.dataKind]),
      date: answer.dataDate ?? t("자료에 기준일 없음"),
      checked: answer.source.lastCheckedAt,
      next: answer.nextAction,
    } : undefined,
    sources: (last?.sources ?? []).filter((source: Source) => source.url !== answer?.source.url),
    actions: (last?.actions ?? []).map((a, i): ActionRow => {
      const okay = a.policy.allowed && a.result?.ok === true;
      return {
        key: `${a.action.id}-${i}`,
        reason: a.action.reason,
        result: a.policy.allowed ? (okay ? t("성공") : workspaceText("실패({reason})", lang, { reason: a.result?.errorCode ?? t("미실행") })) : workspaceText("차단: {reason}", lang, { reason: a.policy.reason }),
        resultIsWords: okay,
        state: !a.policy.allowed ? "blocked" : okay ? "ok" : "failed",
      };
    }),
    recordingOwner: !recovering && consent === "granted" && voiceMode.stt && state !== "AUTH_HANDOFF" && state !== "STOPPED" ? sessionId : undefined,
    workspaceOwner: consent === "granted" && ui.workspaceAvailable && !recovering ? sessionId : undefined,
  };
}
export type WorkspaceView = ReturnType<typeof viewOf>;
