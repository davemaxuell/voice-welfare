import { expect, it } from "vitest";
import { trayTaskText } from "../../apps/desktop/src/protocol.ts";
import { desktopView, type LiveView } from "../../web/src/companion.ts";
import { presentationOf, type Capture, type IssueKey } from "../../web/src/presentation.ts";
import { captureKeys, taskKeys } from "../../web/src/workspace-language.ts";
import { viewOf, type UiState } from "../../web/src/view.ts";

it("트레이는 대화 창이 보낸 고정 상태만 표시하고 창이 사라지면 그 상태를 지운다", () => {
  expect(trayTaskText({ connected: false, task: "failed", lang: "en" })).toBe("Something went wrong.");
  expect(trayTaskText({ connected: true, task: "페이지 원문" })).toBeUndefined();
  expect(trayTaskText(null)).toBeUndefined();
});

const base: UiState = {
  sessionId: "s", state: "IDLE", lang: "ko", consent: "granted", busy: false, hasTurn: true, practiceMode: true,
  workspaceAvailable: true, settingsAvailable: false, listening: false, tts: false, contrast: false,
  voiceMode: { known: true, stt: true, tts: true, label: "", llmRoles: {} }, phase: "off", baseSpeed: 1, mics: [],
  speaking: false, cardTaken: false, sessionNew: false, checkingMic: false, micCheckResult: "", edge: false,
  conversationMode: "native", liveCaption: "", messages: [], announcement: { text: "", seq: 0 },
};
const live: LiveView = { capture: "off", speaking: false, recording: false, message: null, sleeping: false, introPose: null, card: undefined, pending: false };

it("서비스가 끊기면 대기 중인 승인을 실행하지 않고 다시 연결할 수 있다", () => {
  const ui = { ...base, offline: true, busy: true, error: "offline" as const };
  const window = viewOf(ui, { background: false, mac: false });
  const avatar = desktopView(ui, live);
  expect([window.conversation.taskLabel, avatar.taskLabel]).toEqual(["연결이 끊겼어요", "연결이 끊겼어요"]);
  expect(window.command).toMatchObject({ busy: false, sendDisabled: true, disabled: false });
  expect(avatar).toMatchObject({ connected: false, busy: false, choices: [{ key: "reconnect", label: "다시 연결" }] });
  expect(desktopView({ ...base, offline: false }, live)).toMatchObject({ connected: true, task: "idle" });
});

it("서버 확인이 없는 멈춤은 오류 안내와 함께 멈춤 상태를 유지한다", () => {
  const ui = { ...base, cancelUnconfirmed: true, error: "cancelFailed" as const, sleeping: true };
  expect(viewOf(ui, { background: false, mac: false }).error?.actions.map(a => a.key)).toEqual(["stop"]);
  expect(desktopView(ui, { ...live, sleeping: true })).toMatchObject({ task: "stopped", sleeping: true, busy: false });
});

it.each(Object.entries({
  offline: ["reconnect"], timeout: ["check", "type"], lostTurn: ["check", "type"], cancelFailed: ["stop"],
  micDenied: ["microphone", "type"], micLost: ["microphone", "type"], voiceDown: ["type"], turnFailed: ["type"],
  expired: ["check", "type"], blocked: ["type"], consentRequired: ["type"],
} satisfies Record<IssueKey, string[]>))("오류 %s에 실행할 수 있는 동작이 있다", (key, actions) => {
  const view = viewOf({ ...base, error: key as IssueKey }, { background: false, mac: false });
  expect(view.error?.actions.map(a => a.key)).toEqual(actions);
  expect(view.error?.text).toBeTruthy();
});
const approval = { id: "c", lang: "ko", key: "approval:a", kind: "approval" as const, choices: [], prompt: "", ref: { actionId: "a" } };

function labels(patch: Partial<UiState>, activity: Partial<LiveView>) {
  const ui = { ...base, ...patch };
  const window = viewOf(ui, { mac: false, background: false }).conversation;
  const avatar = desktopView(ui, { ...live, ...activity });
  return { window, avatar };
}

it("대화 시작 때 권한을 기다리는 동안 마이크를 켜졌다고 하지 않는다", () => {
  const { window, avatar } = labels({ phase: "starting", capture: "requesting" }, { capture: "on" });
  expect([window.captureLabel, avatar.captureLabel]).toEqual(["마이크 준비 중", "마이크 준비 중"]);
});

it("서버가 멈춤을 확인할 때까지 창과 아바타가 함께 기다린다", () => {
  const { window, avatar } = labels({ busy: true, stopping: true, sleeping: true }, { sleeping: true });
  expect([window.taskLabel, avatar.status]).toEqual(["멈추는 중이에요.", "멈추는 중이에요."]);
});

it("처리 중에 승인 카드가 있으면 두 화면 모두 승인 대기 상태를 표시한다", () => {
  const { window, avatar } = labels({ busy: true, card: approval }, { card: approval });
  expect([window.taskLabel, avatar.status]).toEqual(["승인을 기다리고 있어요.", "승인을 기다리고 있어요."]);
});

it("마이크를 듣는 중이어도 작업 오류를 두 화면 모두 알린다", () => {
  const { window, avatar } = labels({ phase: "listening", error: "turnFailed", capture: "on" }, { capture: "on" });
  expect([window.taskLabel, avatar.status]).toEqual(["문제가 생겼어요.", "문제가 생겼어요."]);
});

it("장치·재생·작업 상태를 조합해도 창과 아바타는 같은 문구를 쓴다", () => {
  const captures: Capture[] = ["off", "requesting", "on", "paused", "error"];
  const flags = [false, true];
  const states = new Set<string>();
  const offer = { ...approval, kind: "offer" as const, ref: { turnId: "t" } };
  for (const capture of captures) for (const speaking of flags) for (const busy of flags)
    for (const stopping of flags) for (const sleeping of flags) for (const failed of flags)
      for (const handoff of flags) for (const card of [undefined, approval, offer]) {
        const ui: UiState = { ...base, capture, speaking, busy, stopping, sleeping, card, error: failed ? "turnFailed" : undefined,
          ...(handoff && { last: { authHandoff: { id: "h", kind: "login", taskId: "t", site: "연습", status: "waiting" } } }) };
        const expected = stopping ? "stopping" : handoff ? "auth_handoff" : card?.kind === "approval" ? "awaiting_approval"
          : card !== undefined ? "awaiting_choice" : failed ? "failed" : sleeping ? "stopped" : busy ? "working" : "idle";
        const display = presentationOf(ui);
        states.add(display.task);
        const { window, avatar } = labels(ui, { capture, speaking, sleeping, card });
        expect([display.playback, window.taskLabel, avatar.taskLabel, window.captureLabel, avatar.captureLabel])
          .toEqual([speaking ? "speaking" : "idle", taskKeys[expected], taskKeys[expected], captureKeys[capture], captureKeys[capture]]);
      }
  expect(states.size).toBe(8);
});

