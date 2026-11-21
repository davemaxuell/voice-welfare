import { timing, type TimingPoint } from "./perf.ts";
// 청음 대화 창의 상태와 동작(Python app.js). 화면은 App.tsx가 이 상태(snapshot)를 그린다.
// 입력란·버튼은 다시 만들지 않으므로 포커스가 유지된다(화면낭독기 사용자를 위해).
import { LangSchema, STATE_LABELS_KO, type Lang } from "../../src/core/turn.ts";
import {
  api, errorCode, errorMessage, errorStatus, type Health, type Session, type Settings, type SettingsInput, type Turn,
} from "./api.ts";
import { getSpeechLang, setSpeechLang, unlockAudio } from "./audio.ts";
import { currentDecision, desktopView, turnNotice, type Consent, type Decision } from "./companion.ts";
import { createFirstRun } from "./first-run.ts";
import { listMicrophones, preferredMicrophone, startRecording, VoiceLoop, type LiveAudio, type Recording } from "./mic.ts";
import { watchProgress } from "./progress-watch.ts";
import {
  applySpeechPrefs, earcon, onSpeaking, preloadCues, serverTts, speakOnDevice, speechPrefs,
  takeInterruptedSpeech, transitionCue, type CueKind,
} from "./speaker.ts";
import { LiveConversation } from "./voice-edge.ts";
import {
  consentText as consentTextFor, dictationHelp, GREETINGS, progressUpdate, type CardView, type Env, type LogEntry, type Phase, type Recovery, type UiState,
} from "./view.ts";
import { loadWorkspaceLanguage, workspaceText } from "./workspace-language.ts";

const BACKGROUND = new URLSearchParams(location.search).get("background") === "1";
const env: Env = { background: BACKGROUND, mac: /Mac/.test(navigator.platform) };

/** 데스크톱 앱(Electron)에서 실행 중이면 preload가 넣어 준다. 소리 자동재생이 허용되어 있다. */
const desktop = window.cheongeumDesktop;
let desktopLanguage = desktop === undefined ? undefined : LangSchema.safeParse(new URLSearchParams(location.search).get("desktopLang")).data;

const t = (text: string, values?: Readonly<Record<string, string | number>>) => workspaceText(text, ui.lang, values);
const consentText = (lang: string = ui.lang) => consentTextFor(ui, env, lang);

// 서버 음성 설정을 받아 오기 전에는 동의 안내를 읽지 않는다(어디로 전송되는지가 바뀌므로)
let healthReady: Promise<Health | undefined> = Promise.resolve(undefined);

let clip: HTMLAudioElement | null = null;
// 첫 실행 설정(키·이 PC·소리 확인·빠르기). 끝나면 동의 화면으로 넘어간다.
export const firstRun = createFirstRun({
  desktop,
  speak: (text, lang, rate) => {
    unlockAudio();
    return serverTts.speak(text, (chunk, speed) => api.speak(chunk, langOf(lang), speed), 0, rate);
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
  playClip: (src) => new Promise<void>((resolve) => {
    const a = new Audio(src);
    clip = a;
    a.onended = a.onerror = a.onpause = () => resolve();
    a.play().catch(() => resolve());
  }),
  pauseClip: () => {
    clip?.pause();
    clip = null;
  },
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
let ui: UiState & { settings?: SettingsDialog | undefined; requestedLanguage?: Lang | undefined; settingsSeq: number; commandReset: number; consentDetailsOpen: number; errorSeq: number } = {
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
  baseSpeed: 1.35,
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
let reminderTimer: ReturnType<typeof setInterval> | undefined;
let reminderSeen: string | undefined;
let reminderNight = false;
let recoverable = false;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let sessionGeneration = 0;
let stoppedGeneration = 0;
let progressSession: ReturnType<typeof sessionProgress> | undefined;
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
// 일하는 동안: 사용자가 말하는 중 / 청음이 짧은 안내(진행 상황)를 말하는 중
let userTalking = false;
let busyTalking = false;
/** 마이크 경로 신호음은 음성 안내 꺼짐과 관계없이 낸다. 결과·알림 신호음은 ui.tts를 따른다. */
const MIC_CUES = new Set<CueKind>(["start", "listen", "done", "thinking", "working", "stopped", "end"]);
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
  ui = { ...ui, card, cardTaken: card !== undefined && desk.consumed.has(card.id), speaking: desk.speaking, edge: edge !== undefined };
  for (const listener of listeners) listener();
  publishDesktop();
}

function set(patch: Partial<typeof ui>) {
  if (patch.busy === true || patch.phase === "hearing" || patch.phase === "thinking") desk.message = null;
  ui = { ...ui, ...patch };
  render();
}

function announce(text: string) {
  set({ announcement: { text, seq: ui.announcement.seq + 1 } });
}

function setError(message: string) {
  set({ error: message, errorSeq: ui.errorSeq + 1 });
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
    capture: conversationOn || recording !== undefined || ui.listening || ui.phase === "starting" ? "on" : "off",
    speaking: desk.speaking,
    recording: recording !== undefined,
    message: desk.message,
    sleeping: desk.sleeping,
    introPose: desk.introPose,
    card: desk.card,
    pending: desk.card !== undefined && desk.consumed.has(desk.card.id),
  });
  const text = JSON.stringify(view);
  if (text === desk.sent) return;
  desk.sent = text;
  desktop.publish({ instance: desk.instance, revision: ++desk.revision, ...view });
}

function setPhase(p: Phase) {
  if (ui.phase !== p) set({ phase: p });
}

function desktopNotice(text: string | null) {
  return text !== null && text.length > 0 ? { id: `m-${++desk.seq}`, text } : null;
}

function wakeAvatar() {
  if (!desk.sleeping) return;
  desk.sleeping = false;
  desk.wakeCount += 1;
  stopSpeaking();
  publishDesktop();
}

// The first deliberate request after Stop waits for that specific cancellation.
// Opening chat wakes the figure alone. Recording and commands also wake the session.
async function readyForInput() {
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
      setError(errorMessage(error));
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

type TurnTiming = { sent?: TimingPoint; capture?: TimingPoint; stop?: TimingPoint };
async function applyResult(result: Turn, speakIt = true, sleepOnStop = true, trace?: TurnTiming) {
  let r = result;
  const prevTurn = ui.last?.turnId;
  if (ui.sessionId === undefined || r.sessionId !== ui.sessionId || prevTurn === r.turnId) return;
  const language = r.semanticAction === "set-language" ? r.lang : ui.requestedLanguage ?? ui.lang;
  if (language !== ui.lang) {
    const generation = stoppedGeneration;
    await loadWorkspaceLanguage(language);
    if (generation !== stoppedGeneration || r.sessionId !== ui.sessionId || ui.last?.turnId !== prevTurn) return;
  }
  if (r.intentType === "READ_START_GUIDE") r = { ...r, speech: consentText(r.lang) };
  if (r.intentType === "SETUP_RESTART") {
    // 처음 설정 화면이 녹음한 문장을 틀므로 응답은 말하지 않는다
    speakIt = false;
    endConversation(false);
    void firstRun.start(1);
  }
  const prevState = ui.state;
  const stopped = r.intentType === "STOP" || r.semanticAction === "stop";
  if (stopped && desk.stopping === null) stoppedGeneration++;
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
    endConversation(false);
    recording?.cancel();
    recording = undefined;
    set({ listening: false });
  }
  setSpeechLang(language);
  edge?.setLanguage(language);
  if (r.speechPrefs !== undefined) applySpeechPrefs(r.speechPrefs);
  // 새 응답: 남아 있는 결정이어도 새 카드 번호로(이전 화면에서 누른 버튼은 무효)
  desk.card = undefined;
  desk.dropped.clear();
  desk.message = desktopNotice(turnNotice(r));
  const isConsent = r.intentType === "CONSENT" || r.semanticAction === "consent";
  const hasTurn = ui.hasTurn || (!isConsent && r.semanticAction !== "set-language");
  set({ last: r, state: r.state, lang: language, hasTurn, activity: r.intentType === "PROGRESS" ? ui.activity : null });
  if (isConsent) {
    recordConsent(ui.consent === "granted" ? r.speech : undefined, r.lang);
    if (ui.consent !== "granted") push({ role: "assistant", text: r.speech, lang: r.lang });
  } else {
    push({ role: "user", text: r.userUtterance === "[언어 선택]" ? t("[언어 선택]") : r.userUtterance });
    push({ role: "assistant", text: r.speech, lang: r.lang });
  }
  timing?.measure(trace?.sent, "result-applied");
  timing?.afterPaint(trace?.capture, "transcript-shown");
  timing?.afterPaint(stop, "stopped-state-paint", () =>
    r.turnId === ui.last?.turnId && document.getElementById("st-state")?.dataset.state === "STOPPED");
  announce(workspaceText("상태", ui.lang) + ": " + workspaceText(STATE_LABELS_KO[r.state], ui.lang));
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
  }
  if (r.state === "WAITING_FOR_USER_CONFIRMATION" && r.turnId === ui.last?.turnId) {
    // 제목만 보이는 자리에 멈추지 않게 카드 끝(승인 버튼)까지 보인다
    focus("confirm-title", { scroll: "confirm-panel" });
  }
}

function speak(text: string) {
  void speakAndWaitFrom(text);
}

export function speakResearch(text: string) {
  if (ui.workspaceAvailable && ui.consent === "granted") speak(text);
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
  if (edge !== undefined && ui.phase === "speaking") edge.interrupt();
}

async function speakAndWaitFrom(text: string, fromChunk = 0, rate = speechPrefs.rate, lang = getSpeechLang()) {
  if (!ui.tts || !ui.voiceMode.tts) return;
  try {
    const result = await serverTts.speak(text, (chunk, speed) => api.speak(chunk, lang, speed), fromChunk, rate);
    if (result === "blocked") setError(t("소리를 재생하려면 화면을 한 번 누른 뒤 소리 확인을 선택해 주세요."));
  } catch (error) {
    const code = errorCode(error);
    if (code === "VOICE_KEY" || code === "VOICE_LIMIT") desktop?.showSetup?.();
    setError(code !== undefined && code.length > 0 ? errorMessage(error) : t("음성 API 안내를 재생하지 못했어요. 연결을 확인해 주세요. 안내는 화면에서도 읽을 수 있어요."));
  }
}

const speakAndWait = (text: string) => speakAndWaitFrom(text);

type Spoken = Pick<Turn, "speech"> & Partial<Pick<Turn, "localSpeechOnly" | "lang">>;
async function speakTurn(result: Spoken, text = result.speech) {
  if (result.localSpeechOnly !== true) return speakAndWaitFrom(text, 0, speechPrefs.rate, result.lang ?? getSpeechLang());
  if (!ui.tts) return;
  const status = await speakOnDevice(text, result.lang ?? "ko");
  if (status === "unavailable") {
    setError(workspaceText("이 기기에서 사용할 수 있는 음성이 없어 개인 안내를 화면에 표시했어요.", ui.lang));
  }
}

const THINKING_DELAY_MS = 1000;
const WORKING_START_MS = 3000;
const WORKING_EVERY_MS = 2500;

/** work가 끝날 때까지만 생각중·일하는중 신호음을 낸다. 답을 말하기 전에 그치고, 일하는 중에 안내를 말하는 동안은 건너뛴다. */
async function withProgressCues<T>(work: Promise<T>) {
  const tick = (kind: CueKind) => {
    if (!busyTalking) void cue(kind);
  };
  let intervalId: ReturnType<typeof setInterval> | undefined;
  const thinkingId = setTimeout(() => tick("thinking"), THINKING_DELAY_MS);
  const workingId = setTimeout(() => {
    tick("working");
    intervalId = setInterval(() => tick("working"), WORKING_EVERY_MS);
  }, WORKING_START_MS);
  try {
    return await work;
  } finally {
    clearTimeout(thinkingId);
    clearTimeout(workingId);
    clearInterval(intervalId);
  }
}

// 대화 시작 번호: 끝내기(인증 인계·멈춤·종료)가 늘려, 마이크를 여는 사이에 끝내라는 요청이 오면 시작을 그만둔다
let conversationStarts = 0;
let startingLoop: VoiceLoop | LiveConversation | undefined;
let edge: LiveConversation | undefined;

export function endConversation(withCue = true) {
  conversationStarts += 1;
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
    const fallback = t("지금은 연속 음성 대화를 사용할 수 없어요. {help}", { help: dictationHelp(ui.lang) });
    setError(fallback);
    if (ui.tts) speak(fallback);
    return;
  }
  if (ui.consent !== "granted") {
    setError(t("동의하지 않으셔서 음성 대화를 시작하지 않습니다. 복지 제도 질문은 텍스트로 입력할 수 있습니다."));
    return;
  }
  void preloadCues().catch(() => undefined);
  set({ error: undefined });
  setPhase("starting");
  const sessionId = ui.sessionId;
  if (ui.voiceMode.edge !== undefined && ui.voiceMode.edge.length > 0 && ui.conversationMode === "native") {
    let captionEnd = -1;
    const approvalId = ui.last?.pendingConfirmation?.actionId ?? "";
    const current: LiveConversation = new LiveConversation(sessionId, {
      offer: (socket, sdp) => api.voiceOffer(socket, sdp, approvalId), phase: setPhase, notice: setError,
      activity(text) {
        if (ticket !== conversationStarts) return;
        set({ activity: text });
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
      failure(message) {
        if (ticket !== conversationStarts) return;
        endConversation(false);
        setError(message);
        announce(message);
      },
    });
    edge = startingLoop = current;
    current.enabled = ui.tts;
    current.language = ui.lang;
    try {
      await current.start(ui.micId);
      if (ticket !== conversationStarts) return;
      startingLoop = undefined;
      conversationOn = true;
      setPhase("listening");
      await cue("start");
    } catch (error) {
      current.fail(errorMessage(error));
    }
    return;
  }
  const current = new VoiceLoop(() => api.liveAudio(sessionId));
  current.ignore = () => desk.speaking;
  startingLoop = current;
  const micTrouble =
    t("마이크 연결이 끊겼거나 소리가 들어오지 않습니다. 아이폰 등 다른 기기 마이크가 선택돼 있을 수 있어요. 아래 마이크 선택에서 이 컴퓨터의 마이크를 고른 뒤 대화를 다시 시작해 주세요.");
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
  } catch {
    current.stop();
    if (ticket !== conversationStarts) return;
    startingLoop = undefined;
    setPhase("off");
    setError(micTrouble);
    announce(micTrouble);
    void cue("problem").then(() => speakAndWait(micTrouble));
    return;
  }
  if (ticket !== conversationStarts) {
    current.stop();
    return;
  }
  startingLoop = undefined;
  current.onTrouble = (reason) => {
    setError(micTrouble);
    announce(micTrouble);
    // 잠깐 끊김(mute)은 다시 연결될 수 있으니 대화를 끝내지 않는다. 장치가 아예 사라졌을 때만 끝낸다.
    if (reason === "ended") {
      endConversation(false);
      void cue("problem").then(() => speakAndWait(micTrouble));
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
    announce(t("듣고 있습니다. 말씀하세요."));
    await cue("listen");
    // 승인은 듣기 시작할 때 있던 결정에만 묶는다(듣는 사이에 새로 뜬 승인을 '응'으로 하지 않게)
    const asked = ui.last?.pendingConfirmation?.actionId ?? "";
    const audio = await current.listenOnce(() => setPhase("hearing"));
    if (audio === null || loop !== current) { audio?.cancel(); break; }
    void cue("done");
    setPhase("thinking");
    try {
      const { result: r, capture, sent } = await voiceTurn(audio, asked, current);
      if (loop !== current) break;
      failures = 0;
      missed = 0;
      await applyResult(r, r.state === "STOPPED", true, { sent, capture });
      if (loop !== current) break;
      setPhase("speaking");
      // 끼어들기: 안내 중에 사용자가 말하면 안내를 멈추고 바로 듣는다.
      // 2초 안에 말이 없으면 거짓 끼어들기로 보고 멈춘 안내를 이어 말한다.
      let barged = false;
      const stopWatch = current.watchBargeIn(() => {
        barged = true;
        stopSpeaking();
        announce(t("말씀을 들을게요."));
      });
      await speakTurn(r);
      stopWatch();
      if (barged && conversationOn) {
        const interrupted = takeInterruptedSpeech();
        setPhase("listening");
        const bargeAsked = ui.last?.pendingConfirmation?.actionId ?? "";
        const clip = await current.listenAfterBarge(2000, () => setPhase("hearing"));
        if (clip === null) {
          if (interrupted?.kind === "server" && interrupted.text.length > 0) {
            setPhase("speaking");
            await speakAndWaitFrom(interrupted.text, interrupted.fromChunk);
          }
          continue;
        }
        void cue("done");
        setPhase("thinking");
        try {
          const { result: again, capture, sent } = await voiceTurn(clip, bargeAsked, current);
          if (loop !== current) break;
          await applyResult(again, again.state === "STOPPED", true, { sent, capture });
          if (loop !== current) break;
          setPhase("speaking");
          await speakTurn(again);
        } catch (be) {
          if (interrupted?.kind === "server" && interrupted.text.length > 0 && errorCode(be) === "EMPTY_TRANSCRIPT") {
            setPhase("speaking");
            await speakAndWaitFrom(interrupted.text, interrupted.fromChunk);
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
      setError(message);
      if (++failures >= 3) {
        await cue("problem");
        await speakAndWait(t("문제가 계속되어 대화 모드를 끝냅니다. 텍스트로 입력해 주세요."));
        break;
      }
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
  const held = holdCard();
  const capture = timing?.begin("capture-end");
  const sent = timing?.measure(capture, "turn-sent");
  try {
    const result = await withProgressCues(whileBusy(api.audioTurn(ui.sessionId ?? "", audio, asked), voice));
    return { result, capture, sent };
  } catch (error) {
    timing?.measure(sent, "turn-failed");
    throw error;
  } finally {
    releaseCard(held);
  }
}

const PROGRESS_POLL_MS = 2000;

function sessionProgress(sessionId: string) {
  let pending: ReturnType<typeof api.progress> | undefined;
  return {
    sessionId,
    spoken: 0,
    async poll() {
      if (pending !== undefined) {
        // 이전 작업에서 보낸 응답은 그 작업에서만 사용한다.
        await pending;
        return;
      }
      pending = api.progress(sessionId);
      try { return await pending; }
      finally { pending = undefined; }
    },
  };
}

/** 서버가 일하는 동안(work가 끝날 때까지): 목표 수행의 새 단계를 말하고, 대화 모드(voice)면 '멈춰'와 '지금 어디까지 했어?'를 듣는다. */
async function whileBusy<T>(work: Promise<T>, voice?: VoiceLoop) {
  const stops = [trackProgress(voice), ...(voice !== undefined ? [listenForStopWhileBusy(voice)] : [])];
  try {
    return await work;
  } finally {
    for (const stop of stops) stop();
  }
}

function trackProgress(voice?: VoiceLoop) {
  const session = progressSession;
  if (session === undefined) return () => {};
  const stop = stoppedGeneration;
  const isCurrent = () => session === progressSession && stoppedGeneration === stop;
  const finish = watchProgress({
    isCurrent,
    poll: session.poll,
    wait(next) {
      const timer = setTimeout(next, PROGRESS_POLL_MS);
      return () => clearTimeout(timer);
    },
    apply(report) {
      if (recoverable) tabStore(PROGRESS_KEY, String(report.seq));
      const activity = report.activity ?? null;
      if (ui.activity !== activity) set({ activity });
    },
    considerSpeech(report) {
      if (userTalking || busyTalking) return;
      const next = progressUpdate(report, session.spoken);
      if (next.speak === undefined) return;
      session.spoken = next.seq;
      push({ role: "assistant", text: next.speak });
      announce(next.speak);
      void sayWhileBusy({ speech: next.speak }, voice);
    },
  });
  return () => {
    finish();
    if (isCurrent() && ui.activity != null) set({ activity: null });
  };
}

/** 일하는 동안 짧게 말한다. 그동안은 멈춤 듣기를 쉰다(안내 소리를 받아쓰지 않게). */
async function sayWhileBusy(result: Spoken, voice?: VoiceLoop) {
  busyTalking = true;
  voice?.cancelListening();
  await speakTurn(result);
  busyTalking = false;
}

/**
 * 일하는 동안에도 '멈춰'와 '지금 어디까지 했어?'는 듣는다. 서버가 그 둘만 실행하고(진행 물음은 답을 말한다) 나머지는 버린다.
 * 반환값을 부르면 듣기를 그친다.
 */
function listenForStopWhileBusy(voice: VoiceLoop) {
  let on = true;
  void (async () => {
    while (on && conversationOn) {
      if (busyTalking) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const clip = await voice.listenOnce(() => (userTalking = true));
      userTalking = false;
      // 진행 안내를 말하려고 듣기를 끊었으면 안내가 끝난 뒤 다시 듣는다
      if (clip === null && busyTalking && on) continue;
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
          await sayWhileBusy(r.result, voice);
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
  if (ui.phase === "speaking") {
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
  const rate = ui.baseSpeed >= 1.25 && speechPrefs.rate >= 1.25 ? Math.min(2, speechPrefs.rate * 1.12) : speechPrefs.rate;
  await speakAndWaitFrom(brief, 0, rate);
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
    setError(errorMessage(e));
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
    void speakAndWait(t("알림이에요. {message} 들으셨으면 '알겠어'라고 해 주세요.", { message: text }));
  };
  void check();
  reminderTimer = setInterval(() => void check(), 60 * 60 * 1000);
}

// ---------------------------------------------------------------- 명령·버튼

const insideCommandArea = (el: Element | null) =>
  el !== null && (document.getElementById("command-form")?.contains(el) === true || document.getElementById("examples")?.contains(el) === true);

export async function send(text: string, actionId = ui.last?.pendingConfirmation?.actionId ?? "") {
  const t = text.trim();
  if (t.length === 0 || ui.sessionId === undefined || ui.recovery !== undefined) return;
  if (!await readyForInput()) return;
  const origin = document.activeElement;
  const fromForm = insideCommandArea(origin);
  if (reminderNight && /^지금[.! ]*$/.test(t)) {
    const { text: due } = await api.reminders(ui.sessionId).catch(() => ({ text: undefined }));
    if (due != null && due.length > 0) {
      reminderSeen = `${new Date().toDateString()}|${due}`;
      push({ role: "assistant", text: due });
      if (ui.tts) speak(due);
    }
    return;
  }
  if (reminderNight && /^아침[.! ]*$/.test(t)) return;
  const stop = stoppedGeneration;
  const input = timing?.begin("input-received");
  set({ busy: true, error: undefined });
  timing?.afterPaint(input, "first-state-paint", () => stop === stoppedGeneration && ui.busy);
  const sent = timing?.measure(input, "turn-sent");
  try {
    const result = await whileBusy(api.turn(ui.sessionId, t, actionId));
    if (stop === stoppedGeneration) await applyResult(result, true, true, { sent });
  } catch (e) {
    timing?.measure(sent, "turn-failed");
    setError(errorMessage(e));
  } finally {
    set({ busy: false });
    if (fromForm && stop === stoppedGeneration && ui.recovery === undefined && ui.sessionId !== undefined &&
        (document.activeElement === origin || document.activeElement === document.body)) {
      if (ui.state === "WAITING_FOR_USER_CONFIRMATION") focus("confirm-title");
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
export function submitCommand(value: string) {
  const text = value.trim();
  if (text.length === 0 || ui.sessionId === undefined || ui.busy || ui.recovery !== undefined) return false;
  const actionId = commandActionId ?? "";
  commandActionId = undefined;
  void send(text, actionId);
  return true;
}

export function stopAll() {
  const operation = stopSession();
  desk.stopping = operation;
  return operation.finally(() => {
    if (desk.stopping === operation) desk.stopping = null;
  });
}

async function stopSession() {
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
  endConversation(false);
  stopSpeaking();
  recording?.cancel();
  recording = undefined;
  set({ listening: false, error: undefined, activity: null });
  if (ui.sessionId === undefined) return;
  try {
    const result = await api.cancel(ui.sessionId);
    timing?.measure(requested, "cancel-acknowledged");
    if (stop !== stoppedGeneration) return;
    const stillSleeping = wake === desk.wakeCount;
    if (!stillSleeping && ui.last !== previousTurn) return;
    if (ui.recovery !== undefined) announce(result.speech);
    else await applyResult(result, stillSleeping, stillSleeping, { stop: requested });
  } catch (e) {
    if (stop !== stoppedGeneration || wake !== desk.wakeCount) return;
    desk.sleeping = false;
    setError(errorMessage(e));
  }
}

/** 승인·거절: 화면에 보여 준 승인 번호(actionId)로만 보낸다. */
async function confirm(approve: boolean, actionId: string) {
  if (ui.sessionId === undefined || ui.recovery !== undefined) return;
  const stop = stoppedGeneration;
  const input = timing?.begin("input-received");
  set({ busy: true });
  timing?.afterPaint(input, "first-state-paint", () => stop === stoppedGeneration && ui.busy);
  const sent = timing?.measure(input, "turn-sent");
  try {
    const result = await whileBusy(api.confirm(ui.sessionId, approve, actionId));
    if (stop === stoppedGeneration) await applyResult(result, true, true, { sent });
  } catch (e) {
    timing?.measure(sent, "turn-failed");
    setError(errorMessage(e));
  } finally {
    set({ busy: false });
  }
}

/** 서버가 제안한 선택지(인증 마침·인증 취소·본문 읽기): 그 응답(turnId)과 인계 번호에 묶어 보낸다. */
async function chooseOffer(card: Extract<Decision, { kind: "offer" }>, key: string) {
  if (ui.sessionId === undefined || ui.recovery !== undefined) return;
  const stop = stoppedGeneration;
  const generation = sessionGeneration;
  set({ busy: true, error: undefined });
  try {
    const handoffId = card.ref.handoffId;
    const body = { turnId: card.ref.turnId, key, ...(handoffId !== undefined && handoffId.length > 0 ? { handoffId } : {}) };
    const result = await whileBusy(api.choice(ui.sessionId, body));
    if (stop === stoppedGeneration && generation === sessionGeneration) await applyResult(result);
  } catch (e) {
    if (errorCode(e) !== "CHOICE_EXPIRED") setError(errorMessage(e));
    else {
      desk.dropped.add(card.key);
      notice(errorMessage(e));
    }
  } finally {
    set({ busy: false });
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
export async function choose(choiceSetId: string, key: string) {
  const card = desk.card;
  if (card === undefined || card.id !== choiceSetId) {
    notice(t("선택지가 바뀌었어요. 지금 안내를 다시 확인해 주세요."));
    return;
  }
  const offered = card.choices.some((c) => c.key === key && c.open === undefined);
  const run = offered ? cardAction(card, key) : undefined;
  if (run === undefined || ui.busy) return;
  const origin = document.activeElement;
  const fromDecision = insideDecision(origin);
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
  return send(key === "auth-done" ? "다 했어" : "인증 취소");
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
  push({ role: "assistant", text });
  announce(text);
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
  if (!await readyForInput() || openingMic || ui.last?.authHandoff?.status === "waiting") return;
  if (recording !== undefined) {
    const rec = recording;
    const generation = stoppedGeneration;
    recording = undefined;
    set({ listening: false, busy: true });
    announce(t("인식 중입니다."));
    const audio = await rec.stop();
    const capture = timing?.begin("capture-end");
    void cue("done");
    const sent = timing?.measure(capture, "turn-sent");
    try {
      const result = await withProgressCues(whileBusy(api.audioTurn(ui.sessionId ?? "", audio, rec.asked)));
      if (generation === stoppedGeneration) await applyResult(result, true, true, { sent, capture });
    } catch (e) {
      timing?.measure(sent, "turn-failed");
      if (generation === stoppedGeneration) setError(errorMessage(e));
    } finally {
      set({ busy: false });
    }
    return;
  }
  stopSpeaking();
  set({ error: undefined });
  openingMic = true;
  const sessionId = ui.sessionId, generation = stoppedGeneration;
  try {
    await cue("listen");
    const asked = ui.last?.pendingConfirmation?.actionId ?? "";
    const rec = await startRecording(() => api.liveAudio(sessionId), ui.micId, () => void toggleMic());
    if (sessionId !== ui.sessionId || generation !== stoppedGeneration || ui.consent !== "granted"
        || dialogNow() !== undefined || authWaiting()) {
      rec.cancel();
      return;
    }
    recording = Object.assign(rec, { asked });
    set({ listening: true });
    announce(t("듣는 중입니다. 말씀을 마치면 버튼을 다시 누르세요."));
  } catch {
    setError(t("마이크를 사용할 수 없습니다. 브라우저 마이크 권한을 확인하거나 텍스트로 입력하세요."));
  } finally {
    openingMic = false;
  }
}

export function toggleTts() {
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
    let track = (edge?.stream ?? loop?.stream)?.getAudioTracks().find((t) => t.readyState === "live");
    if (track === undefined) {
      probe = await navigator.mediaDevices.getUserMedia({ audio: ui.micId !== undefined && ui.micId.length > 0 ? { deviceId: { exact: ui.micId } } : true });
      track = probe.getAudioTracks()[0];
    }
    set({ micCheckResult: workspaceText(track?.readyState === "live" ? "마이크를 사용할 수 있어요." : "연결된 마이크를 확인해 주세요.", ui.lang) });
  } catch (error) {
    set({ micCheckResult: workspaceText(error instanceof Error && error.name === "NotAllowedError"
      ? "마이크 권한이 꺼져 있어요. 기기의 마이크 권한 설정을 확인해 주세요."
      : "마이크를 열 수 없어요. 연결과 입력 장치 선택을 확인해 주세요.", ui.lang) });
  } finally {
    probe?.getTracks().forEach((track) => track.stop());
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
    await loadWorkspaceLanguage(lang);
    if (!current()) return;
    const r = await api.language(sid, lang);
    if (!current()) return;
    await applyResult(r, !conversationOn);
    if (conversationOn && current()) await speakTurn(r);
  } catch (err) {
    if (current()) setError(err instanceof Error ? err.message : t("언어를 바꾸지 못했습니다."));
  } finally {
    if (current()) set({ requestedLanguage: undefined });
  }
}

export function focusCommand() { focus("command"); }

// ---------------------------------------------------------------- 이벤트 연결

function bind() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && skipIntro()) e.preventDefault();
  });
  // 데스크톱 앱: 전역 단축키(Cmd/Ctrl+Shift+Space)로 '지금 말하기'
  desktop?.onTalk(() => talkNow());
  // 아바타·트레이에서 온 동작(메인 프로세스가 모양을 확인해 넘긴다)
  desktop?.onAction?.((action) => {
    if (typeof action !== "object" || action === null || !("type" in action)) return;
    if (action.type === "settings") void openSettings();
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
  if (s.sessionId !== progressSession?.sessionId) progressSession = sessionProgress(s.sessionId);
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
  set({ sessionId: s.sessionId, state: s.state ?? "IDLE" });
}

export async function endSession() {
  timing?.cancelPending();
  const sid = ui.sessionId;
  progressSession = undefined;
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
    sessionId: undefined, state: "IDLE", last: undefined, hasTurn: false, busy: false, listening: false, consent: undefined, lang: desktopLanguage ?? "ko", requestedLanguage: undefined,
    messages: [], activity: null, commandReset: ui.commandReset + 1, sessionNew: true,
  });
  focus("session-new");
  try {
    if (sid !== undefined) await api.end(sid);
  } catch (error) {
    if (errorStatus(error) !== 404) setError(errorMessage(error));
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
  } catch (error) {
    const status = errorStatus(error);
    if (status === 410 || status === 404) await endSession();
    setError(errorMessage(error));
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
      settingsAvailable: h.settingsAvailable === true,
      baseSpeed: h.voiceSpeed ?? 1.35,
      voiceMode: {
        known: true, stt: h.stt.supported, tts: h.tts.supported, edge: h.voiceEdge, llmRoles: h.llmRoles ?? {},
        label: "",
        sttProvider: h.stt.supported ? h.stt.liveModel ?? h.stt.provider : undefined,
        ttsProvider: h.tts.supported ? h.tts.provider : undefined,
      },
      tts: h.tts.supported,
    });
    return h;
  }).catch((error: unknown) => {
    setError(errorMessage(error));
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
    set({ lang: language, announcement: { text: workspaceText("청음을 준비하고 있어요.", language), seq: ui.announcement.seq } });
    if (s.speechPrefs !== undefined) applySpeechPrefs(s.speechPrefs);
    if (!s.consentRequired) {
      setConsent("granted");
      announce(t("청음이 준비됐어요."));
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
    setError(t("세션을 시작하지 못했습니다. {reason}", { reason: errorMessage(e) }));
    set({ sessionNew: true });
    focus("session-new");
  }
}
