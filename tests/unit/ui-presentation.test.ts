import { expect, it } from "vitest";
import { trayTaskText } from "../../apps/desktop/src/protocol.ts";
import { desktopView, type LiveView } from "../../web/src/companion.ts";
import { presentationOf, type Capture } from "../../web/src/presentation.ts";
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
  const { window, avatar } = labels({ phase: "listening", error: "연습 오류", capture: "on" }, { capture: "on" });
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
        const ui: UiState = { ...base, capture, speaking, busy, stopping, sleeping, card, error: failed ? "오류" : undefined,
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

