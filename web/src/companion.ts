// 화면 위 아바타에는 현재 선택지와 짧은 안내만 표시한다.
// 입력값·파일 이름·받아쓴 글·화면 원문은 넣지 않는다. 승인 내용은 대화 창의 검토 화면에서 본다.
import { MAX_OFFERED_CHOICES, isJobChoice } from "../../src/core/choices.ts";
import type { SessionState } from "../../src/core/turn.ts";
import { presentationOf, type Capture, type PresentationInput } from "./presentation.ts";
import type { ApprovalKind, Turn } from "./api.ts";
import { workspaceText } from "./workspace-language.ts";

export const APPROVE_LABELS: Readonly<Record<ApprovalKind, string>> = {
  "vault-save": "내 정보 저장",
  "vault-clear": "내 정보 삭제",
  "public-research": "자료 조사 승인",
  "field-entry": "입력 승인",
  click: "누르기 승인",
  plan: "차례로 누르기 승인",
  "file-transfer": "파일 전송 승인",
  "visual-navigation": "화면 사진 전송 승인",
  "practice-submission": "모의접수 승인",
};

// 승인 카드의 질문은 동작 종류로만 만든다(누를 버튼 이름 같은 화면 글은 항상 위에 뜨는 창에 두지 않는다. '내용 확인'에서 본다).
const APPROVE_PROMPTS: Readonly<Record<ApprovalKind, string>> = {
  "vault-save": "내 정보를 저장할까요?",
  "vault-clear": "저장된 내 정보를 모두 지울까요?",
  "public-research": "질문을 저장하고 조사를 맡길까요?",
  "field-entry": "입력란을 채울까요?",
  click: "버튼을 누를까요?",
  plan: "읽어 드린 순서대로 누를까요?",
  "file-transfer": "받은 파일을 보낼까요?",
  "visual-navigation": "링크를 찾으려고 화면 사진을 보낼까요?",
  "practice-submission": "모의접수를 할까요?",
};

const AUTH_PROMPTS = {
  login: "{site}에서 직접 로그인해 주세요.",
  verification: "{site}에서 직접 인증해 주세요.",
  captcha: "{site}에서 보안 확인을 직접 해 주세요.",
};

export type Consent = "loading" | "intro" | "ask" | "granted" | "declined";
/** 화면을 다시 연결하면 지난 응답 대신 인증 인계만 알고 있다(resume). 그래서 모든 항목이 있을 수도 없을 수도 있다. */
export type LastTurn = Partial<Turn>;
export interface Choice { key: string; label: string; open?: "consent" | "confirm" }
interface DecisionBase { key: string; prompt: string; choices: Choice[]; site?: string }
export type Decision =
  | DecisionBase & { kind: "consent" }
  | DecisionBase & { kind: "approval"; ref: { actionId: string } }
  | DecisionBase & { kind: "offer"; ref: { turnId: string; handoffId?: string | undefined } };

export interface DecisionInput {
  sessionId?: string | undefined;
  lang: string;
  consent: Consent | undefined;
  state: SessionState;
  last?: LastTurn | undefined;
}

/**
 * 카드: key가 같으면 같은 결정이다(선택지 묶음 번호를 유지한다). ref는 서버 쪽 참조로, 대화 창 밖으로 보내지 않는다.
 * open이 있는 선택지는 고르면 대화 창을 그 자리(focus)로 연다.
 */
export function currentDecision(ui: DecisionInput): Decision | undefined {
  if (ui.sessionId === undefined || ui.sessionId.length === 0) return undefined;
  const t = (text: string) => workspaceText(text, ui.lang);
  if (ui.consent === "intro" || ui.consent === "ask") {
    return {
      key: "consent",
      kind: "consent",
      prompt: t("시작 전 안내를 듣고 동의해 주세요."),
      choices: [
        { key: "consent-yes", label: t("동의하고 음성 대화 시작") },
        { key: "consent-no", label: t("동의하지 않음") },
        { key: "review", label: t("안내 보기"), open: "consent" },
      ],
    };
  }
  const last = ui.last;
  const pending = ui.state === "WAITING_FOR_USER_CONFIRMATION" ? last?.pendingConfirmation : undefined;
  if (pending !== undefined) {
    return {
      key: `approval:${pending.actionId}`,
      kind: "approval",
      prompt: t(pending.kind !== undefined ? APPROVE_PROMPTS[pending.kind] : "이 동작을 진행할까요?"),
      site: pending.site,
      choices: [
        { key: "approve", label: t(pending.kind !== undefined ? APPROVE_LABELS[pending.kind] : "이 동작 승인") },
        { key: "review", label: t("내용 확인"), open: "confirm" },
        { key: "reject", label: t("취소") },
      ],
      ref: { actionId: pending.actionId },
    };
  }
  const offered = last?.offeredChoices ?? [];
  if (last === undefined || offered.length === 0) return undefined;
  const handoff = last.authHandoff?.status === "waiting" ? last.authHandoff : undefined;
  const first = offered[0];
  return {
    key: `offer:${last.turnId ?? ""}`,
    kind: "offer",
    prompt: handoff !== undefined ? t(AUTH_PROMPTS[handoff.kind]).replace("{site}", () => handoff.site)
      : t(offered.length === 1 && first?.key === "read-main" ? "이 페이지의 본문을 읽어 드릴까요?"
        : offered.every(choice => isJobChoice(choice.key)) ? "어느 조사인지 번호로 골라 주세요." : "이 화면에서 할 수 있는 일이에요."),
    choices: offered.slice(0, MAX_OFFERED_CHOICES).map(({ key, label }) => ({ key, label })),
    ref: { turnId: last.turnId ?? "", handoffId: handoff?.id },
  };
}

// Only surface public catalogue names and app-authored cues. A reply can contain
// form values, screen contents or dictation even when its intent is informational.
export function turnNotice(turn: Turn): string | null {
  if (turn.speech.length === 0 || turn.semanticAction === "stop" || turn.intentType === "STOP" || turn.pendingConfirmation !== undefined
      || (turn.offeredChoices?.length ?? 0) > 0 || turn.semanticAction === "consent" || turn.intentType === "CONSENT") return null;
  const t = (text: string) => workspaceText(text, turn.lang);
  if (turn.semanticAction === "set-language") return turn.speech;
  const card = turn.answerCard;
  if (card?.grounded === true && card.serviceName.length > 0) {
    return t("{service} 안내를 찾았어요. 저를 누르면 답변과 출처를 볼 수 있어요.")
      .replace("{service}", () => card.serviceName);
  }
  if (turn.state === "VALIDATION_ERROR") return t("확인이 필요한 입력란이 있어요. 저를 눌러 확인해 주세요.");
  if (turn.state === "AWAITING_FIELD_VALUE") return t("입력할 새 값을 말씀해 주세요.");
  if (turn.semanticAction === "clarify" || turn.state === "NEEDS_CLARIFICATION") {
    const [first, second] = turn.publicSuggestions ?? [];
    if (second !== undefined && second.length > 0) return t("1번 {first}, 2번 {second} 중 어느 쪽인가요?").replace("{first}", () => first ?? "").replace("{second}", () => second);
    if (first !== undefined && first.length > 0) return t("“{first}” 말씀이세요?").replace("{first}", () => first);
    return t("어떤 뜻인지 확인하고 싶어요. 저를 눌러 질문을 보고 답해 주세요.");
  }
  if (turn.verification?.fieldValueMatches === true) return t("입력했어요. 다음 항목으로 가려면 “다음으로”라고 말씀해 주세요.");
  if (turn.state === "MOCK_SUBMITTED") return t("연습 신청을 마쳤어요. 저를 누르면 결과를 볼 수 있어요.");
  return t("답변이 도착했어요. 저를 누르면 읽을 수 있어요.");
}

export type ViewInput = PresentationInput;
/** 대화 창 밖(ui 밖)에서 대화 창이 알고 있는 것 */
export interface LiveView {
  capture: Capture;
  speaking: boolean;
  recording: boolean;
  message: { id: string; text: string } | null;
  sleeping: boolean;
  introPose: string | null;
  card: (Decision & { id: string }) | undefined;
  pending: boolean;
}


/** 아바타 창에 보내는 표시 상태. */
export function desktopView(ui: ViewInput, live: LiveView) {
  const display = presentationOf({ ...ui, capture: ui.capture ?? live.capture, speaking: ui.speaking ?? live.speaking,
    sleeping: ui.sleeping ?? live.sleeping, listening: ui.listening === true || live.recording, card: live.card });
  const { mode } = display;
  const t = (key: string) => workspaceText(key, ui.lang);
  const status = mode === "starting" ? t("청음을 준비하는 중이에요.") : mode === "ended" ? t("이용을 마쳤어요. 다시 시작하려면 저를 눌러 대화를 여세요.")
    : mode === "consent" ? t("시작 전에 동의가 필요해요.")
    : mode === "ready" && display.task === "idle" && ui.consent === "declined"
      ? t("음성 대화는 꺼져 있어요. 저를 누르면 글로 물어볼 수 있어요.") : t(display.taskKey);
  const offline = ui.offline === true, unconfirmed = ui.cancelUnconfirmed === true;
  const card = offline || unconfirmed ? undefined : live.card;
  const busy = !offline && !unconfirmed && (ui.busy === true || ui.phase === "thinking");
  const sleeping = live.sleeping && mode === "ready";
  return {
    connected: !offline,
    contrast: ui.contrast === true,
    mode,
    capture: display.capture,
    captureLabel: t(display.captureKey),
    playback: display.playback,
    task: display.task,
    speaking: display.playback === "speaking",
    busy,
    sleeping,
    // 청음 소개 중이면 줄마다 정한 동작(말하는 동안에도 이 동작을 보인다)
    introPose: live.introPose,
    resting: mode === "ready" && ui.consent === "granted" && live.capture === "off" && !busy && !live.speaking && card === undefined,
    lang: ui.lang,
    state: ui.state,
    reading: ui.state === "BROWSING" && ui.last?.semanticAction === "read-main",
    status,
    reconnectLabel: offline ? t("다시 연결") : undefined,
    taskLabel: t(display.taskKey),
    message: offline || unconfirmed || card !== undefined || ui.sessionId === undefined || mode === "problem" || sleeping ? null : live.message,
    prompt: offline ? t("연결이 끊겼어요") : card?.prompt ?? null,
    site: card?.site ?? null,
    choiceSetId: offline ? "reconnect" : card?.id ?? null,
    choices: offline ? [{ key: "reconnect", label: t("다시 연결") }] : card !== undefined ? card.choices.map(({ key, label, open }) => (open !== undefined ? { key, label, open } : { key, label })) : [],
    pending: card !== undefined && live.pending,
  };
}
export type DesktopView = ReturnType<typeof desktopView>;
