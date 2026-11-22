import type { DecisionInput } from "./companion.ts";
import { captureKeys, issueActions, issueText, phaseKeys, taskKeys } from "./workspace-language.ts";

export type Capture = keyof typeof captureKeys;
export type Phase = keyof typeof phaseKeys;
export type Task = keyof typeof taskKeys;
type Mode = "starting" | "ended" | "consent" | "auth-handoff" | "choice" | "problem" | "ready" | "working" | "speaking" | "listening" | "offline";

export { issueActions };
export type IssueAction = keyof typeof issueActions;
export const issues = {
  offline: [issueText.offline, ["reconnect"]],
  timeout: [issueText.timeout, ["check", "type"]],
  lostTurn: [issueText.lostTurn, ["check", "type"]],
  cancelFailed: [issueText.cancelFailed, ["stop"]],
  micDenied: [issueText.micDenied, ["microphone", "type"]],
  micLost: [issueText.micLost, ["microphone", "type"]],
  voiceDown: [issueText.voiceDown, ["type"]],
  playbackBlocked: [issueText.playbackBlocked, []],
  voiceCredentials: [issueText.voiceCredentials, ["type"]],
  voiceQuota: [issueText.voiceQuota, ["type"]],
  voiceLimit: [issueText.voiceLimit, ["type"]],
  turnFailed: [issueText.turnFailed, ["type"]],
  languageFailed: [issueText.languageFailed, []],
  expired: [issueText.expired, ["check", "type"]],
  blocked: [issueText.blocked, ["type"]],
  consentRequired: [issueText.consentRequired, ["type"]],
} as const satisfies Record<string, readonly [string, readonly IssueAction[]]>;
export type IssueKey = keyof typeof issues;

export interface PresentationInput extends DecisionInput {
  contrast?: boolean;
  busy?: boolean;
  phase?: Phase;
  listening?: boolean;
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
  if (ui.busy === true || ui.phase === "thinking") return "working";
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
      if (ui.listening === true || ui.phase === "listening" || ui.phase === "hearing") return "listening";
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
  const currentPhase = ui.phase ?? "off";
  const phase = currentPhase !== "off" ? currentPhase : ui.listening === true ? "listening" : playing ? "speaking" : ui.busy === true ? "thinking" : "off";
  const phaseKey = phase !== currentPhase ? phaseKeys[phase].manual : phaseKeys[phase].active;
  return { capture, captureKey: captureKeys[capture], playback, playbackKey: playing ? phaseKeys.speaking.manual : phaseKeys.off.manual,
    task, taskKey: taskKeys[task], mode, phase, phaseKey };
}

