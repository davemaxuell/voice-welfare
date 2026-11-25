import { timing, type TimingPoint } from "./perf.ts";
// 청음 대화 창의 상태와 동작(Python app.js). 화면은 App.tsx가 이 상태(snapshot)를 그린다.
// 입력란·버튼은 다시 만들지 않으므로 포커스가 유지된다(화면낭독기 사용자를 위해).
import { LangSchema, type Lang } from "../../src/core/turn.ts";
import { speechPace, speechSpeed, VOICE_PROFILE } from "../../src/core/voice_profile.ts";
import {
  api, ApiError, errorCode, errorMessage, errorStatus, type Health, type Session, type Settings, type SettingsInput, type Turn,
} from "./api.ts";
import { getSpeechLang, setSpeechLang, unlockAudio } from "./audio.ts";
import { currentDecision, desktopView, turnNotice, type Consent, type Decision } from "./companion.ts";
import { createFirstRun } from "./first-run.ts";
import { issues, type Capture, type IssueKey, type IssueAction } from "./presentation.ts";
import { listMicrophones, preferredMicrophone, startRecording, VoiceLoop, type LiveAudio, type Recording } from "./mic.ts";
import { BackendStatus } from "./backend-status.ts";
import { RESEARCH_POLL_MS, recordHeard, researchStarted } from "./research-delivery.ts";
import {
  applySpeechPrefs, earcon, noteVoiceInterruption, onSpeaking, preloadCues, reportVoiceRecovery, serverTts, withPrivateReadback, speechPrefs,
  isSpeechReserved, reserveSpeech, takeInterruptedSpeech, transitionCue, type CueKind,
} from "./speaker.ts";
import { LiveConversation } from "./voice-edge.ts";
import { voiceFault, type VoiceFault } from "../../src/voice/recovery.ts";
import {
  consentText as consentTextFor, dictationHelp, GREETINGS, type CardView, type Env, type LogEntry, type Phase, type Recovery, type UiState,
} from "./view.ts";
import { loadWorkspaceLanguage, workspaceText } from "./workspace-language.ts";

const BACKGROUND = new URLSearchParams(location.search).get("background") === "1";
const env: Env = { background: BACKGROUND, mac: /Mac/.test(navigator.platform) };

/** 데스크톱 앱(Electron)에서 실행 중이면 preload가 넣어 준다. 소리 자동재생이 허용되어 있다. */
const desktop = window.cheongeumDesktop;
let desktopLanguage = desktop === undefined ? undefined : LangSchema.safeParse(new URLSearchParams(location.search).get("desktopLang")).data;

function syncDesktopLanguage(lang: Lang) {
  if (desktop === undefined) return;
  try {
    const url = new URL(location.href);
    if (url.searchParams.get("desktopLang") !== lang) {
      url.searchParams.set("desktopLang", lang);
      history.replaceState(history.state, "", url.href);
    }
  } catch { /* 주소 갱신 불가 환경 무시 */ }
}

const TRANSLATE_FAIL_PREFIXES: readonly string[] = [
  "(Translation could not be verified, so here is the original Korean.)",
  "（无法确认翻译是否准确，以下为韩语原文。）",
  "（翻訳を確認できなかったため、韓国語の原文をお伝えします。）",
];

function responseLanguage(r: Turn): Lang {
  if (r.semanticAction === "set-language") return r.lang;
  if (ui.requestedLanguage !== undefined) return ui.requestedLanguage;
  if (r.lang === "ko" && ui.lang !== "ko" && (r.localSpeechOnly === true ||
      TRANSLATE_FAIL_PREFIXES.some(prefix => r.speech.startsWith(prefix)))) {
    return ui.lang;
  }
  return r.lang;
}

const REMINDER_NOW = /^(?:지금|now|现在|今)[.!。！?？ ]*$/iu;
const REMINDER_MORNING = /^(?:아침|morning|早上|朝)[.!。！?？ ]*$/iu;

const t = (text: string, values?: Readonly<Record<string, string | number>>) => workspaceText(text, ui.lang, values);
const consentText = (lang: string = ui.lang) => consentTextFor(ui, env, lang);

// 서버 음성 설정을 받아 오기 전에는 동의 안내를 읽지 않는다(어디로 전송되는지가 바뀌므로)
let healthReady: Promise<Health | undefined> = Promise.resolve(undefined);

let stopSetupClip: (() => void) | undefined;
// 첫 실행 설정(키·이 PC·소리 확인·빠르기). 끝나면 동의 화면으로 넘어간다.
export const firstRun = createFirstRun({
  desktop,
  speak: async (text, lang, rate) => {
    unlockAudio();
    const status = await serverTts.speak(text, (chunk, speed, signal) => api.speak(chunk, langOf(lang), speed, signal, rate), 0, rate, langOf(lang));
    if (status === "blocked") throw new Error("PLAYBACK_BLOCKED");
    return status;
  },
  stopSpeaking: () => serverTts.cancel(),
  onSaved: () => { desktopLanguage = undefined; return refreshHealth(); },
  onConsentReady: async () => {
    firstRun.finish();
    // '설정 다시 해줘'로 연 경우는 대화가 이미 있다: 저장한 설정은 서버가 열린 대화에 넘긴다
    if (ui.sessionId !== undefined) announce(t("이용 설정을 저장했어요."));
    else await chooseSession();
  },
  loadManifest: async () => {
    const res = await fetch("/setup-audio/manifest.json");
    const data: unknown = await res.json();
    return typeof data === "object" && data !== null ? manifestOf(data) : {};
  },
  playClip: async (src, speed) => {
    const release = reserveSpeech();
    let stop: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const audio = new Audio(src);
        audio.playbackRate = speed;
        stop = stopSetupClip = () => { audio.pause(); resolve(); };
        audio.onended = audio.onpause = () => resolve();
        audio.onerror = () => reject(new Error("SETUP_AUDIO_UNAVAILABLE"));
        audio.play().catch(reject);
      });
    } finally {
      if (stopSetupClip === stop) stopSetupClip = undefined;
      release();
    }
  },
  pauseClip: () => stopSetupClip?.(),
  settings: () => api.settings(),
  checkKey: async (key) => (await api.checkKey(key)).result,
  saveSettings: (values) => api.saveSettings(values),
  saveGuardian: (contact) => api.saveGuardian(contact),
  setTimer: (fn, ms) => { setTimeout(fn, ms); },
});

function manifestOf(data: object) {
  const out: Record<string, Record<string, string>> = {};
  for (const [id, row] of Object.entries(data)) {
    if (typeof row !== "object" || row === null) continue;
    out[id] = Object.fromEntries(Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  return out;
}
const langOf = (lang: string): Lang => (["ko", "en", "zh", "ja"] as const).find(l => l === lang) ?? "ko";

const readMicId = () => {
  try {
    return localStorage.getItem("cheongeum.micId") ?? undefined;
  } catch {
    return undefined;
  }
};
const readVoiceMode = () => {
  try {
    return localStorage.getItem("cheongeum.voiceMode") === "dictate" ? "dictate" : "native";
  } catch {
    return "native";
  }
};

let narrationMuted = false;
try { narrationMuted = localStorage.getItem("cheongeum.narrationMuted") === "1"; } catch { /* 임시 세션 */ }
export const isNarrationMuted = () => narrationMuted;

export interface SettingsDialog {
  /** 열 때마다 늘어난다(입력란을 새로 채운다). */
  seq: number;
  prefs?: Settings;
  keyState?: "error" | "saved" | "empty";
  autostart?: boolean;
  error?: string;
  loading: boolean;
  saving: boolean;
}

/** 화면 상태(바뀌면 App이 해당 부분만 다시 그린다) */
let ui: UiState & { settings?: SettingsDialog | undefined; requestedLanguage?: Lang | undefined; settingsSeq: number; commandReset: number; consentDetailsOpen: number; errorSeq: number; backgroundMic?: "speech" | "text" | undefined } = {
  sessionId: undefined,
  state: "IDLE",
  last: undefined,
  lang: desktopLanguage ?? "ko",
  busy: false,
  hasTurn: false,
  practiceMode: false,
  workspaceAvailable: false,
  settingsAvailable: false,
  listening: false,
  voiceMode: { known: false, stt: false, tts: false, label: "", llmRoles: {} },
  tts: false,
  contrast: false,
  error: undefined,
  phase: "off",
  baseSpeed: VOICE_PROFILE.speed,
  consent: "loading",
  mics: [],
  micId: readMicId(),
  speaking: false,
  cardTaken: false,
  sessionNew: false,
  checkingMic: false,
  micCheckResult: "",
  edge: false,
  conversationMode: readVoiceMode(),
  liveCaption: "",
  messages: [],
  announcement: { text: "", seq: 0 },
  commandReset: 0,
  settingsSeq: 0,
  consentDetailsOpen: 0,
  errorSeq: 0,
};
export type Snapshot = typeof ui;
// TypeScript가 await 너머로 좁힌 타입을 믿지 않게, 바뀌었을 수 있는 값은 함수로 다시 읽는다.
const dialogNow = () => ui.settings;
const authWaiting = () => ui.last?.authHandoff?.status === "waiting";

// 긴 비동기 루프·녹음 상태(화면에는 직접 나오지 않음)
let conversationOn = false;
let loop: VoiceLoop | undefined;
let recording: (Recording & { asked: string }) | undefined;
let openingMic = false;
let manualStream: MediaStream | undefined;
let manualRequestGeneration = -1;
let probeStream: MediaStream | undefined;
let microphoneTrouble = false;

function captureState(): Capture {
  const tracks = [manualStream, probeStream, edge?.stream, loop?.stream, startingLoop?.stream]
    .flatMap(stream => stream?.getAudioTracks() ?? []).filter(track => track.readyState === "live");
  if (tracks.some(track => track.enabled && !track.muted) && !microphoneTrouble) return "on";
  if (microphoneTrouble || tracks.some(track => track.muted)) return "error";
  if (tracks.length > 0) return "paused";
  const requesting = (openingMic && manualRequestGeneration === stoppedGeneration) || ui.phase === "starting" || ui.checkingMic;
  return requesting && ui.stopping !== true ? "requesting" : "off";
}

function captureChanged() {
  const capture = captureState();
  if (ui.capture !== capture) set({ capture });
}
let reminderTimer: ReturnType<typeof setInterval> | undefined;
let reminderSeen: string | undefined;
let reminderNight = false;
let recoverable = false;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let sessionGeneration = 0;
let stoppedGeneration = 0;
let progress: BackendStatus | undefined;
let releaseVoiceProgress: (() => void) | undefined;
const busyRequests = new Set<symbol>();
let commandActionId: string | undefined;
const RECOVERY_KEY = "cheongeum.recovery";
const RECOVERY_DECLINED = "cheongeum.recoveryDeclined";
const PROGRESS_KEY = "cheongeum.progressSeq";

function tabStore(key: string, value?: string | null) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}
let messageSeq = 0;
/** 마이크 경로 신호음은 음성 안내 꺼짐과 관계없이 낸다. 결과·알림 신호음은 ui.tts를 따른다. */
const MIC_CUES = new Set<CueKind>(["start", "listen", "done", "stopped", "end"]);
const STOP_CUE_WINDOW_MS = 5000;
let stopCuedAt = 0;

/**
 * 지금 사용자가 정할 일(카드). 대화 창과 데스크톱 아바타가 같은 카드를 쓴다.
 * 아바타에는 카드 번호(id)와 선택지 이름만 보내고, 서버 쪽 참조(승인 번호·인계 번호)는 여기에만 둔다.
 * 한 카드는 한 번만 실행한다(consumed). 새 응답이 오면 같은 결정이어도 새 번호를 준다.
 */
const desk = {
  instance: crypto.randomUUID().slice(0, 8),
  revision: 0,
  seq: 0,
  card: undefined as CardView | undefined,
  // 청음 소개 중인 줄의 아바타 동작(없으면 null)
  introPose: null as string | null,
  consumed: new Set<string>(),
  dropped: new Set<string>(),
  sent: "",
  speaking: false,
  message: null as { id: string; text: string } | null,
  sleeping: false,
  wakeCount: 0,
  stopGeneration: null as number | null,
  stopping: null as Promise<void> | null,
  waking: null as { generation: number; sid: string; promise: Promise<boolean> } | null,
};

function cue(kind: CueKind) {
  if (!MIC_CUES.has(kind) && !ui.tts) return Promise.resolve();
  return earcon(kind);
}

function cueStopped() {
  stopCuedAt = Date.now();
  void cue("stopped");
}

const listeners = new Set<() => void>();
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function snapshot() { return ui; }

function render() {
  syncCard();
  const card = desk.card;
  const remoteSpeech = edge !== undefined && ui.phase === "speaking" && !edge.audio.paused && !edge.audio.muted;
  ui = { ...ui, card, cardTaken: card !== undefined && desk.consumed.has(card.id), speaking: desk.speaking || remoteSpeech,
    sleeping: desk.sleeping, capture: captureState(), edge: edge !== undefined };
  for (const listener of listeners) listener();
  publishDesktop();
}

function set(patch: Partial<typeof ui>) {
  if (patch.busy === true || patch.phase === "hearing" || patch.phase === "thinking") desk.message = null;
  if (patch.lang !== undefined && patch.lang !== ui.lang && patch.announcement === undefined) {
    patch = { ...patch, announcement: { text: "", seq: ui.announcement.seq } };
  }
  ui = { ...ui, ...patch };
  render();
}

function holdBusy(patch: Partial<typeof ui> = {}) {
  const request = Symbol();
  busyRequests.add(request);
  set({ ...patch, busy: true });
  return () => {
    if (busyRequests.delete(request) && busyRequests.size === 0) set({ busy: false });
  };
}

function announce(text: string, channel: "status" | "transcript" = "status", lang = ui.lang) {
  if (channel === "transcript") push({ role: "assistant", text, lang });
  else set({ announcement: { text, seq: ui.announcement.seq + 1 } });
}

function setError(key: IssueKey, backgroundMic?: "speech" | "text") {
  if (ui.cancelUnconfirmed === true && key !== "cancelFailed") return;
  set({ error: key, errorSeq: ui.errorSeq + 1, backgroundMic, ...(key === "offline" ? { offline: true } : {}) });
}

function kindOf(error: unknown, fallback: IssueKey = "turnFailed"): IssueKey {
  if (!(error instanceof ApiError)) return fallback;
  if (error.kind === "timeout" || error.kind === "expired") return error.kind;
  if (error.kind === "network") return "offline";
  const code = error.code ?? "";
  if (/^(?:VOICE|STT|TTS)_/u.test(code)) return voiceIssue(voiceFault(error));
  if (code.includes("BLOCK") || code === "SITE_NOT_ALLOWED") return "blocked";
  return fallback;
}

function voiceIssue(fault: VoiceFault): IssueKey {
  switch (fault.code) {
    case "MIC_DENIED": return "micDenied";
    case "MIC_LOST": return "micLost";
    case "VOICE_KEY": case "VOICE_MODEL": return "voiceCredentials";
    case "VOICE_QUOTA": return "voiceQuota";
    case "VOICE_LIMIT": return "voiceLimit";
    default: return "voiceDown";
  }
}

let missedHeartbeats = 0;
let pendingResult: { sessionId: string; generation: number } | undefined;
let checkingResult: Promise<void> | undefined;

function connectionChanged(path: string, failure?: ApiError, requestSessionId?: string) {
  if (path === "/api/audio/speak" || path.endsWith("/progress")) return;
  const sid = ui.sessionId;
  if ((sid === undefined && path !== "/api/session" && path !== "/api/health") || path.endsWith("/detach") ||
      (requestSessionId !== undefined && requestSessionId !== sid) ||
      (path.startsWith("/api/session/") && !path.startsWith("/api/session/" + sid + "/"))) return;
  if (failure === undefined) {
    if (path.endsWith("/heartbeat") || ui.offline === true) missedHeartbeats = 0;
    if (ui.offline === true) {
      set({ offline: false, error: ui.error === "offline" ? undefined : ui.error });
      if (sid !== undefined) checkResearchAfterLoss(sid);
      if (pendingResult !== undefined && !path.endsWith("/state") && !path.endsWith("/resume")) void reconcileResult();
    }
    return;
  }
  const lost = path.endsWith("/heartbeat") ? ++missedHeartbeats >= 2 : failure.kind === "network";
  if (lost && ui.offline !== true) {
    endConversation(false);
    manualRequestGeneration = -1;
    recording?.cancel();
    recording = undefined;
    manualStream?.getTracks().forEach(track => track.stop());
    manualStream = undefined;
    progress?.stop();
    set({ offline: true, listening: false, error: ui.cancelUnconfirmed === true ? "cancelFailed" : pendingResult ? "lostTurn" : "offline", errorSeq: ui.errorSeq + 1 });
  }
}

type ServerState = Awaited<ReturnType<typeof api.resume>> | Awaited<ReturnType<typeof api.sessionState>>;

function applyServerState(state: ServerState, error: IssueKey | undefined) {
  const last = "consent" in state
    ? { authHandoff: state.authHandoff, turnId: state.turnId, offeredChoices: state.offeredChoices }
    : { pendingConfirmation: state.pendingConfirmation, authHandoff: state.authHandoff, turnId: state.turnId, offeredChoices: state.offeredChoices };
  const decision = currentDecision({ ...ui, state: state.state, last });
  // 서버가 아직 기다리는 승인과 선택지만 새 카드 번호로 다시 고를 수 있다.
  if (decision?.kind === "approval" || decision?.kind === "offer") desk.dropped.delete(decision.key);
  if (state.state === "STOPPED") { desk.sleeping = true; desk.stopGeneration = state.stopGeneration ?? null; }
  set({ state: state.state, last, error });
}

async function reconcileResult() {
  if (checkingResult) return checkingResult;
  const pending = pendingResult;
  if (!pending || pending.sessionId !== ui.sessionId || pending.generation !== stoppedGeneration) return;
  const current = () => pendingResult === pending && ui.sessionId === pending.sessionId && stoppedGeneration === pending.generation;
  const run = async () => {
    try {
      // 복구를 켠 개인 세션만 복구 체크포인트를 읽는다. 이미 붙어 있는 세션은 현재 상태만 조회한다.
      let state: ServerState;
      if (recoverable) {
        try { state = await api.resume(pending.sessionId); }
        catch (e) { if (errorCode(e) !== "RECOVERY_NOT_WAITING") throw e; state = await api.sessionState(pending.sessionId); }
      } else state = await api.sessionState(pending.sessionId);
      if (!current()) return;
      pendingResult = undefined;
      applyServerState(state, ui.error === "timeout" ? "timeout" : "lostTurn");
      checkResearchAfterLoss(pending.sessionId);
    } catch { if (current() && ui.error !== "timeout") setError("lostTurn"); }
  };
  checkingResult = run().finally(() => { checkingResult = undefined; });
  return checkingResult;
}

function turnFailed(error: unknown, sid: string, generation: number) {
  if (sid !== ui.sessionId || generation !== stoppedGeneration) return;
  const key = kindOf(error);
  if (key === "offline" || key === "timeout") {
    if (desk.card !== undefined) desk.dropped.add(desk.card.key);
    pendingResult = { sessionId: sid, generation };
    setError(key === "timeout" ? "timeout" : "lostTurn");
    void reconcileResult();
  } else setError(key);
}

export async function actOnIssue(action: IssueAction) {
  if (action === "stop") return stopAll();
  if (action === "type") { focus("command"); return; }
  if (action === "microphone") {
    const dialog = document.getElementById("microphone-settings");
    if (dialog instanceof HTMLDialogElement && !dialog.open) dialog.showModal();
    return;
  }
  if (pendingResult) return reconcileResult();
  if (ui.sessionId === undefined) { await chooseSession(); return; }
  const sid = ui.sessionId;
  const generation = stoppedGeneration;
  try {
    if (action === "check") {
      const state = await api.sessionState(sid);
      if (sid !== ui.sessionId || generation !== stoppedGeneration) return;
      applyServerState(state, ui.error);
    } else await api.heartbeat(sid);
    if (ui.cancelUnconfirmed !== true && (ui.error === "expired" || ui.error === "timeout")) set({ error: undefined });
  } catch (error) { setError(kindOf(error)); }
}

let focusSeq = 0;
function focus(id: string, extra: { scroll?: string; fallback?: string } = {}) {
  set({ focus: { id, seq: ++focusSeq, ...extra } });
}

function push(m: Omit<LogEntry, "id" | "who">) {
  const id = `${Date.now()}-${messageSeq++}`;
  const who = workspaceText(m.role === "user" ? "나" : m.role === "assistant" ? "청음" : "안내", ui.lang) + ": ";
  set({ messages: [...ui.messages, { lang: ui.lang, ...m, id, who }] });
  return id;
}

function recordConsent(reply?: string, lang = ui.lang) {
  if (!ui.messages.some(m => m.consentRecord !== undefined)) {
    push({
      role: "assistant", summary: workspaceText("시작 안내와 동의 기록", ui.lang), text: consentText(),
      consentRecord: { outcomes: [], ...(ui.voiceMode.tts ? { replay: workspaceText("시작 안내 다시 듣기", ui.lang) } : {}) },
    });
  }
  if (reply !== undefined && reply.length > 0) {
    set({ messages: ui.messages.map(m => m.consentRecord === undefined ? m : { ...m, consentRecord: { ...m.consentRecord, outcomes: [...m.consentRecord.outcomes, { text: reply, lang }] } }) });
  }
}

// ---------------------------------------------------------------- 그리기

function syncCard() {
  const decision = currentDecision(ui);
  const next = decision !== undefined && !desk.dropped.has(decision.key) ? decision : undefined;
  if (next?.key === desk.card?.key && (next === undefined || desk.card?.lang === ui.lang)) return;
  desk.card = next === undefined ? undefined : { ...next, lang: ui.lang, id: `${desk.instance}-${++desk.seq}` };
}

/** 데스크톱 앱이면 아바타 창에 표시 상태를 보낸다(바뀐 때만, 번호를 늘려 순서를 정한다). */
function publishDesktop() {
  if (desktop?.publish === undefined) return;
  const view = desktopView(ui, {
    capture: ui.capture ?? "off",
    speaking: desk.speaking,
    recording: recording !== undefined,
    message: desk.message,
    sleeping: desk.sleeping,
    introPose: desk.introPose,
    card: desk.card,
    pending: desk.card !== undefined && desk.consumed.has(desk.card.id),
  });
  const snapshot = { ...view, micDiagnostic: view.mode === "problem" && ui.backgroundMic !== undefined && ui.error !== undefined ? t(issues[ui.error][0]) : undefined };
  const text = JSON.stringify(snapshot);
  if (text === desk.sent) return;
  desk.sent = text;
  desktop.publish({ instance: desk.instance, revision: ++desk.revision, ...snapshot });
}

function setPhase(p: Phase) {
  if (ui.phase === p) return;
  set({ phase: p });
  if (p === "listening") announce(t("듣고 있습니다. 말씀하세요."));
}

function desktopNotice(text: string | null) {
  return text !== null && text.length > 0 ? { id: `m-${++desk.seq}`, text } : null;
}

function wakeAvatar() {
  if (!desk.sleeping || ui.cancelUnconfirmed === true) return;
  desk.sleeping = false;
  desk.wakeCount += 1;
  stopSpeaking();
  publishDesktop();
}

// The first deliberate request after Stop waits for that specific cancellation.
// Opening chat wakes the figure alone. Recording and commands also wake the session.
async function readyForInput() {
  if (ui.offline === true || ui.cancelUnconfirmed === true) return false;
  const sid = ui.sessionId;
  const stop = stoppedGeneration;
  wakeAvatar();
  if (desk.stopping !== null) await desk.stopping;
  if (sid === undefined || sid !== ui.sessionId || stop !== stoppedGeneration) return false;
  const generation = desk.stopGeneration;
  if (generation === null) return true;
  if (desk.waking?.generation === generation && desk.waking.sid === sid) return desk.waking.promise;
  const current = () => sid === ui.sessionId && stop === stoppedGeneration && generation === desk.stopGeneration;
  const promise = api.wake(sid, generation).then(({ state }) => {
    if (!current()) return false;
    desk.stopGeneration = null;
    set({ state });
    return true;
  }).catch((error: unknown) => {
    if (current()) {
      desk.sleeping = true;
      setError(kindOf(error));
    }
    return false;
  });
  desk.waking = { generation, sid, promise };
  try {
    return await promise;
  } finally {
    if (desk.waking?.promise === promise) desk.waking = null;
  }
}

// ---------------------------------------------------------------- 응답·음성

type TurnOptions = { sent?: TimingPoint; capture?: TimingPoint; stop?: TimingPoint; controlLabel?: string };
async function applyResult(result: Turn, speakIt = true, sleepOnStop = true, trace?: TurnOptions) {
  const apply = () => applyTurnResult(result, speakIt, sleepOnStop, trace);
  return result.localSpeechOnly === true ? withPrivateReadback(apply) : apply();
}

async function applyTurnResult(result: Turn, speakIt: boolean, sleepOnStop: boolean, trace?: TurnOptions) {
  let r = result;
  const prevTurn = ui.last?.turnId;
  if (ui.sessionId === undefined || r.sessionId !== ui.sessionId || prevTurn === r.turnId) return;
  const language = responseLanguage(r);
  if (language !== ui.lang) {
    const generation = stoppedGeneration;
    await loadWorkspaceLanguage(language);
    if (generation !== stoppedGeneration || r.sessionId !== ui.sessionId || ui.last?.turnId !== prevTurn) return;
  }
  syncDesktopLanguage(language);
  if (r.intentType === "READ_START_GUIDE") r = { ...r, speech: consentText(r.lang) };
  if (r.intentType === "SETUP_RESTART") {
    // 처음 설정 화면이 녹음한 문장을 틀므로 응답은 말하지 않는다
    speakIt = false;
    endConversation(false);
    void firstRun.start(1);
  }
  const prevState = ui.state;
  const stopped = r.intentType === "STOP" || r.semanticAction === "stop";
  if (stopped && desk.stopping === null) {
    stoppedGeneration++;
    progress?.stop();
    busyRequests.clear();
    set({ busy: false });
  }
  const stop = trace?.stop ?? (stopped ? timing?.confirmedStop(trace?.sent?.time) : undefined);
  const wake = desk.wakeCount;
  if (r.state === "STOPPED" && r.stopGeneration !== undefined && Number.isInteger(r.stopGeneration)) desk.stopGeneration = r.stopGeneration;
  else if (r.state !== "STOPPED") desk.stopGeneration = null;
  if (stopped && sleepOnStop) {
    desk.sleeping = true;
    if (conversationOn || startingLoop !== undefined) endConversation(false);
  } else if (r.state !== "STOPPED") {
    desk.sleeping = false;
  }
  let confirmationRestart: number | undefined;
  if (r.pendingConfirmation !== undefined && edge !== undefined) {
    endConversation(false);
    confirmationRestart = conversationStarts;
  }
  if (r.authHandoff?.status === "waiting") {
    microphoneTrouble = false;
    endConversation(false);
    recording?.cancel();
    recording = undefined;
    set({ listening: false });
  }
  setSpeechLang(language);
  if (r.speechPrefs !== undefined) applySpeechPrefs(r.speechPrefs);
  edge?.setLanguage(language, speechSpeed(ui.baseSpeed, speechPace(speechPrefs.rate)));
  // 새 응답: 남아 있는 결정이어도 새 카드 번호로(이전 화면에서 누른 버튼은 무효)
  desk.card = undefined;
  desk.dropped.clear();
  desk.message = desktopNotice(turnNotice(r));
  const isConsent = r.intentType === "CONSENT" || r.semanticAction === "consent";
  const hasTurn = ui.hasTurn || (!isConsent && r.semanticAction !== "set-language");
  set({ last: r, state: r.state, lang: language, hasTurn, error: undefined });
  const receipt = pendingReceipt(r);
  if (receipt !== undefined) {
    claimedReading = { token: receipt.token, turnId: r.turnId };
    presentedResearch.add(receipt.token);
  }
  if (r.researchDelivery === "queued") researchStarted();
  if (r.researchDelivery === "outcome") presentedResearch.add(r.turnId);
  if (isConsent) {
    recordConsent(ui.consent === "granted" ? r.speech : undefined, r.lang);
    if (ui.consent !== "granted") announce(r.speech, "transcript", r.lang);
  } else {
    push({ role: "user", text: trace?.controlLabel ?? r.userUtterance });
    announce(r.speech, "transcript", r.lang);
  }
  timing?.measure(trace?.sent, "result-applied");
  timing?.afterPaint(trace?.capture, "transcript-shown");
  timing?.afterPaint(stop, "stopped-state-paint", () =>
    r.turnId === ui.last?.turnId && document.getElementById("st-state")?.dataset.state === "STOPPED");
  const kind = stopped && !sleepOnStop ? undefined : transitionCue(prevState, r.state);
  if (kind !== undefined && !(kind === "stopped" && Date.now() - stopCuedAt < STOP_CUE_WINDOW_MS)) await cue(kind);
  if (r.turnId !== ui.last?.turnId || (stopped && wake !== desk.wakeCount)) return;
  if (r.introScript !== undefined && r.introScript.length > 0 && speakIt) {
    void playIntro(r);
  } else if (confirmationRestart !== undefined) {
    await speakTurn(r);
    if (confirmationRestart === conversationStarts && r.turnId === ui.last.turnId) void startConversation();
  } else if (ui.tts && speakIt) {
    // 본인인증 인계: 안내 한 번만 말하고 TTS를 멈춰 화면 낭독기가 입력 칸을 읽게 한다
    if (r.state === "AUTH_HANDOFF") void speakTurn(r).then(() => stopSpeaking());
    else void speakTurn(r);
  } else if (researchSilent() && (r.researchDelivery === "outcome" || receipt !== undefined)) {
    void speakTurn(r);
  }
}

function speak(text: string) {
  void speakAndWaitFrom(text);
}

export async function speakResearch(text: string, lang?: Lang): Promise<boolean> {
  return ui.workspaceAvailable && ui.consent === "granted" && await speakAndWaitFrom(text, 0, speechPrefs.rate, lang);
}

const ACTIVE_RESEARCH_POLL_MS = 2000;
const presentedResearch = new Set<string>();
let claimedReading: { token: string; turnId: string } | undefined;
const heardReadings = new Set<string>();
const researchChunks = new Map<string, number>();
const researchSilent = () => ui.voiceMode.known && (narrationMuted || !ui.voiceMode.tts);
async function playResearch(token: string, text: string, lang?: Lang) {
  const heard = researchSilent() || await speakAndWaitFrom(text, researchChunks.get(token) ?? 0, speechPrefs.rate, lang,
    next => researchChunks.set(token, next));
  if (heard) researchChunks.delete(token);
  return heard;
}
function canReportResearch() {
  return ui.consent === "granted" && !ui.busy && !ui.speaking && !isSpeechReserved() && !ui.listening &&
    !desk.sleeping && ui.state !== "AUTH_HANDOFF" && ui.state !== "WAITING_FOR_USER_CONFIRMATION" &&
    ui.phase !== "thinking" && ui.phase !== "hearing";
}
function presentResearch(token: string, text: string, lang: Lang) {
  if (!presentedResearch.has(token)) {
    announce(text, "transcript", lang);
    presentedResearch.add(token);
  }
}
function readingHolds(token: string) {
  return (claimedReading?.token === token && claimedReading.turnId === ui.last?.turnId) || researchPlayback.has(token) || heardReadings.has(token);
}
export async function deliverResearch(token: string, text: string, lang: Lang): Promise<boolean> {
  if (!ui.workspaceAvailable || !canReportResearch() || readingHolds(token)) return false;
  presentResearch(token, text, lang);
  const heard = await playResearch(token, text, lang);
  if (heard) presentedResearch.delete(token);
  return heard;
}

const researchPlayback = new Map<string, Promise<boolean>>();
const heardOutcomes = new Set<string>();
let researchRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
let recoveringResearch = false;

function scheduleResearchCheck(id: string, delay: number) {
  if (ui.sessionId !== id) return;
  clearTimeout(researchRecoveryTimer);
  researchRecoveryTimer = setTimeout(() => checkResearchAfterLoss(id), delay);
}

/** 회선이 끊긴 뒤에는 명령을 다시 보내지 않고, 끝난 조사 응답만 받는다. */
function checkResearchAfterLoss(id: string) {
  if (ui.sessionId === id && ui.workspaceAvailable && ui.consent === "granted") researchStarted();
  if (recoveringResearch || ui.sessionId !== id || ui.consent !== "granted" || desk.sleeping) return;
  const generation = stoppedGeneration;
  const current = () => ui.sessionId === id && stoppedGeneration === generation;
  recoveringResearch = true;
  void (async () => {
    try {
      const {outcomes, working} = await api.researchOutcomes(id);
      if (!current()) return;
      for (const outcome of outcomes) {
        if (!current()) return;
        if (!canReportResearch()) { scheduleResearchCheck(id, ACTIVE_RESEARCH_POLL_MS); return; }
        if (ui.error === "timeout" || ui.error === "lostTurn") set({error: undefined});
        if (!heardOutcomes.has(outcome.turnId) && tabStore("cheongeum.heard." + outcome.turnId) !== "1") {
          presentResearch(outcome.turnId, outcome.speech, outcome.lang);
        }
        if (!await speakTurn({...outcome, sessionId: id, researchDelivery: "outcome"})) return;
      }
      if (working && current()) scheduleResearchCheck(id, ACTIVE_RESEARCH_POLL_MS);
    } catch { if (current()) scheduleResearchCheck(id, RESEARCH_POLL_MS); }
    finally { recoveringResearch = false; }
  })();
}

// 청음 소개: 줄마다 카드(정지 그림·글)를 보이고 아바타에 그 동작을 보낸 뒤 말한다.
// Esc·건너뛰기는 남은 줄을 넘기되, 묻는 줄(ask: 연습 신청서 제안)은 말한다.
let introRun = 0;
let introSkipped = false;

async function playIntro(result: Turn) {
  const run = ++introRun;
  introSkipped = false;
  try {
    for (const line of result.introScript ?? []) {
      if (run !== introRun) return;
      if (introSkipped && line.ask !== true) continue;
      desk.introPose = line.ask === true ? null : line.pose;
      set({ intro: { text: line.text, pose: line.pose } });
      if (ui.tts && ui.voiceMode.tts) await speakTurn(result, line.text);
      else await new Promise((done) => setTimeout(done, 2500));
    }
  } finally {
    if (run === introRun) {
      desk.introPose = null;
      set({ intro: undefined });
    }
  }
}

export function skipIntro() {
  if (ui.intro === undefined) return false;
  introSkipped = true;
  stopSpeaking();
  return true;
}

export function stopSpeaking() {
  serverTts.cancel();
  if (edge !== undefined && (ui.phase === "speaking" || edge.hasNativeSpeech)) edge.interrupt();
}

let speechOutputError: number | undefined;
function showSpeechError(key: IssueKey) {
  const previous = ui.errorSeq;
  setError(key);
  if (ui.errorSeq !== previous) speechOutputError = ui.errorSeq;
}

export async function speakAndWaitFrom(text: string, fromChunk = 0, rate = speechPrefs.rate, lang = getSpeechLang(),
  onChunkPlayed?: (nextChunk: number) => void): Promise<boolean> {
  if (!ui.tts || !ui.voiceMode.tts || text.trim().length === 0) return false;
  try {
    const result = await serverTts.speak(text, (chunk, speed, signal) => api.speak(chunk, lang, speed, signal), fromChunk, rate, lang, onChunkPlayed);
    if (result === "blocked") showSpeechError("playbackBlocked");
    if (result === "played" && ui.errorSeq === speechOutputError) {
      speechOutputError = undefined;
      set({ error: undefined });
    }
    return result === "played";
  } catch (error) {
    const code = errorCode(error);
    if (code === "VOICE_KEY" || code === "VOICE_QUOTA") desktop?.showSetup?.();
    showSpeechError(voiceIssue(voiceFault(error)));
    return false;
  }
}

const speakAndWait = (text: string) => speakAndWaitFrom(text);

type Spoken = Pick<Turn, "speech"> & Partial<Pick<Turn, "localSpeechOnly" | "lang" | "authHandoff" | "turnId" | "sessionId" | "researchDelivery" | "savedResearch">>;

function pendingReceipt(result: Pick<Spoken, "savedResearch" | "localSpeechOnly">) {
  const saved = result.savedResearch;
  return saved?.token !== undefined && result.localSpeechOnly !== true ? { jobId: saved.jobId, token: saved.token } : undefined;
}

function speakReading(sessionId: string, { jobId, token }: { jobId: string; token: string }, text: string, lang: Lang | undefined) {
  const current = researchPlayback.get(token);
  if (current !== undefined) return current;
  const play = async () => {
    if (heardReadings.has(token)) return true;
    const generation = stoppedGeneration;
    const heard = await playResearch(token, text, lang);
    if (!heard || sessionId !== ui.sessionId || stoppedGeneration !== generation) {
      if (claimedReading?.token === token) claimedReading = undefined;
      return false;
    }
    heardReadings.add(token);
    presentedResearch.delete(token);
    if (!await recordHeard(sessionId, jobId, token)) researchStarted();
    return true;
  };
  const playing = play().finally(() => researchPlayback.delete(token));
  researchPlayback.set(token, playing);
  return playing;
}

async function speakTurn(result: Spoken, text = result.speech) {
  const id = result.sessionId, token = result.turnId;
  const receipt = pendingReceipt(result);
  if (receipt !== undefined && id !== undefined) return speakReading(id, receipt, text, result.lang);
  if (result.researchDelivery === "outcome" && token !== undefined && id !== undefined && result.localSpeechOnly !== true) {
    const current = researchPlayback.get(token);
    if (current !== undefined) return current;
    const play = async () => {
      const generation = stoppedGeneration;
      const receiptKey = "cheongeum.heard." + token;
      const heard = heardOutcomes.has(token) || tabStore(receiptKey) === "1" || await playResearch(token, text, result.lang);
      if (id !== ui.sessionId || stoppedGeneration !== generation) return false;
      if (heard) {
        heardOutcomes.add(token);
        tabStore(receiptKey, "1");
        try { await api.heardResearch(id, token); tabStore(receiptKey, null); } catch { scheduleResearchCheck(id, RESEARCH_POLL_MS); }
      } else scheduleResearchCheck(id, RESEARCH_POLL_MS);
      return heard;
    };
    const playing = play().finally(() => researchPlayback.delete(token));
    researchPlayback.set(token, playing);
    return playing;
  }
  if (result.localSpeechOnly !== true) return speakAndWaitFrom(text, 0, speechPrefs.rate, result.lang ?? getSpeechLang());
  const lang = getSpeechLang();
  const decision = currentDecision(ui);
  const cue = workspaceText("개인정보가 있는 안내를 대화 기록에 표시했어요. 화면 낭독기로 내용을 들을 수 있어요.", lang);
  // 카드 종류만으로 만든 질문은 공개 안내이다. 값과 원문은 로컬 접근성 기록에서만 읽는다.
  const purpose = result.authHandoff?.status === "waiting" ? workspaceText("마이크를 껐어요. 사이트에서 직접 로그인이나 본인 확인을 마쳐 주세요.", lang)
    : decision?.kind === "approval" ? decision.prompt : "";
  return withPrivateReadback(() => speakAndWaitFrom([purpose, cue].filter(Boolean).join(" "), 0, speechPrefs.rate, lang));
}

// 대화 시작 번호: 끝내기(인증 인계·멈춤·종료)가 늘려, 마이크를 여는 사이에 끝내라는 요청이 오면 시작을 그만둔다
let conversationStarts = 0;
let startingLoop: VoiceLoop | LiveConversation | undefined;
let edge: LiveConversation | undefined;

export function endConversation(withCue = true) {
  conversationStarts += 1;
  releaseVoiceProgress?.();
  releaseVoiceProgress = undefined;
  startingLoop?.stop();
  startingLoop = undefined;
  edge?.stop();
  edge = undefined;
  if (ui.liveCaption.length > 0) set({ liveCaption: "" });
  if (withCue && conversationOn) void cue("end");
  conversationOn = false;
  loop?.stop();
  loop = undefined;
  setPhase("off");
}

export function suspendConversation() {
  const resume = conversationOn;
  endConversation(false);
  recording?.cancel();
  recording = undefined;
  stopSpeaking();
  set({listening: false});
  return resume;
}

/**
 * 핸즈프리 대화: 인사 → (듣기 → 서버로 보내 받아쓰기·실행 → 답 말하기) 반복.
 * 브라우저 정책상 마이크·소리는 사용자 동작이 한 번 필요해서 '대화 시작' 버튼으로 시작한다.
 */
export async function startConversation() {
  if (conversationOn || startingLoop !== undefined || ui.sessionId === undefined) return;
  unlockAudio();
  const ticket = ++conversationStarts;
  if (!await readyForInput() || ticket !== conversationStarts || ui.last?.authHandoff?.status === "waiting") return;
  if (!ui.voiceMode.stt) {
    setError("voiceDown");
    return;
  }
  if (ui.consent !== "granted") {
    setError("consentRequired");
    return;
  }
  void preloadCues().catch(() => undefined);
  set({ error: undefined });
  microphoneTrouble = false;
  setPhase("starting");
  const sessionId = ui.sessionId;
  if (ui.voiceMode.edge !== undefined && ui.voiceMode.edge.length > 0 && ui.conversationMode === "native") {
    let captionEnd = -1;
    const approvalId = ui.last?.pendingConfirmation?.actionId ?? "";
    const voiceFailure = (error: VoiceFault) => {
      if (ticket !== conversationStarts) return;
      endConversation(false);
      if (error.code === "VOICE_KEY" || error.code === "VOICE_QUOTA") desktop?.showSetup?.();
      setError(voiceIssue(error));
      checkResearchAfterLoss(sessionId);
    };
    const current: LiveConversation = new LiveConversation(sessionId, {
      offer: (socket, sdp) => api.voiceOffer(socket, sdp, approvalId), phase: setPhase, notice: () => setError("playbackBlocked"),
      captureChanged,
      recovered() {
        if (ticket !== conversationStarts) return;
        captionEnd = -1;
        set({ liveCaption: "", error: undefined });
        setPhase("listening");
        const message = t("음성 연결이 잠시 끊겼다가 다시 연결됐어요.");
        announce(message);
        if (ui.tts && ui.voiceMode.tts) {
          const lang = getSpeechLang();
          void reportVoiceRecovery((chunk, rate, signal) => api.speak(chunk, lang, rate, signal), lang).catch(() => {});
        }
        checkResearchAfterLoss(sessionId);
      },
      caption(event) {
        if (ticket !== conversationStarts || event.delta === undefined || event.delta.length === 0) return;
        const previous = event.start_ms - captionEnd > 1100 ? "" : ui.liveCaption;
        set({ liveCaption: (previous + event.delta).slice(-550) });
        captionEnd = event.end_ms;
      },
      async result(raw, exact) {
        if (ticket !== conversationStarts) return;
        const result = parseTurn(raw);
        current.language = result.lang;
        if (result.state === "STOPPED" || result.state === "AUTH_HANDOFF") {
          endConversation(false);
          await applyResult(result, true);
          return;
        }
        if (result.pendingConfirmation !== undefined) {
          await applyResult(result, false);
          return;
        }
        if (exact === true) {
          current.paused = true;
          current.updateAudio();
        }
        try {
          await applyResult(result, false);
          if (exact === true && ticket === conversationStarts) await speakTurn(result);
        } finally {
          if (ticket === conversationStarts) {
            current.paused = false;
            current.updateAudio();
            setPhase("listening");
          }
        }
      },
      failure: voiceFailure,
    });
    edge = startingLoop = current;
    current.enabled = ui.tts;
    current.language = ui.lang;
    try {
      await current.start(ui.micId);
      if (ticket !== conversationStarts) return;
      releaseVoiceProgress = progress?.watch();
      startingLoop = undefined;
      conversationOn = true;
      setPhase("listening");
      await cue("start");
    } catch (error) {
      if (ticket !== conversationStarts) return;
      voiceFailure(voiceFault(error));
    }
    return;
  }
  const current = new VoiceLoop(() => api.liveAudio(sessionId));
  current.ignore = () => desk.speaking;
  current.captureChanged = captureChanged;
  startingLoop = current;
  function reportMicTrouble(ended: boolean, key: IssueKey = "micLost") {
    const background = BACKGROUND && desktop?.isDesktop === true;
    const speakError = background && ended && ui.tts && ui.voiceMode.tts;
    setError(key, background ? speakError ? "speech" : "text" : undefined);
    if (ended) void cue("problem").then(() => {
      if (speakError && ui.error === key) void speakAndWait(t(issues[key][0]));
    });
  }
  try {
    // 저장된 마이크가 없으면 권한을 받은 뒤 내장 마이크를 골라 다시 연다(아이폰 연속성 마이크 회피).
    await current.start(ui.micId);
    const list = await listMicrophones().catch(() => []);
    set({ mics: list });
    const preferred = ui.micId ?? preferredMicrophone(list);
    if ((ui.micId === undefined || ui.micId.length === 0) && preferred !== undefined && preferred.length > 0 && list.length > 1) {
      if (ticket !== conversationStarts) throw new Error("stopped");
      current.stop();
      await current.start(preferred);
      set({ micId: preferred });
    }
    if (await current.isSilent()) throw new Error("silent");
  } catch (error) {
    current.stop();
    if (ticket !== conversationStarts) return;
    startingLoop = undefined;
    microphoneTrouble = true;
    setPhase("off");
    const key: IssueKey = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name) ? "micDenied" : "micLost";
    reportMicTrouble(true, key);
    return;
  }
  if (ticket !== conversationStarts) {
    current.stop();
    return;
  }
  startingLoop = undefined;
  current.onTrouble = (reason) => {
    if (ticket !== conversationStarts) return;
    microphoneTrouble = reason !== "unmuted" && reason !== "ended";
    if (reason === "unmuted") {
      if (ui.error === "micLost") set({ error: undefined });
      else captureChanged();
      return;
    }
    reportMicTrouble(reason === "ended", "micLost");
    // 잠깐 끊김(mute)은 다시 연결될 수 있으니 대화를 끝내지 않는다. 장치가 아예 사라졌을 때만 끝낸다.
    if (reason === "ended") {
      endConversation(false);
    }
  };
  void current.startClapDetector(() => talkNow(), ui.micId);
  loop = current;
  conversationOn = true;
  setPhase("speaking");
  await cue("start");
  const greeting = GREETINGS[ui.lang];
  push({ role: "assistant", text: greeting });
  await speakAndWait(greeting);

  let failures = 0;
  let missed = 0;
  while (loop === current && conversationOn) {
    setPhase("listening");
    await cue("listen");
    // 승인은 듣기 시작할 때 있던 결정에만 묶는다(듣는 사이에 새로 뜬 승인을 '응'으로 하지 않게)
    const asked = ui.last?.pendingConfirmation?.actionId ?? "";
    const audio = await current.listenOnce(() => setPhase("hearing"));
    if (audio === null || loop !== current) { audio?.cancel(); break; }
    void cue("done");
    setPhase("thinking");
    const turnGeneration = stoppedGeneration;
    try {
      const { result: r, capture, sent } = await voiceTurn(audio, asked, current);
      if (sessionId !== ui.sessionId || turnGeneration !== stoppedGeneration) break;
      failures = 0;
      missed = 0;
      await applyResult(r, loop !== current || r.state === "STOPPED", true, { sent, capture });
      if (loop !== current) break;
      setPhase("speaking");
      // 끼어들기: 안내 중에 사용자가 말하면 안내를 멈추고 바로 듣는다.
      // 2초 안에 말이 없으면 거짓 끼어들기로 보고 멈춘 안내를 이어 말한다.
      let barged = false;
      const stopWatch = current.watchBargeIn(() => {
        barged = true;
        stopSpeaking();
      });
      await speakTurn(r);
      stopWatch();
      if (barged && conversationOn) {
        const interrupted = takeInterruptedSpeech();
        const resumeAnswer = async () => {
          if (interrupted?.kind !== "server" || interrupted.text.length === 0) return;
          setPhase("speaking");
          if ((r.researchDelivery === "outcome" && r.localSpeechOnly !== true) || pendingReceipt(r) !== undefined) await speakTurn(r);
          else await speakAndWaitFrom(interrupted.text, interrupted.fromChunk);
        };
        setPhase("listening");
        const bargeAsked = ui.last?.pendingConfirmation?.actionId ?? "";
        const clip = await current.listenAfterBarge(2000, () => setPhase("hearing"));
        if (clip === null) {
          await resumeAnswer();
          continue;
        }
        void cue("done");
        setPhase("thinking");
        const bargeGeneration = stoppedGeneration;
        try {
          const { result: again, capture, sent } = await voiceTurn(clip, bargeAsked, current);
          if (sessionId !== ui.sessionId || bargeGeneration !== stoppedGeneration) break;
          await applyResult(again, loop !== current || again.state === "STOPPED", true, { sent, capture });
          if (loop !== current) break;
          setPhase("speaking");
          await speakTurn(again);
        } catch (be) {
          if (interrupted?.kind === "server" && interrupted.text.length > 0 && errorCode(be) === "EMPTY_TRANSCRIPT") {
            await resumeAnswer();
          } else {
            throw be;
          }
        }
      }
    } catch (e) {
      if (loop !== current) break;
      const message = errorMessage(e);
      if (errorCode(e) === "EMPTY_TRANSCRIPT") {
        setPhase("speaking");
        await cue("problem");
        if (++missed >= 2) {
          await speakAndWait(t("마이크에서 말씀을 구분하기 어려워 듣기를 잠시 멈췄어요. 준비되면 대화 시작을 눌러 주세요."));
          break;
        }
        await speakAndWait(message);
        continue;
      }
      if (voiceFault(e).retryable && ++failures < 3 && ui.offline !== true) {
        await speakAndWait(t("말씀을 끝까지 받지 못했어요. 한 번 더 말씀해 주세요."));
        continue;
      }
      setError(ui.offline === true ? "offline" : voiceIssue(voiceFault(e)));
      await cue("problem");
      await speakAndWait(t("문제가 계속되어 대화 모드를 끝냅니다. 텍스트로 입력해 주세요."));
      break;
    }
    // 스피커 소리 잔향이 마이크로 들어가지 않게 잠깐 쉰다.
    await new Promise((r) => setTimeout(r, 300));
  }
  if (loop === current) endConversation();
}

function parseTurn(raw: unknown): Turn {
  return api.parseTurn(raw);
}

/** 대화 모드의 음성 한 턴. 보내는 동안 떠 있는 카드를 잡아 버튼과 말이 함께 나가지 않게 한다. */
async function voiceTurn(audio: LiveAudio, asked: string, voice: VoiceLoop) {
  const sid = ui.sessionId ?? "";
  const generation = stoppedGeneration;
  const held = holdCard();
  const capture = timing?.begin("capture-end");
  const sent = timing?.measure(capture, "turn-sent");
  try {
    const result = await whileBusy(api.audioTurn(sid, audio, asked), voice);
    return { result, capture, sent };
  } catch (error) {
    timing?.measure(sent, "turn-failed");
    if (error instanceof ApiError && (error.kind === "network" || error.kind === "timeout")) turnFailed(error, sid, generation);
    throw error;
  } finally {
    releaseCard(held);
  }
}

/** 서버가 일하는 동안 한 줄로 표시하고, 대화 모드면 멈춤과 진행 질문을 듣는다. */
async function whileBusy<T>(work: Promise<T>, voice?: VoiceLoop) {
  const release = progress?.watch();
  const stopListening = voice === undefined ? undefined : listenForStopWhileBusy(voice);
  if (voice !== undefined) releaseVoiceProgress = release;
  try {
    return await work;
  } finally {
    release?.();
    if (releaseVoiceProgress === release) releaseVoiceProgress = undefined;
    stopListening?.();
  }
}

/**
 * 일하는 동안에도 '멈춰'와 '지금 어디까지 했어?'는 듣는다. 서버가 그 둘만 실행하고(진행 물음은 답을 말한다) 나머지는 버린다.
 * 반환값을 부르면 듣기를 그친다.
 */
function listenForStopWhileBusy(voice: VoiceLoop) {
  let on = true;
  void (async () => {
    while (on && conversationOn) {
      const clip = await voice.listenOnce();
      if (clip === null || !on) { clip?.cancel(); break; }
      try {
        const sentAt = timing === undefined ? undefined : performance.now();
        const r = await api.audioStop(ui.sessionId ?? "", clip);
        if (loop !== voice) break;
        if (r.stopped) {
          const stop = timing?.confirmedStop(sentAt);
          cueStopped();
          announce(t("멈출게요."));
          if (r.result !== undefined) await applyResult(r.result, true, true, { stop });
          break;
        } else if (on && r.result !== undefined) {
          await applyResult(r.result, false);
          if (on && loop === voice) await speakTurn(r.result);
        }
      } catch {
        // 멈춤 확인이 실패해도 계속 듣는다. 일반 멈춤 버튼과 단축키는 그대로 쓸 수 있다.
      }
    }
  })();
  return () => {
    on = false;
    voice.cancelListening();
  };
}

/**
 * '지금 말하기' — 버튼·스페이스·박수 두 번이 모두 같은 일을 한다.
 *  안내 중이면 끊고 바로 듣기, 말하는 중이면 말 끝으로 보고 바로 보내기, 일하는 중이면 멈추기, 대화가 꺼져 있으면 시작.
 */
export function talkNow() {
  if (ui.offline === true) { void actOnIssue("reconnect"); return; }
  if (ui.settings !== undefined) return;
  // 백그라운드 데스크톱 앱: 창이 없어 Enter를 누를 수 없으므로 동의 안내 중의 단축키 = 동의
  if (ui.consent === "intro") { void hearConsent(); return; }
  if (ui.consent === "ask") { void answerConsent(true); return; }
  if (!conversationOn && ui.last?.authHandoff?.status === "waiting") {
    // 인증 중에는 마이크를 켜지 않는다(비밀번호를 듣지 않게). 조용히 무시하지 않고 다음에 할 일을 알린다.
    const label = desk.card?.choices.find((c) => c.key === "auth-done")?.label ?? t("로그인했어요");
    notice(t("지금은 사이트에서 직접 로그인하는 중이라 마이크를 꺼 두었어요. 마치면 컨트롤, 시프트, K를 누르고 '{label}'를 고르세요.", { label }));
    return;
  }
  if (!conversationOn) {
    if (ui.consent === "granted") void startConversation();
    return;
  }
  if (edge !== undefined && ui.phase === "thinking") { void stopAll(); return; }
  if (ui.phase === "speaking" || edge?.hasNativeSpeech === true) {
    stopSpeaking();
    announce(t("안내를 멈췄습니다. 말씀하세요."));
  } else if (ui.phase === "hearing") {
    loop?.endUtterance();
  } else if (ui.phase === "thinking") {
    // 창이 없는 데스크톱 모드에서는 단축키가 유일한 멈춤 수단이다.
    void stopAll();
  }
}

// ---------------------------------------------------------------- 동의

function setConsent(consent: Consent | undefined) {
  set({ consent });
  // 준비되면 동의 버튼 또는 '대화 시작' 버튼에 포커스: Enter 한 번으로 진행할 수 있게.
  if (ui.sessionId === undefined) return;
  if (consent === "intro") focus("consent-hear");
  else if (consent === "ask") focus("consent-yes");
  else if (consent === "granted") {
    focus(ui.voiceMode.stt ? "conv-start" : "command");
    startReminders();
  }
}

/** 1단계: 안내 듣기(이 버튼 누름으로 소리 재생이 허용된다). 2단계: Enter=동의, Esc=거부 */
export async function hearConsent() {
  unlockAudio();
  void preloadCues().catch(() => undefined);
  setConsent("ask");
  await healthReady;
  recordConsent();
  if (!ui.voiceMode.tts) {
    set({ consentDetailsOpen: ui.consentDetailsOpen + 1 });
    return;
  }
  const mac = env.mac;
  const modifier = mac ? "Command" : "Control";
  const brief = {
    ko: "청음입니다. 공공서비스 화면을 읽어 드려요. 음성과 안내 문장은 음성 API로, 질문과 화면 내용은 설정한 AI로 보낼 수 있어요. 비밀번호는 말하지 마세요. "
      + (BACKGROUND ? "동의하려면 " + (mac ? "커맨드" : "컨트롤") + " 시프트 스페이스를 함께 누르세요." : "동의는 엔터, 거절은 이스케이프예요."),
    en: "Cheongeum can read public service pages for you. Audio and narration go to the speech API. Your question and page text may go to your configured AI. Keep passwords private. "
      + (BACKGROUND ? "Press " + modifier + ", Shift and Space together to agree." : "Press Enter to agree or Escape to decline."),
    zh: "青音可以为您朗读公共服务网页。语音和朗读文本会发送给语音服务，问题和网页内容可能会发送给您设置的人工智能。请不要说出密码。"
      + (BACKGROUND ? "同时按 " + modifier + "、Shift 和空格键表示同意。" : "按回车键同意，按退出键拒绝。"),
    ja: "チョンウムが公共サービスの画面を読み上げます。音声と読み上げ文は音声サービスに、質問や画面の内容は設定したAIに送られる場合があります。パスワードは言わないでください。"
      + (BACKGROUND ? "同意するには " + modifier + "、Shift、スペースを同時に押してください。" : "同意はエンター、辞退はエスケープです。"),
  }[ui.lang];
  await speakAndWaitFrom(brief);
}

let consentSending = false;

export async function answerConsent(granted: boolean) {
  // 단축키와 카드 버튼이 함께 와도 한 번만 보낸다
  if (ui.sessionId === undefined || consentSending || (ui.consent !== "intro" && ui.consent !== "ask")) return;
  consentSending = true;
  try {
    await sendConsent(granted);
  } finally {
    consentSending = false;
  }
}

async function sendConsent(granted: boolean) {
  stopSpeaking();
  try {
    const r = await api.consent(ui.sessionId ?? "", granted);
    setConsent(granted ? "granted" : "declined");
    await applyResult(r, false);
    if (granted && ui.voiceMode.stt) {
      // 같은 키 입력 안에서 마이크를 켜야 브라우저가 허용한다.
      void startConversation();
    } else if (granted) {
      const fallback = dictationHelp(ui.lang);
      desk.message = desktopNotice(fallback);
      publishDesktop();
      announce(fallback);
      if (ui.tts) speak(fallback);
      focus("command");
    } else {
      await speakTurn(r);
      focus("command");
    }
  } catch (e) {
    setError(kindOf(e));
  }
}

/** 신청 기록 기한 알림: 웹·데스크톱 모두. 하루 한 번, 밤(22–7시)에는 지금/아침을 먼저 묻는다. '알겠어'면 그날은 다시 안 함. */
function startReminders() {
  if (ui.sessionId === undefined || reminderTimer !== undefined) return;
  const check = async () => {
    const generation = sessionGeneration;
    const { text } = await api.reminders(ui.sessionId ?? "").catch(() => ({ text: null }));
    if (text == null || text.length === 0 || generation !== sessionGeneration) return;
    const signature = `${new Date().toDateString()}|${text}`;
    if (reminderSeen === signature || ui.phase === "speaking" || ui.phase === "hearing") return;
    const hour = new Date().getHours();
    const night = hour >= 22 || hour < 7;
    if (night && !reminderNight) {
      reminderNight = true;
      const reminder = t("기한 알림이 있어요. 지금 들을까요, 아침에 들을까요?");
      desk.message = desktopNotice(reminder);
      publishDesktop();
      push({ role: "assistant", text: reminder });
      await cue("reminder");
      await speakAndWait(t("기한 알림이 있어요. 지금 들으려면 '지금', 아침에 들으려면 '아침'이라고 해 주세요."));
      return;
    }
    reminderSeen = signature;
    desk.message = desktopNotice(workspaceText("기한 알림이 있어요. 저를 눌러 확인해 주세요.", ui.lang));
    publishDesktop();
    push({ role: "assistant", text: t("알림: {message}", { message: text }) });
    await cue("reminder");
    void speakTurn({speech: "", localSpeechOnly: true});
  };
  void check();
  reminderTimer = setInterval(() => void check(), 60 * 60 * 1000);
}

// ---------------------------------------------------------------- 명령·버튼

const insideCommandArea = (el: Element | null) =>
  el !== null && (document.getElementById("command-form")?.contains(el) === true || document.getElementById("examples")?.contains(el) === true);

export async function send(text: string, options: { actionId?: string; controlLabel?: string | undefined; keyboard?: boolean } = {}) {
  const t = text.trim();
  const sid = ui.sessionId;
  if (t.length === 0 || sid === undefined || ui.recovery !== undefined) return;
  if (!await readyForInput()) return;
  const origin = document.activeElement;
  const { actionId = ui.last?.pendingConfirmation?.actionId ?? "", controlLabel } = options;
  const fromForm = options.keyboard === true && insideCommandArea(origin);
  if (reminderNight && REMINDER_NOW.test(t)) {
    const { text: due } = await api.reminders(sid).catch(() => ({ text: undefined }));
    if (due != null && due.length > 0) {
      reminderSeen = `${new Date().toDateString()}|${due}`;
      push({ role: "assistant", text: due });
      if (ui.tts) void speakTurn({speech: "", localSpeechOnly: true});
    }
    return;
  }
  if (reminderNight && REMINDER_MORNING.test(t)) return;
  const stop = stoppedGeneration;
  const input = timing?.begin("input-received");
  const releaseBusy = holdBusy({ error: undefined });
  timing?.afterPaint(input, "first-state-paint", () => stop === stoppedGeneration && ui.busy);
  const sent = timing?.measure(input, "turn-sent");
  try {
    const result = await whileBusy(api.turn(sid, t, actionId));
    if (stop === stoppedGeneration) await applyResult(result, true, true, { sent, controlLabel });
  } catch (e) {
    timing?.measure(sent, "turn-failed");
    turnFailed(e, sid, stop);
  } finally {
    releaseBusy();
    if (fromForm && stop === stoppedGeneration && ui.recovery === undefined && ui.sessionId !== undefined &&
        (document.activeElement === origin || document.activeElement === document.body)) {
      if (ui.state === "WAITING_FOR_USER_CONFIRMATION") focus("confirm-title", { scroll: "confirm-panel" });
      else if (ui.last?.authHandoff?.status === "waiting") focus("auth-done");
      else focus("command");
    }
  }
}

/** 입력란에 글을 쓰기 시작할 때 떠 있던 승인에 묶는다(쓰는 사이에 새로 뜬 승인에 답하지 않게). */
export function commandInput(value: string) {
  if (value.trim().length > 0) commandActionId ??= ui.last?.pendingConfirmation?.actionId ?? "";
  else commandActionId = undefined;
}

/** 요청 예시를 입력란에 넣는다(보내기 전에 고칠 수 있게). */
export function stageStarter() {
  commandActionId = ui.last?.pendingConfirmation?.actionId ?? "";
}

/** 입력란 보내기. 보냈으면 true(입력란을 비운다). */
export function submitCommand(value: string, keyboard = false, completed?: () => void) {
  const text = value.trim();
  if (text.length === 0 || ui.sessionId === undefined || ui.busy || ui.offline === true || ui.cancelUnconfirmed === true || ui.recovery !== undefined) return false;
  const actionId = commandActionId ?? "";
  commandActionId = undefined;
  const session = ui.sessionId, generation = stoppedGeneration;
  void send(text, { actionId, keyboard }).then(() => {
    if (ui.error === undefined && session === ui.sessionId && generation === stoppedGeneration) completed?.();
  });
  return true;
}

export function stopAll() {
  if (desk.stopping !== null) return desk.stopping;
  const operation = stopSession();
  desk.stopping = operation;
  return operation.finally(() => {
    if (desk.stopping === operation) {
      desk.stopping = null;
      if (ui.stopping === true) set({ stopping: false });
    }
  });
}

async function stopSession() {
  pendingResult = undefined;
  ui = { ...ui, stopping: true };
  microphoneTrouble = false;
  const requested = timing?.stop();
  const stop = ++stoppedGeneration;
  if (ui.listening || ui.phase !== "off" || ui.speaking) {
    timing?.afterPaint(requested, "local-stop-shown", () =>
      stop === stoppedGeneration && !ui.listening && ui.phase === "off" && !ui.speaking);
  }
  const wake = desk.wakeCount;
  const previousTurn = ui.last;
  desk.sleeping = ui.sessionId !== undefined;
  // 멈춘 뒤에는 떠 있던 카드를 누를 수 없게(멈춤 응답을 기다리는 사이에 승인이 나가지 않게)
  if (desk.card !== undefined) desk.dropped.add(desk.card.key);
  desk.card = undefined;
  desk.message = null;
  cueStopped();
  progress?.stop();
  busyRequests.clear();
  endConversation(false);
  stopSpeaking();
  recording?.cancel();
  recording = undefined;
  manualStream?.getTracks().forEach(track => track.stop());
  manualStream = undefined;
  set({ busy: false, listening: false, error: undefined });
  if (ui.sessionId === undefined) return;
  try {
    const result = await api.cancel(ui.sessionId);
    timing?.measure(requested, "cancel-acknowledged");
    if (stop !== stoppedGeneration) return;
    ui = { ...ui, stopping: false, cancelUnconfirmed: false };
    const stillSleeping = wake === desk.wakeCount;
    if (!stillSleeping && ui.last !== previousTurn) return;
    if (ui.recovery !== undefined) announce(result.speech);
    else await applyResult(result, stillSleeping, stillSleeping, { stop: requested, controlLabel: t("[멈춤 버튼]") });
  } catch {
    if (stop !== stoppedGeneration || wake !== desk.wakeCount) return;
    desk.sleeping = true;
    set({ stopping: false, cancelUnconfirmed: true, state: "STOPPED", busy: false, error: "cancelFailed", errorSeq: ui.errorSeq + 1 });
  }
}

/** 승인·거절: 화면에 보여 준 승인 번호(actionId)로만 보낸다. */
async function confirm(approve: boolean, actionId: string) {
  if (ui.sessionId === undefined || ui.recovery !== undefined || ui.offline === true || ui.cancelUnconfirmed === true) return;
  const stop = stoppedGeneration;
  const sid = ui.sessionId;
  const input = timing?.begin("input-received");
  const releaseBusy = holdBusy();
  timing?.afterPaint(input, "first-state-paint", () => stop === stoppedGeneration && ui.busy);
  const sent = timing?.measure(input, "turn-sent");
  try {
    const result = await whileBusy(api.confirm(sid, approve, actionId));
    if (stop === stoppedGeneration) await applyResult(result, true, true, { sent, controlLabel: approve ? t("[승인 버튼]") : t("[거절 버튼]") });
  } catch (e) {
    timing?.measure(sent, "turn-failed");
    turnFailed(e, sid, stop);
  } finally {
    releaseBusy();
  }
}

/** 서버가 제안한 선택지(인증 마침·인증 취소·본문 읽기): 그 응답(turnId)과 인계 번호에 묶어 보낸다. */
async function chooseOffer(card: Extract<Decision, { kind: "offer" }>, key: string) {
  if (ui.sessionId === undefined || ui.recovery !== undefined || ui.offline === true || ui.cancelUnconfirmed === true) return;
  const stop = stoppedGeneration;
  const sid = ui.sessionId;
  const generation = sessionGeneration;
  const releaseBusy = holdBusy({ error: undefined });
  try {
    const handoffId = card.ref.handoffId;
    const body = { turnId: card.ref.turnId, key, ...(handoffId !== undefined && handoffId.length > 0 ? { handoffId } : {}) };
    const result = await whileBusy(api.choice(ui.sessionId, body));
    if (stop === stoppedGeneration && generation === sessionGeneration) {
      const label = key === "auth-cancel" ? t("인증 취소") : card.choices.find(choice => choice.key === key)?.label;
      await applyResult(result, true, true, { controlLabel: ui.lang === "ko" ? undefined : label });
    }
  } catch (e) {
    if (errorCode(e) !== "CHOICE_EXPIRED") turnFailed(e, sid, stop);
    else {
      desk.dropped.add(card.key);
      setError("expired");
    }
  } finally {
    releaseBusy();
  }
}

/** 카드 종류 → 선택지 → 실행. 서버 제안(offer)은 선택지 이름을 그대로 서버로 보낸다. */
function cardAction(card: CardView, key: string): (() => Promise<void>) | undefined {
  if (card.kind === "offer") return () => chooseOffer(card, key);
  if (card.kind === "consent") {
    if (key === "consent-yes") return () => answerConsent(true);
    if (key === "consent-no") return () => answerConsent(false);
    return undefined;
  }
  if (key === "approve") return () => confirm(true, card.ref.actionId);
  if (key === "reject") return () => confirm(false, card.ref.actionId);
  return undefined;
}

const insideDecision = (el: Element | null) =>
  el !== null && (document.getElementById("confirm-panel")?.contains(el) === true || document.getElementById("auth-panel")?.contains(el) === true);

/**
 * 카드의 선택지 하나를 실행한다(대화 창 버튼·아바타 버튼 공용). 보여 준 카드 번호가 지금 카드가 아니면 실행하지 않는다.
 * 같은 카드는 한 번만: 기다리기 전에 표시해 두므로 두 번 누르기와 동시에 온 다른 화면의 선택이 둘 다 나가지 않는다.
 */
export async function choose(choiceSetId: string, key: string, keyboard = false) {
  const card = desk.card;
  if (card === undefined || card.id !== choiceSetId) {
    notice(t("선택지가 바뀌었어요. 지금 안내를 다시 확인해 주세요."));
    return;
  }
  const offered = card.choices.some((c) => c.key === key && c.open === undefined);
  const run = offered ? cardAction(card, key) : undefined;
  if (run === undefined) return;
  if (ui.busy) {
    notice(t("지금 다른 요청을 처리하고 있어요. 잠시 후 다시 선택해 주세요."));
    return;
  }
  const origin = document.activeElement;
  const fromDecision = insideDecision(origin) && (card.kind !== "approval" || keyboard);
  const held = holdCard();
  if (held === undefined) return;
  try {
    await run();
  } finally {
    releaseCard(held);
    if (fromDecision && document.activeElement === document.body) reveal();
  }
}

/** 인증 카드의 단추: 서버가 제안한 선택지가 있으면 그것을, 없으면(이전 작업을 다시 연결한 뒤) 같은 뜻의 말을 보낸다. */
export function authChoice(cardId: string, key: "auth-done" | "auth-cancel", viaCard: boolean) {
  if (viaCard) return choose(cardId, key);
  const done = key === "auth-done";
  const label = done ? t("직접 확인을 마쳤어요") : t("인증 취소");
  return send(done ? "다 했어" : "인증 취소", { controlLabel: ui.lang === "ko" ? undefined : label });
}

/** 지금 카드를 '보내는 중'으로 잡는다(이미 잡혀 있으면 undefined). 음성 한 턴도 카드를 잡아 버튼과 함께 나가지 않게 한다. */
function holdCard() {
  const id = desk.card?.id;
  if (id === undefined || desk.consumed.has(id)) return undefined;
  desk.consumed.add(id);
  render();
  return id;
}

/** 응답이 오지 않아(오류) 같은 카드가 남아 있으면 다시 고를 수 있게 놓는다. 새 응답이 왔으면 이미 새 카드다. */
function releaseCard(id: string | undefined) {
  if (id !== undefined && desk.card?.id === id) {
    desk.consumed.delete(id);
    render();
  }
}

/** 짧은 알림: 기록에 남기고 소리로도 알린다. */
function notice(text: string) {
  announce(text, "transcript");
  if (ui.tts) speak(text);
}

/** 대화 창을 연 뒤 지금 결정할 자리로 초점을 옮긴다(아바타·트레이에서 연 경우). */
function reveal(where?: string) {
  const place = where ?? (ui.sessionId === undefined ? "ended" : desk.card?.kind === "approval" ? "confirm" : desk.card?.kind === "consent" ? "consent"
    : ui.last?.authHandoff?.status === "waiting" ? "auth" : "command");
  const targets = new Map([
    ["confirm", "confirm-title"],
    ["consent", ui.consent === "ask" ? "consent-yes" : "consent-hear"],
    ["auth", "auth-done"],
    ["command", "command"],
    ["ended", "session-new"],
  ]);
  const target = targets.get(place);
  focus(target ?? "log", { fallback: "log" });
}

/** 한 번 누르면 녹음하고 다시 누르면 음성 API에 보낸다. */
export async function toggleMic() {
  if (openingMic || ui.sessionId === undefined || !ui.voiceMode.stt || ui.consent !== "granted") return;
  if (recording !== undefined) {
    const rec = recording;
    const generation = stoppedGeneration;
    const sessionId = ui.sessionId;
    recording = undefined;
    const releaseBusy = holdBusy({ listening: false });
    const capture = timing?.begin("capture-end");
    let sent: TimingPoint | undefined;
    try {
      const audio = await rec.stop();
      if (generation !== stoppedGeneration || manualRequestGeneration !== generation || sessionId !== ui.sessionId || ui.offline === true) {
        audio.cancel();
        return;
      }
      void cue("done");
      sent = timing?.measure(capture, "turn-sent");
      const result = await whileBusy(api.audioTurn(sessionId, audio, rec.asked));
      if (generation === stoppedGeneration) await applyResult(result, true, true, { sent, capture });
    } catch (e) {
      timing?.measure(sent, "turn-failed");
      turnFailed(e, sessionId, generation);
    } finally {
      releaseBusy();
    }
    return;
  }
  if (!await readyForInput() || openingMic || ui.last?.authHandoff?.status === "waiting") return;
  stopSpeaking();
  set({ error: undefined });
  openingMic = true;
  manualRequestGeneration = stoppedGeneration;
  microphoneTrouble = false;
  captureChanged();
  const sessionId = ui.sessionId, generation = stoppedGeneration;
  const current = () => sessionId === ui.sessionId && generation === stoppedGeneration && manualRequestGeneration === generation && ui.offline !== true;
  let cancelled = false;
  try {
    await cue("listen");
    const asked = ui.last?.pendingConfirmation?.actionId ?? "";
    const rec = await startRecording(() => api.liveAudio(sessionId), ui.micId, () => void toggleMic(), stream => {
      if (!current() || authWaiting() ||
          ui.consent !== "granted" || dialogNow() !== undefined) {
        cancelled = true;
        return false;
      }
      manualStream = stream;
      captureChanged();
      return true;
    }, captureChanged);
    if (!current() || ui.consent !== "granted"
        || dialogNow() !== undefined || authWaiting()) {
      rec.cancel();
      return;
    }
    recording = Object.assign(rec, { asked });
    set({ listening: true });
    announce(t("듣는 중입니다. 말씀을 마치면 버튼을 다시 누르세요."));
  } catch (error) {
    if (cancelled || !current() || authWaiting() || ui.consent !== "granted" || dialogNow() !== undefined) return;
    microphoneTrouble = true;
    const fault = voiceFault(error);
    console.warn("[voice]", { operation: "microphone", code: fault.code });
    setError(voiceIssue(fault));
  } finally {
    openingMic = false;
    if (recording === undefined) manualStream = undefined;
    captureChanged();
  }
}

export function toggleTts() {
  narrationMuted = ui.tts;
  try {
    if (narrationMuted) localStorage.setItem("cheongeum.narrationMuted", "1");
    else localStorage.removeItem("cheongeum.narrationMuted");
  } catch { /* 임시 세션 */ }
  if (ui.tts) {
    stopSpeaking();
    set({ tts: false });
  } else set({ tts: true });
  if (edge !== undefined) {
    edge.enabled = ui.tts;
    edge.updateAudio();
  }
}

export async function checkMic() {
  if (ui.checkingMic || ui.sessionId === undefined) return;
  set({ checkingMic: true, micCheckResult: workspaceText("마이크를 확인하고 있어요.", ui.lang) });
  let probe: MediaStream | undefined;
  try {
    let track = (edge?.stream ?? loop?.stream ?? manualStream)?.getAudioTracks().find((t) => t.readyState === "live");
    if (track === undefined) {
      probe = await navigator.mediaDevices.getUserMedia({ audio: ui.micId !== undefined && ui.micId.length > 0 ? { deviceId: { exact: ui.micId } } : true });
      probeStream = probe;
      track = probe.getAudioTracks()[0];
      captureChanged();
    }
    set({ micCheckResult: workspaceText(track?.readyState === "live" ? "마이크를 사용할 수 있어요." : "연결된 마이크를 확인해 주세요.", ui.lang) });
  } catch (error) {
    set({ micCheckResult: workspaceText(error instanceof Error && error.name === "NotAllowedError"
      ? "마이크 권한이 꺼져 있어요. 기기의 마이크 권한 설정을 확인해 주세요."
      : "마이크를 열 수 없어요. 연결과 입력 장치 선택을 확인해 주세요.", ui.lang) });
  } finally {
    probe?.getTracks().forEach((track) => track.stop());
    probeStream = undefined;
    set({ checkingMic: false });
  }
}

export function soundCheck() {
  unlockAudio();
  set({ error: undefined });
  speak(workspaceText("소리 확인입니다. 이 목소리가 들리면 음성 안내가 정상입니다.", ui.lang));
}

export function toggleContrast() { set({ contrast: !ui.contrast }); }
export function speakConsent() { speak(consentText()); }

export function setConversationMode(mode: "native" | "dictate") {
  try { localStorage.setItem("cheongeum.voiceMode", mode); } catch { /* 이번만 */ }
  set({ conversationMode: mode });
  if (conversationOn || startingLoop !== undefined) endConversation();
}

export function selectMic(id: string) {
  set({ micId: id });
  try {
    localStorage.setItem("cheongeum.micId", id);
  } catch {
    /* 저장소를 못 쓰면 이번만 */
  }
  if (conversationOn) endConversation();
}

let languageRequest = 0;
export async function selectLanguage(lang: Lang) {
  const sid = ui.sessionId;
  if (sid === undefined) return;
  const request = ++languageRequest;
  const current = () => request === languageRequest && sid === ui.sessionId;
  set({ requestedLanguage: lang });
  try {
    const [r] = await Promise.all([api.language(sid, lang), loadWorkspaceLanguage(lang)]);
    if (!current()) return;
    await applyResult(r, !conversationOn, true, { controlLabel: workspaceText("[언어 선택]", lang) });
    if (conversationOn && current()) await speakTurn(r);
  } catch (err) {
    if (current()) setError(kindOf(err, "languageFailed"));
  } finally {
    if (current()) set({ requestedLanguage: undefined });
  }
}

export function focusCommand() { focus("command"); }

// ---------------------------------------------------------------- 이벤트 연결

function bind() {
  void desktop?.avatarVisible?.().then(value => { if (typeof value === "boolean") set({ avatarVisible: value }); });
  api.onConnection(connectionChanged);
  api.onVoiceRestored(noteVoiceInterruption);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && skipIntro()) e.preventDefault();
  });
  // 데스크톱 앱: 전역 단축키(Cmd/Ctrl+Shift+Space)로 '지금 말하기'
  desktop?.onTalk(() => talkNow());
  // 아바타·트레이에서 온 동작(메인 프로세스가 모양을 확인해 넘긴다)
  desktop?.onAction?.((action) => {
    if (typeof action !== "object" || action === null || !("type" in action)) return;
    if (action.type === "settings") void openSettings();
    else if (action.type === "avatar-visibility" && "visible" in action && typeof action.visible === "boolean") set({ avatarVisible: action.visible });
    else if (action.type === "stop") void stopAll();
    else if (action.type === "reveal") {
      wakeAvatar();
      reveal("focus" in action && typeof action.focus === "string" ? action.focus : undefined);
    }
    else if (action.type === "choose" && "choiceSetId" in action && "key" in action && typeof action.choiceSetId === "string" && typeof action.key === "string") {
      void choose(action.choiceSetId, action.key);
    }
  });
  onSpeaking((speaking) => {
    desk.speaking = speaking;
    if (edge !== undefined) {
      edge.localSpeech = speaking;
      edge.updateAudio();
    }
    render();
  });

  // 스페이스: 캡처 단계에서 가로채 포커스된 버튼(예: 대화 끝내기)이 눌리지 않게 한다. 글 입력 중에는 제외.
  window.addEventListener(
    "keydown",
    (e) => {
      const t = e.target;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
      if (e.code !== "Space" || typing || !conversationOn) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) talkNow();
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (e) => {
      if (e.code === "Space" && conversationOn && !(e.target instanceof HTMLInputElement)) e.preventDefault();
    },
    true,
  );
  // 동의 안내 중 Esc = 동의하지 않음
  window.addEventListener("keydown", (e) => {
    if (ui.settings === undefined && ui.consent === "ask" && e.key === "Escape") {
      e.preventDefault();
      void answerConsent(false);
    }
  });
  // 첫 클릭·키 입력 때 소리 채널을 잠금 해제(자동재생 정책).
  window.addEventListener("pointerdown", unlockAudio, true);
  window.addEventListener("keydown", unlockAudio, true);
  // 새로고침·탭 닫기 때 이 세션의 브라우저 창을 닫는다.
  window.addEventListener("pagehide", () => {
    progress?.stop();
    if (ui.sessionId === undefined) return;
    if (recoverable) api.detach(ui.sessionId);
    else api.close(ui.sessionId);
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
}

function showRecovery(choice: Recovery["choice"], title: string, message: string, yes: string, no: string) {
  set({ recovery: { choice, title, message, yes, no, busy: false }, sessionNew: false });
  focus("recovery-title");
}

function closeRecovery() {
  set({ recovery: undefined });
}

function connect(s: { sessionId: string; state?: Session["state"] | undefined; stopGeneration?: number | undefined; token?: string | undefined; writer?: string | undefined }) {
  progress?.stop();
  progress = new BackendStatus(s.sessionId, (status, seq) => {
    if (s.sessionId !== ui.sessionId) return;
    if (recoverable && seq !== undefined) tabStore(PROGRESS_KEY, String(seq));
    if (ui.backendStatus !== status) set({ backendStatus: status });
  });
  desk.message = null;
  desk.sleeping = s.state === "STOPPED";
  desk.stopGeneration = s.stopGeneration ?? null;
  recoverable = s.token !== undefined && s.token.length > 0;
  api.writer(s.writer);
  if (recoverable && s.token !== undefined) {
    tabStore(RECOVERY_KEY, s.token);
  }
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => void api.heartbeat(s.sessionId).catch(() => undefined), 15000);
  missedHeartbeats = 0;
  set({ sessionId: s.sessionId, state: s.state ?? "IDLE", offline: false, cancelUnconfirmed: false });
}

export async function endSession() {
  clearTimeout(researchRecoveryTimer);
  presentedResearch.clear();
  claimedReading = undefined;
  heardReadings.clear();
  researchChunks.clear();
  heardOutcomes.clear();
  timing?.cancelPending();
  const sid = ui.sessionId;
  progress?.stop();
  progress = undefined;
  busyRequests.clear();
  pendingResult = undefined;
  missedHeartbeats = 0;
  desk.message = null;
  desk.sleeping = false;
  desk.stopGeneration = null;
  sessionGeneration += 1;
  stoppedGeneration += 1;
  endConversation(false);
  stopSpeaking();
  recording?.cancel();
  recording = undefined;
  clearInterval(heartbeatTimer);
  clearInterval(reminderTimer);
  reminderTimer = undefined;
  reminderSeen = undefined;
  reminderNight = false;
  tabStore(RECOVERY_KEY, null);
  tabStore(PROGRESS_KEY, null);
  closeRecovery();
  if (desktop !== undefined) desktopLanguage = ui.lang;
  setSpeechLang(desktopLanguage ?? "ko");
  commandActionId = undefined;
  set({
    sessionId: undefined, state: "IDLE", offline: false, cancelUnconfirmed: false, error: undefined, last: undefined, hasTurn: false, busy: false, listening: false, consent: undefined, lang: desktopLanguage ?? "ko", requestedLanguage: undefined,
    messages: [], backendStatus: "", commandReset: ui.commandReset + 1, sessionNew: true,
  });
  focus("session-new");
  try {
    if (sid !== undefined) await api.end(sid);
  } catch (error) {
    if (errorStatus(error) !== 404) setError(kindOf(error));
  } finally {
    if (ui.sessionId === undefined) api.writer(undefined);
  }
}

export async function answerRecovery(yes: boolean) {
  const choice = ui.recovery?.choice;
  if (choice === "new") {
    tabStore(RECOVERY_DECLINED, yes ? null : "1");
    closeRecovery();
    return openSession(yes);
  }
  if (choice === "retry") {
    closeRecovery();
    if (yes) return chooseSession();
    tabStore(RECOVERY_KEY, null);
    tabStore(PROGRESS_KEY, null);
    return chooseSession();
  }
  if (choice !== "resume") return;
  if (!yes) return endSession();
  const recovery = ui.recovery;
  if (recovery !== undefined) set({ recovery: { ...recovery, busy: true } });
  try {
    const checkpoint = await api.resume(ui.sessionId ?? "");
    desk.sleeping = checkpoint.state === "STOPPED";
    desk.stopGeneration = checkpoint.stopGeneration ?? null;
    closeRecovery();
    await loadWorkspaceLanguage(checkpoint.lang ?? "ko");
    setSpeechLang(checkpoint.lang ?? "ko");
    syncDesktopLanguage(checkpoint.lang ?? "ko");
    set({ state: checkpoint.state, lang: checkpoint.lang ?? "ko",
      last: { authHandoff: checkpoint.authHandoff, turnId: checkpoint.turnId, offeredChoices: checkpoint.offeredChoices }, hasTurn: true });
    tabStore(PROGRESS_KEY, String(checkpoint.progressSeq ?? 0));
    const consent = checkpoint.consent === "pending" ? "ask" : checkpoint.consent;
    setConsent(consent);
    const step = checkpoint.step !== undefined && checkpoint.step !== 0 ? t("연습 신청서 {step}단계예요.", { step: checkpoint.step }) : "";
    const approval = checkpoint.approvalKind !== undefined && checkpoint.approvalKind.length > 0 ? t("실행할 동작을 다시 요청하고 새로 확인해 주세요.") : "";
    const message = [step.length > 0 ? step : t("이전 작업에 연결했어요."), approval, t("음성 입력을 쓰려면 마이크를 다시 켜 주세요.")].filter(Boolean).join(" ");
    push({ role: "assistant", text: message });
    if (ui.tts) speak(message);
    focus("command");
    if (ui.sessionId !== undefined) checkResearchAfterLoss(ui.sessionId);
  } catch (error) {
    const status = errorStatus(error);
    if (status === 410 || status === 404) await endSession();
    setError(kindOf(error));
  } finally {
    if (ui.recovery !== undefined) set({ recovery: { ...ui.recovery, busy: false } });
  }
}

export async function chooseSession() {
  set({ sessionNew: false });
  const health = await healthReady;
  const token = tabStore(RECOVERY_KEY);
  if (token !== null && token.length > 0 && health?.recoveryAvailable !== false) {
    try {
      let restored;
      for (let retry = 0; retry < 4; retry += 1) {
        try {
          restored = await api.recover(token);
          break;
        } catch (error) {
          if (errorCode(error) !== "SESSION_WRITER_ACTIVE" || retry === 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      if (restored === undefined) throw new Error(t("복구하지 못했어요."));
      desktopLanguage = undefined;
      connect(restored);
      showRecovery("resume", t("이전 작업을 이어 할까요?"), t("이 탭에서 작업을 이어 할 수 있어요. 마이크는 꺼져 있습니다."), t("이전 작업 이어하기"), t("이용 종료"));
      return;
    } catch (error) {
      const status = errorStatus(error);
      if (status !== 404 && status !== 400) {
        showRecovery("retry", t("이전 작업에 연결하지 못했어요"), errorMessage(error), t("이전 작업 다시 연결"), t("새 작업 시작"));
        return;
      }
    }
  }
  tabStore(RECOVERY_KEY, null);
  tabStore(PROGRESS_KEY, null);
  if (health?.recoveryAvailable === true && tabStore(RECOVERY_DECLINED) !== "1") {
    showRecovery("new", t("같은 탭 작업 복구"), t("개인 컴퓨터에서 작업을 이어갈 수 있게 할까요? 브라우저가 열려 있으면 연결이 끊긴 뒤 5분 동안 돌아올 수 있어요."), t("복구 켜고 시작"), t("복구 없이 시작"));
  } else {
    await openSession(false);
  }
}

let starting: Promise<void> | undefined;
export function start() { return starting ??= initialize(); }

async function initialize() {
  bind();
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("cheongeum.reminded.") || key.startsWith("cheongeum.remindAck.")) localStorage.removeItem(key);
    }
  } catch { /* 저장소 비활성 */ }
  render();
  if (desktopLanguage !== undefined) {
    await loadWorkspaceLanguage(desktopLanguage);
    setSpeechLang(desktopLanguage);
  }
  announce(t("청음을 준비하고 있어요."));
  const health = await refreshHealth();
  if (health?.setupRequired === true) return firstRun.start(1);
  // 1단계를 저장한 뒤 앱을 닫았으면 소리 확인부터 한 번 이어 간다
  if (health?.firstRun === "stage2") return firstRun.start(2);
  if (health !== undefined && !health.stt.supported) desktop?.showSetup?.();
  await chooseSession();
}

function refreshHealth() {
  healthReady = api.health().then(h => {
    set({
      practiceMode: h.practiceMode === true,
      workspaceAvailable: h.workspaceAvailable === true,
      directActions: h.directActions === true,
      settingsAvailable: h.settingsAvailable === true,
      baseSpeed: h.voiceSpeed ?? VOICE_PROFILE.speed,
      voiceMode: {
        known: true, stt: h.stt.supported, tts: h.tts.supported, edge: h.voiceEdge, llmRoles: h.llmRoles ?? {},
        label: "",
        sttProvider: h.stt.supported ? h.stt.liveModel ?? h.stt.provider : undefined,
        ttsProvider: h.tts.supported ? h.tts.provider : undefined,
      },
      tts: h.tts.supported && !narrationMuted,
    });
    return h;
  }).catch((error: unknown) => {
    setError(kindOf(error));
    return undefined;
  });
  return healthReady;
}

export async function openSettings() {
  if (ui.settings !== undefined) return;
  endConversation(false);
  recording?.cancel();
  recording = undefined;
  set({ listening: false });
  stopSpeaking();
  const seq = ui.settingsSeq + 1;
  set({ settings: { seq, loading: true, saving: false }, settingsSeq: seq });
  try {
    const prefs = await api.settings();
    const autostart = desktop?.getAutoStart !== undefined ? await desktop.getAutoStart() : undefined;
    patchDialog(seq, { prefs, keyState: prefs.loadError ? "error" : prefs.hasKey ? "saved" : "empty", ...(autostart !== undefined ? { autostart } : {}) });
  } catch (error) {
    patchDialog(seq, { error: errorMessage(error) });
  } finally {
    patchDialog(seq, { loading: false });
  }
}

/** 열려 있는 그 설정 창(seq)일 때만 고친다(닫았다 다시 연 창에 늦은 응답이 섞이지 않게). */
function patchDialog(seq: number, patch: Partial<SettingsDialog>) {
  const dialog = dialogNow();
  if (dialog?.seq === seq) set({ settings: { ...dialog, ...patch } });
}

export function closeSettings() {
  if (ui.settings === undefined) return;
  set({ settings: undefined });
}

export async function saveSettings(values: SettingsInput, autostart: boolean | undefined) {
  const dialog = ui.settings;
  if (dialog === undefined || dialog.loading || dialog.saving) return;
  set({ settings: { ...dialog, saving: true } });
  try {
    await api.saveSettings(values);
    desktopLanguage = undefined;
    if (desktop?.setAutoStart !== undefined && autostart !== undefined) desktop.setAutoStart(autostart);
    set({ settings: undefined });
    await refreshHealth();
    if (ui.sessionId !== undefined) {
      if (values.language !== dialog.prefs?.language) {
        await loadWorkspaceLanguage(values.language);
        setSpeechLang(values.language);
        syncDesktopLanguage(values.language);
        set({ lang: values.language });
      }
      announce(t("이용 설정을 저장했어요."));
    } else {
      await chooseSession();
    }
  } catch (error) {
    patchDialog(dialog.seq, { error: errorMessage(error) });
  } finally {
    patchDialog(dialog.seq, { saving: false });
  }
}

async function openSession(recovery: boolean) {
  set({ error: undefined });
  try {
    const s = await api.createSession(recovery);
    connect(s);
    let language = s.lang ?? "ko";
    if (desktopLanguage !== undefined && desktopLanguage !== language) {
      const preferred = desktopLanguage;
      await api.language(s.sessionId, preferred);
      if (ui.sessionId !== s.sessionId) return;
      language = preferred;
    }
    desktopLanguage = undefined;
    await loadWorkspaceLanguage(language);
    if (s.sessionId !== ui.sessionId) return;
    setSpeechLang(language);
    syncDesktopLanguage(language);
    set({ lang: language, announcement: { text: workspaceText("청음을 준비하고 있어요.", language), seq: ui.announcement.seq } });
    if (s.speechPrefs !== undefined) applySpeechPrefs(s.speechPrefs);
    if (!s.consentRequired) {
      setConsent("granted");
      announce(t("청음이 준비됐어요."));
      const prompt = s.firstRunPrompt?.[language];
      if (prompt !== undefined) {
        desk.message = desktopNotice(prompt);
        notice(prompt);
      }
      return;
    }
    let first = s.firstStartupGuide;
    try {
      first ??= localStorage.getItem("cheongeum.startupGuideSeen") === null;
      localStorage.setItem("cheongeum.startupGuideSeen", "1");
    } catch { /* 설치본은 서버 설정 폴더의 기록을 사용한다. */ }
    if (first === false) {
      setConsent("ask");
      recordConsent();
    } else {
      setConsent("intro");
      if (desktop !== undefined) void hearConsent();
    }
  } catch (e) {
    setError(kindOf(e));
    set({ sessionNew: true });
    focus("session-new");
  }
}
