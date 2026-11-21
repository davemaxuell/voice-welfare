import type { SemanticAction, SessionState } from "../../../core/turn.ts";
import { draft } from "../../../core/turn.ts";
import { hasText, strip } from "../../../core/text.ts";
import type { WebOutcome } from "../agent.ts";
import { helpHumanSpeech, nextStep } from "../playbook.ts";
import type { WebObservation } from "../view.ts";

export { clickNote, pressResult, unconfirmedMessage } from "../effect.ts";
export { blockedSpeech, helpHumanSpeech } from "../playbook.ts";

export function browseState(view?: WebObservation): SessionState {
  switch (view?.pageId) {
    case "mock-welfare": return hasText(view.status) ? "MOCK_SUBMITTED" : "APPLICATION_OPEN";
    case "mock-login": return "AUTH_HANDOFF";
    case "blank": return "IDLE";
    default: return "BROWSING";
  }
}

export function isFormOpen(view?: WebObservation): boolean {
  return view?.pageId === "mock-welfare" && view.step != null && !hasText(view.status);
}

export function notOpen(current: WebObservation | undefined, state: SessionState) {
  return draft(state === "AUTH_HANDOFF" || state === "MOCK_SUBMITTED" || state === "BROWSING" ? state : "IDLE", "none",
    current?.pageId === "external"
      ? "이 사이트에서는 입력을 대신하지 않아요. 읽기, 이동, 검색만 도와드려요."
      : "지금 화면에는 입력할 신청서가 없어요. 무엇을 도와드릴까요?");
}

export function fillConfirmed(label: string, shown: string, guide = "") {
  return strip(`${label}에 "${shown}" 넣었어요. ${guide}`);
}

export function outcomeFailure(out: WebOutcome, fallbackState: SessionState) {
  const msg = hasText(out.message) ? out.message : "실행하지 못했습니다.";
  const denied = out.status === "policy-denied";
  const state = out.status === "aborted" ? "STOPPED" : denied ? fallbackState : "RECOVERING";
  const body = denied
    ? `${msg} 안전 규칙에 따라 실행하지 않았습니다. ${nextStep("policy-denied", out.view?.url)}`
    : `${msg} 다시 시도하거나 다른 명령을 말씀해 주세요.`;
  return draft(state, "none", body, {actions: out.actions, view: out.view});
}

export function askAgain(out: WebOutcome, semantic: SemanticAction, how: string) {
  return draft("WAITING_FOR_USER_CONFIRMATION", semantic, `${out.message ?? ""} 다시 할까요? ${how}`, {actions: out.actions, view: out.view});
}

export function helpHumanDraft(state: SessionState, contact: Parameters<typeof helpHumanSpeech>[0] = {}) {
  return draft(state, "help", helpHumanSpeech(contact));
}
