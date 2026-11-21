import type { DecisionInput } from "./companion.ts";
import { captureKeys, phaseKeys, taskKeys } from "./workspace-language.ts";

export type Capture = keyof typeof captureKeys;
export type Phase = keyof typeof phaseKeys;
export type Task = keyof typeof taskKeys;
type Mode = "starting" | "ended" | "consent" | "auth-handoff" | "choice" | "problem" | "ready" | "working" | "speaking" | "listening" | "offline";

export const issueActions = { reconnect: "다시 연결", stop: "다시 멈춤 요청", microphone: "마이크 설정 열기", type: "글로 입력", check: "현재 상태 확인" } as const;
export type IssueAction = keyof typeof issueActions;
export const issues = {
  offline: ["연결이 끊겼어요", ["reconnect"]],
  timeout: ["응답 시간이 초과되어 요청 결과를 확인하지 못했어요.", ["check", "type"]],
  lostTurn: ["요청 결과를 확인하지 못했어요. 요청을 다시 보내지 않았어요.", ["check", "type"]],
  cancelFailed: ["서버가 멈춤을 확인하지 못했어요. 이 기기에서는 멈췄어요.", ["stop"]],
  micDenied: ["마이크를 사용할 수 없습니다. 브라우저 마이크 권한을 확인하거나 텍스트로 입력하세요.", ["microphone", "type"]],
  micLost: ["마이크 연결이 끊겼거나 소리가 들어오지 않습니다. 아이폰 등 다른 기기 마이크가 선택돼 있을 수 있어요. 아래 마이크 선택에서 이 컴퓨터의 마이크를 고른 뒤 대화를 다시 시작해 주세요.", ["microphone", "type"]],
  voiceDown: ["음성 서비스를 사용할 수 없어요. 글로 입력할 수 있어요.", ["type"]],
  turnFailed: ["요청을 처리하지 못했어요.", ["type"]],
  expired: ["요청한 작업이 만료됐어요.", ["check", "type"]],
  blocked: ["이 사이트에서 이 작업을 할 수 없어요.", ["type"]],
  consentRequired: ["동의하지 않으셔서 음성 대화를 시작하지 않습니다. 복지 제도 질문은 텍스트로 입력할 수 있습니다.", ["type"]],
} as const satisfies Record<string, readonly [string, readonly IssueAction[]]>;
export type IssueKey = keyof typeof issues;

export interface PresentationInput extends DecisionInput {
  busy: boolean;
  phase: Phase;
  listening: boolean;
  speaking?: boolean;
  capture?: Capture;
  stopping?: boolean;
  offline?: boolean;
  cancelUnconfirmed?: boolean;
  sleeping?: boolean;
  error?: string | undefined;
  card?: { kind: "approval" | "offer" | "consent" } | undefined;
}

function taskOf(ui: PresentationInput): Task {
  if (ui.stopping === true) return "stopping";
  if (ui.cancelUnconfirmed === true) return "stopped";
  if (ui.offline === true) return "offline";
  if (ui.last?.authHandoff?.status === "waiting") return "auth_handoff";
  if (ui.card?.kind === "approval") return "awaiting_approval";
  if (ui.card !== undefined) return "awaiting_choice";
  if (ui.error !== undefined && ui.error.length > 0) return "failed";
  if (ui.sleeping === true) return "stopped";
  if (ui.busy || ui.phase === "thinking") return "working";
  return "idle";
}

function modeOf(ui: PresentationInput, task: Task, playing: boolean): Mode {
  if (task === "offline") return "offline";
  if (ui.sessionId === undefined && (ui.error === undefined || ui.error.length === 0)) return ui.consent === "loading" ? "starting" : "ended";
  if (ui.consent === "ask" || ui.consent === "intro") return "consent";
  switch (task) {
    case "auth_handoff": return "auth-handoff";
    case "awaiting_choice": case "awaiting_approval": return "choice";
    case "failed": return "problem";
    case "stopping": case "working": return "working";
    case "stopped": return "ready";
    case "idle":
      if (playing) return "speaking";
      if (ui.phase === "starting") return "working";
      if (ui.listening || ui.phase === "listening" || ui.phase === "hearing") return "listening";
      return "ready";
  }
}

/** 같은 장치와 작업 상태에서 세 화면의 표시 문구를 고른다. */
export function presentationOf(ui: PresentationInput) {
  const capture = ui.capture ?? "off";
  const playing = ui.speaking === true;
  const playback = playing ? "speaking" : "idle";
  const task = taskOf(ui);
  const mode = modeOf(ui, task, playing);
  const phase = ui.phase !== "off" ? ui.phase : ui.listening ? "listening" : playing ? "speaking" : ui.busy ? "thinking" : "off";
  const phaseKey = phase !== ui.phase ? phaseKeys[phase].manual : phaseKeys[phase].active;
  return { capture, captureKey: captureKeys[capture], playback, playbackKey: playing ? phaseKeys.speaking.manual : phaseKeys.off.manual,
    task, taskKey: taskKeys[task], mode, phase, phaseKey };
}

