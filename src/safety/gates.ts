import { INTENTS, type IntentType } from "../core/intents.ts";
import type { SessionState } from "../core/turn.ts";

export const ALLOWED_WITHOUT_CONSENT: ReadonlySet<IntentType> = new Set(
  INTENTS.filter(spec => spec.beforeConsent).map(spec => spec.type),
);
export type Consent = "granted" | "pending" | "declined";
export type GateRefusal =
  | { semanticAction: "consent"; speech: string; state?: undefined }
  | { semanticAction: "none"; speech: string; state: "STOPPED" };

export function consentRefusal(types: readonly IntentType[], consent: Consent): GateRefusal | undefined {
  if (consent === "granted" || types.every(type => ALLOWED_WITHOUT_CONSENT.has(type))) return undefined;
  return {
    semanticAction: "consent",
    speech: consent === "pending"
      ? "먼저 시작 화면의 안내를 듣고 동의해 주세요. 동의 전에는 화면을 읽거나 브라우저를 조작하지 않습니다."
      : "동의하지 않으셔서 화면을 읽거나 브라우저를 조작하지 않습니다. 복지 제도 질문은 할 수 있습니다.",
  };
}

/** 멈춤은 턴 시작에 한 번만 확인한다. 재개 뒤 이어지는 명령은 같은 턴에서 실행할 수 있다. */
export function gateRefusal(types: readonly [IntentType, ...IntentType[]], consent: Consent, state: SessionState): GateRefusal | undefined {
  const refusal = consentRefusal(types, consent);
  if (refusal !== undefined) return refusal;
  if (state === "STOPPED" && types[0] !== "RESUME") {
    return { state: "STOPPED", semanticAction: "none", speech: "지금은 중단 상태라서 아무것도 실행하지 않았습니다. 계속하려면 '다시 시작'이라고 말씀하세요." };
  }
  return undefined;
}
