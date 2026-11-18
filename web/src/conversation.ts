import { LANGS as ALL_LANGS, STATE_LABELS_KO, type Lang, type SessionState, type TurnResult } from "../../src/core/turn.ts";
import { api } from './api.ts';
import { getSpeechLang, setSpeechLang, unlockAudio } from './audio.ts';
import { browserStt, listMicrophones, preferredMicrophone, startRecording, VoiceLoop } from './mic.ts';
import { applySpeechPrefs, browserTts, earcon, preloadCues, progressVoice, serverTts, takeInterruptedSpeech, transitionCue, type CueKind } from './speaker.ts';

interface VoiceMode {
  stt: boolean; tts: boolean; label: string; localLanguages: Lang[]; llmRoles: Record<string,string>;
}
type Consent = 'loading' | 'intro' | 'ask' | 'granted' | 'declined';
interface Message { role: 'user' | 'assistant' | 'system'; text: string }
/** 화면 낭독기에 알릴 글. 같은 글이어도 id가 새로우면 다시 읽힌다. */
interface Notice { text: string; id: number }
export interface UiState {
  sessionId?: string; state: SessionState; last?: TurnResult; lang: Lang; pendingLang?: Lang; busy: boolean;
  listening: boolean; voiceMode: VoiceMode; tts: boolean; contrast: boolean; error?: Notice;
  phase: keyof typeof PHASE_LABELS; consent: Consent; mics: {id: string; label: string}[];
  micId?: string; messages: (Message & { id: number })[]; announcement?: Notice;
  focus?: { id: string }; clearInput: number;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
const EXAMPLES = [
  '장애인연금 신청 도와줘',
  '이름은 김하늘',
  '주소는 부산광역시 예시구 예시로 10',
  '주소 다시 읽어줘',
  '다음으로',
  '이 항목은 무슨 뜻이야?',
  '화면 설명해줘',
  '복지로 열어줘',
  '본문 읽어줘',
  '링크 목록 알려줘',
  '장애인연금 얼마 받아?',
  '지금까지 쓴 내용 읽어줘',
  '모의 접수 내용을 확인했어',
];

const BACKGROUND = new URLSearchParams(location.search).get('background') === '1';



/** 음성이 어디로 가는지(서버 /api/health의 stt.localLanguages = 이 컴퓨터 안에서 받아쓰는 언어) */
function voiceRouteText(local: Lang[] = []) {
  if (ALL_LANGS.every((l) => local.includes(l)))
    return '말씀하신 음성은 이 컴퓨터 안에서 글자로 바뀌며 밖으로 전송되지 않습니다. 청음은 녹음을 저장하지 않습니다.';
  if (local.includes('ko'))
    return '한국어 음성은 이 컴퓨터 안에서 글자로 바뀌며 밖으로 전송되지 않습니다. 영어, 중국어, 일본어 음성은 받아쓰기를 위해 외부 인공지능 서비스인 OpenAI로 전송됩니다. 청음은 녹음을 저장하지 않습니다.';
  return '말씀하신 음성은 받아쓰기를 위해 외부 인공지능 서비스인 OpenAI로 전송되며, 청음은 녹음을 저장하지 않습니다.';
}

/** 도움말 한 줄: 음성 인식이 어디서 이루어지는지 */
function voiceHelp(voiceMode: VoiceMode) {
  const local = voiceMode.localLanguages;
  if (ALL_LANGS.every((l) => local.includes(l))) return '음성은 이 컴퓨터 안에서 받아씁니다';
  if (local.includes('ko')) return '한국어 음성은 이 컴퓨터 안에서 받아쓰고, 다른 언어는 외부 음성 인식 서비스로 전송됩니다';
  return '음성은 외부 음성 인식 서비스로 전송됩니다';
}

/** 역할별 LLM이 어디로 가는지(/api/health.llmRoles). rules·mock은 밖으로 안 나감. */
function llmRouteText(roles: Record<string,string> = {}) {
  const label: Record<string,string> = { understand: '말씀 이해', goal: '목표 수행', web: '화면·검색 요약' };
  const external = Object.entries(roles)
    .filter(([k, v]) => Object.hasOwn(label, k) && v.length > 0 && !/^(rules|mock)/i.test(v))
    .map(([k, v]) => `${label[k]}은 ${v}`);
  if (external.length === 0) return '글 이해는 이 컴퓨터의 규칙으로만 처리합니다.';
  return `글 이해에 쓰는 인공지능은 역할마다 다를 수 있어요. ${external.join(', ')}.`;
}

/** 시작 동의 안내: 무엇을 하는지, 무엇이 외부로 나가는지, 무엇을 하지 않는지, 어떻게 멈추는지 */
function consentText() {
  return (
    '안녕하세요. 음성 복지 도우미 청음입니다. 시작하기 전에 안내드립니다. ' +
    '동의하시면 청음은 별도의 브라우저 창으로 웹사이트를 열어 화면을 읽어드리고, 지원하는 연습용 신청 사이트에서는 입력을 대신합니다. ' +
    '그 밖의 사이트는 읽기, 이동, 검색만 하고 입력이나 제출은 하지 않습니다. 실제 접수는 하지 않으며, 중요한 동작 전에는 꼭 다시 여쭤봅니다. ' +
    `${voiceRouteText(ui.voiceMode.localLanguages)} ${llmRouteText(ui.voiceMode.llmRoles)} 비밀번호나 주민등록번호는 말하지 마세요. ` +
    "언제든 '멈춰'라고 말하면 멈춥니다. " +
    (BACKGROUND
      ? `동의하시면 ${/Mac/.test(navigator.platform) ? '커맨드' : '컨트롤'}, 시프트, 스페이스 키를 함께 눌러 주세요. 동의하지 않으시면 메뉴 막대의 청음에서 종료를 고르세요.`
      : '동의하시면 Enter를, 동의하지 않으시면 Escape를 눌러 주세요.')
  );
}

// 서버 음성 설정을 받아 오기 전에는 동의 안내를 읽지 않는다(어디로 전송되는지가 바뀌므로)
let healthReady = Promise.resolve();

const GREETING = '무엇을 도와드릴까요? 띵 소리가 나면 말씀하세요. 제가 말하는 중에도 말씀하시면 멈추고 들을게요.';

const PHASE_LABELS = {
  off: '꺼짐',
  starting: '준비 중',
  listening: '듣고 있어요 — 말씀하세요',
  hearing: '말씀을 듣는 중…',
  thinking: '처리 중…',
  speaking: '안내하는 중…',
};

const UNSUPPORTED = ['실제 사이트에서의 제출·로그인·본인인증(사용자가 직접)', '사람 상담 연결'];

/** 데스크톱 앱(Electron)에서 실행 중이면 preload가 넣어 준다. 소리 자동재생이 허용되어 있다. */
const desktop = window.cheongeumDesktop;



const readMicId = () => {
  try {
    return localStorage.getItem('cheongeum.micId') ?? undefined;
  } catch {
    return undefined;
  }
};

/** 화면 상태(바뀌면 render()로 해당 부분만 다시 그린다) */
let ui: UiState = {
  messages: [], clearInput: 0,
  sessionId: undefined,
  state: 'IDLE',
  last: undefined,
  lang: 'ko',
  busy: false,
  listening: false,
  voiceMode: { stt: false, tts: false, label: '브라우저 음성', localLanguages: [], llmRoles: {} },
  tts: browserTts.supported,
  contrast: false,
  error: undefined,
  phase: 'off',
  consent: 'loading', // loading | intro | ask | granted | declined
  mics: [],
  micId: readMicId(),
};

// 긴 비동기 루프·녹음 상태(화면에는 직접 나오지 않음)
let turnEpoch = 0;
let buttonCapture: AbortController | undefined;
let loop: VoiceLoop | undefined;
let recording: Awaited<ReturnType<typeof startRecording>> | undefined;
let stopListening: (() => void) | undefined;
let reminderTimer: ReturnType<typeof setInterval> | undefined;
let messageSeq = 0;
let noticeSeq = 0;
// 일하는 동안: 사용자가 말하는 중 / 청음이 짧은 안내(진행 상황)를 말하는 중
let hearingVoice: VoiceLoop | undefined;
let busySpeech: object | undefined;
/** 마이크 경로 신호음은 음성 안내 꺼짐과 관계없이 낸다. 결과·알림 신호음은 ui.tts를 따른다. */
const MIC_CUES = new Set(['start', 'listen', 'done', 'thinking', 'working', 'stopped', 'end']);
const STOP_CUE_WINDOW_MS = 5000;
let stopCuedAt = 0;

function cue(kind: CueKind, active = () => true) {
  if (!MIC_CUES.has(kind) && !ui.tts) return Promise.resolve();
  const epoch = turnEpoch;
  return earcon(kind, () => epoch === turnEpoch && active());
}

function cueStopped() {
  stopCuedAt = Date.now();
  void cue('stopped');
}

const listeners = new Set<() => void>();
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function snapshot(): UiState { return ui; }
function set(patch: Partial<UiState>) {
  ui = { ...ui, ...patch };
  for (const listener of listeners) listener();
}
function focus(id: string) { set({ focus: { id } }); }
function announce(text: string) { set({ announcement: { text, id: noticeSeq++ } }); }
function setError(message: string) { set({ error: { text: message, id: noticeSeq++ } }); }
function push(message: Message) { set({messages: [...ui.messages, { ...message, id: messageSeq++ }]}); }
function setPhase(p: UiState['phase']) {
  set({ phase: p });
}

// ---------------------------------------------------------------- 응답·음성

async function applyResult(r: TurnResult, speakIt = true, active = () => true) {
  if (!active()) return;
  const epoch = turnEpoch;
  const prevTurn = ui.last?.turnId;
  const prevState = ui.state;
  setSpeechLang(r.lang);
  if (r.speechPrefs) applySpeechPrefs(r.speechPrefs);
  set({ last: r, state: r.state, lang: r.lang ?? 'ko' });
  push({ role: 'user', text: r.userUtterance });
  push({ role: 'assistant', text: r.speech });
  announce(`상태: ${STATE_LABELS_KO[r.state]}`);
  const kind = transitionCue(prevState, r.state);
  if (kind !== undefined && !(kind === 'stopped' && Date.now() - stopCuedAt < STOP_CUE_WINDOW_MS)) await cue(kind);
  if (epoch !== turnEpoch || ui.last?.turnId !== r.turnId || !active()) return;
  if (ui.tts && speakIt) {
    // 본인인증 인계: 안내 한 번만 말하고 TTS를 멈춰 화면 낭독기가 입력 칸을 읽게 한다
    if (r.state === 'AUTH_HANDOFF') void speakAndWait(r.speech);
    else speak(r.speech);
  }
  if (r.state === 'WAITING_FOR_USER_CONFIRMATION' && r.turnId !== prevTurn) focus('confirm-title');
}

/** 서버 TTS가 있으면 사용하고, 실패하면 브라우저 음성으로 대체한다. */
function speak(text: string) {
  if (!ui.voiceMode.tts) return browserTts.speak(text);
  void serverTts.speak(text, (chunk, signal) => api.speak(chunk, getSpeechLang(), signal)).then((result) => {
    if (result === 'blocked') {
      setError('브라우저가 소리 재생을 막았습니다. 화면을 한 번 클릭하거나 "소리 확인" 버튼을 눌러 주세요.');
    } else if (result === 'failed') {
      setError('서버 음성 재생에 실패해 브라우저 음성으로 읽습니다.');
      browserTts.speak(text);
    }
  });
}

function stopSpeaking() {
  browserTts.cancel();
  serverTts.cancel();
}

/** 말이 끝날 때까지 기다린다(대화 모드: 끝난 뒤에 다시 듣기). */
async function speakAndWaitFrom(text: string, fromChunk = 0) {
  if (!ui.tts) return;
  if (!ui.voiceMode.tts) {
    await browserTts.speakAndWait(text);
    return;
  }
  const result = await serverTts.speak(text, (chunk, signal) => api.speak(chunk, getSpeechLang(), signal), fromChunk);
  if (result === 'failed') await browserTts.speakAndWait(text);
}

async function speakAndWait(text: string) {
  if (!ui.tts) return;
  if (!ui.voiceMode.tts) return browserTts.speakAndWait(text);
  const result = await serverTts.speak(text, (chunk, signal) => api.speak(chunk, getSpeechLang(), signal));
  if (result === 'failed') await browserTts.speakAndWait(text);
  if (result === 'blocked') setError('브라우저가 소리 재생을 막았습니다. 화면을 한 번 클릭해 주세요.');
}

const THINKING_DELAY_MS = 1000;
const WORKING_START_MS = 3000;
const WORKING_EVERY_MS = 2500;

/** work가 끝날 때까지만 생각중·일하는중 신호음을 낸다. 답을 말하기 전에 그치고, 일하는 중에 안내를 말하는 동안은 건너뛴다. */
async function withProgressCues<T>(work: Promise<T>, active = () => true) {
  const epoch = turnEpoch;
  const tick = (kind: CueKind) => {
    if (busySpeech === undefined && active() && epoch === turnEpoch) void cue(kind, active);
  };
  let intervalId: ReturnType<typeof setInterval> | undefined;
  const thinkingId = setTimeout(() => tick('thinking'), THINKING_DELAY_MS);
  const workingId = setTimeout(() => {
    tick('working');
    intervalId = setInterval(() => tick('working'), WORKING_EVERY_MS);
  }, WORKING_START_MS);
  try {
    return await work;
  } finally {
    clearTimeout(thinkingId);
    clearTimeout(workingId);
    clearInterval(intervalId);
  }
}

function endConversation(withCue = true) {
  if (withCue && loop !== undefined) void cue('end');
  if (loop !== undefined) stopSpeaking();
  loop?.stop();
  if (hearingVoice === loop) hearingVoice = undefined;
  loop = undefined;
  setPhase('off');
}

/**
 * 핸즈프리 대화: 인사 → (듣기 → 서버로 보내 받아쓰기·실행 → 답 말하기) 반복.
 * 브라우저 정책상 마이크·소리는 사용자 동작이 한 번 필요해서 '대화 시작' 버튼으로 시작한다.
 */
async function startConversation() {
  if (loop !== undefined || ui.sessionId === undefined) return;
  const sessionId = ui.sessionId;
  if (!ui.voiceMode.stt) {
    setError('대화 모드는 서버 음성 인식(STT_PROVIDER=local 또는 openai)이 필요합니다. 지금은 음성 입력 버튼이나 텍스트를 사용하세요.');
    return;
  }
  if (ui.consent === 'declined') {
    setError('동의하지 않으셔서 음성 대화를 시작하지 않습니다. 복지 제도 질문은 텍스트로 입력할 수 있습니다.');
    return;
  }
  unlockAudio();
  void preloadCues().catch(() => undefined);
  set({ error: undefined });
  setPhase('starting');
  stopButtonCapture();
  const current = new VoiceLoop();
  loop = current;
  const active = () => loop === current;
  const micTrouble =
    '마이크 연결이 끊겼거나 소리가 들어오지 않습니다. 아이폰 등 다른 기기 마이크가 선택돼 있을 수 있어요. 아래 마이크 선택에서 이 컴퓨터의 마이크를 고른 뒤 대화를 다시 시작해 주세요.';
  function reportDisconnected() {
    endConversation(false);
    setError(micTrouble);
    announce(micTrouble);
    const epoch = turnEpoch;
    const stillOff = () => epoch === turnEpoch && loop === undefined && ui.error?.text === micTrouble;
    void cue('problem', stillOff).then(() => { if (stillOff()) return speakAndWait(micTrouble); });
  }
  try {
    // 저장된 마이크가 없으면 권한을 받은 뒤 내장 마이크를 골라 다시 연다(아이폰 연속성 마이크 회피).
    await current.start(ui.micId);
    if (!active()) return;
    const list = await listMicrophones().catch(() => []);
    if (!active()) return;
    set({ mics: list });
    const preferred = ui.micId ?? preferredMicrophone(list);
    if (ui.micId === undefined && preferred !== undefined && list.length > 1) {
      current.stop();
      await current.start(preferred);
      if (!active()) return;
      set({ micId: preferred });
    }
    const silent = await current.isSilent();
    if (!active()) return;
    if (silent) throw new Error('silent');
  } catch {
    if (!active()) return;
    reportDisconnected();
    return;
  }
  current.onTrouble = (reason) => {
    if (!active()) return;
    // 잠깐 끊김(mute)은 다시 연결될 수 있으니 대화를 끝내지 않는다. 장치가 아예 사라졌을 때만 끝낸다.
    if (reason === 'ended') {
      reportDisconnected();
    } else { setError(micTrouble); announce(micTrouble); }
  };
  void current.startClapDetector(() => { if (active()) talkNow(); }, ui.micId);
  push({ role: 'system', text: `사용하는 마이크: ${current.deviceLabel.length > 0 ? current.deviceLabel : '기본 마이크'}` });
  setPhase('speaking');
  await cue('start', active);
  if (!active()) return;
  push({ role: 'assistant', text: GREETING });
  await speakAndWait(GREETING);

  let failures = 0;
  while (active()) {
    setPhase('listening');
    announce('듣고 있습니다. 말씀하세요.');
    await cue('listen', active);
    if (!active()) break;
    const audio = await current.listenOnce(() => setPhase('hearing')).catch(() => {
      if (active()) reportDisconnected();
      return null;
    });
    if (audio === null || !active()) break;
    void cue('done', active);
    setPhase('thinking');
    try {
      const r = await withProgressCues(whileBusy(api.audioTurn(sessionId, audio), current), active);
      failures = 0;
      await applyResult(r, false, active);
      if (!active()) break;
      setPhase('speaking');
      // 끼어들기: 안내 중에 사용자가 말하면 안내를 멈추고 바로 듣는다.
      // 2초 안에 말이 없으면 거짓 끼어들기로 보고 멈춘 안내를 이어 말한다.
      let barged = false;
      const stopWatch = current.watchBargeIn(() => {
        if (!active()) return;
        barged = true;
        stopSpeaking();
        announce('말씀을 들을게요.');
      });
      try { await speakAndWait(r.speech); } finally { stopWatch(); }
      if (barged && active()) {
        const interrupted = takeInterruptedSpeech();
        setPhase('listening');
        const clip = await current.listenAfterBarge(2000, () => setPhase('hearing'));
        if (!active()) break;
        if (clip === null) {
          if (interrupted !== null && interrupted.text.length > 0) {
            setPhase('speaking');
            await speakAndWaitFrom(interrupted.text, interrupted.fromChunk);
          }
          continue;
        }
        void cue('done', active);
        setPhase('thinking');
        try {
          const again = await withProgressCues(whileBusy(api.audioTurn(sessionId, clip), current), active);
          await applyResult(again, false, active);
          if (!active()) break;
          setPhase('speaking');
          await speakAndWait(again.speech);
        } catch (be) {
          if (!active()) break;
          if (interrupted !== null && interrupted.text.length > 0 && /알아듣지 못했습니다/.test(errorMessage(be))) {
            setPhase('speaking');
            await speakAndWaitFrom(interrupted.text, interrupted.fromChunk);
          } else {
            throw be;
          }
        }
      }
    } catch (e) {
      if (!active()) break;
      const message = errorMessage(e);
      if (/알아듣지 못했습니다/.test(message)) {
        setPhase('speaking');
        await cue('problem', active);
        if (active()) await speakAndWait('잘 못 들었어요. 다시 말씀해 주세요.');
        continue;
      }
      setError(message);
      if (++failures >= 3) {
        await cue('problem', active);
        if (active()) await speakAndWait('문제가 계속되어 대화 모드를 끝냅니다. 텍스트로 입력해 주세요.');
        break;
      }
    }
    // 스피커 소리 잔향이 마이크로 들어가지 않게 잠깐 쉰다.
    await new Promise((r) => setTimeout(r, 300));
  }
  if (active()) endConversation();
}

const PROGRESS_POLL_MS = 2000;

/** 서버가 일하는 동안(work가 끝날 때까지): 목표 수행의 새 단계를 말하고, 대화 모드(voice)면 '멈춰'와 '지금 어디까지 했어?'를 듣는다. */
async function whileBusy<T>(work: Promise<T>, voice?: VoiceLoop) {
  const stops = [watchProgress(voice), ...(voice ? [listenForStopWhileBusy(voice)] : [])];
  try {
    return await work;
  } finally {
    for (const stop of stops) stop();
  }
}

/** 몇 초마다 진행 상황을 물어, 말할 단계가 있으면 한 문장 말한다(간격과 조용히 할 때는 progressVoice가 정함). 반환값을 부르면 그친다. */
function watchProgress(voice?: VoiceLoop) {
  let on = true;
  const epoch = turnEpoch;
  progressVoice.start();
  const timer = setInterval(async () => {
    if (ui.sessionId === undefined) return;
    const p = await api.progress(ui.sessionId).catch(() => undefined);
    // 묻는 사이에 일이 끝났으면 말하지 않는다(답을 끊지 않게)
    if (!on || epoch !== turnEpoch || (voice !== undefined && loop !== voice) || p === undefined) return;
    const text = progressVoice.pick(p, hearingVoice !== undefined || busySpeech !== undefined);
    if (text == null || text.length === 0) return;
    push({ role: 'assistant', text });
    announce(text);
    void sayWhileBusy(text, voice);
  }, PROGRESS_POLL_MS);
  return () => {
    on = false;
    clearInterval(timer);
  };
}

/** 일하는 동안 짧게 말한다. 그동안은 멈춤 듣기를 쉰다(안내 소리를 받아쓰지 않게). */
async function sayWhileBusy(text: string, voice?: VoiceLoop) {
  if (voice !== undefined && loop !== voice) return;
  const speech = {};
  busySpeech = speech;
  voice?.cancelListening();
  try { await speakAndWait(text); } finally { if (busySpeech === speech) busySpeech = undefined; }
}

/**
 * 일하는 동안에도 '멈춰'와 '지금 어디까지 했어?'는 듣는다. 서버가 그 둘만 실행하고(진행 물음은 답을 말한다) 나머지는 버린다.
 * 반환값을 부르면 듣기를 그친다.
 */
function listenForStopWhileBusy(voice: VoiceLoop) {
  let on = true;
  void (async () => {
    while (on && loop === voice) {
      if (busySpeech !== undefined) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const clip = await voice.listenOnce(() => { hearingVoice = voice; }).catch(() => null);
      if (hearingVoice === voice) hearingVoice = undefined;
      // 진행 안내를 말하려고 듣기를 끊었으면 안내가 끝난 뒤 다시 듣는다
      if (clip === null && busySpeech !== undefined && on) continue;
      if (!clip || !on) break;
      try {
        if (ui.sessionId === undefined) break;
        const r = await api.audioStop(ui.sessionId, clip);
        if (!on || loop !== voice) break;
        if (r.stopped) {
          cueStopped();
          announce('멈출게요.');
        } else if (r.result) {
          await applyResult(r.result, false, () => on && loop === voice);
          if (on && loop === voice) await sayWhileBusy(r.result.speech, voice);
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
function talkNow() {
  // 백그라운드 데스크톱 앱: 창이 없어 Enter를 누를 수 없으므로 동의 안내 중의 단축키 = 동의
  if (ui.consent === 'intro') return void hearConsent();
  if (ui.consent === 'ask') return void answerConsent(true);
  if (loop === undefined) {
    if (ui.consent === 'granted') void startConversation();
    return;
  }
  if (ui.phase === 'speaking') {
    stopSpeaking();
    announce('안내를 멈췄습니다. 말씀하세요.');
  } else if (ui.phase === 'hearing') {
    loop?.endUtterance();
  } else if (ui.phase === 'thinking') {
    // 창이 없는 데스크톱 모드에서는 단축키가 유일한 멈춤 수단이다.
    cueStopped();
    announce('멈출게요.');
    if (ui.sessionId !== undefined) void api.cancel(ui.sessionId).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- 동의

function setConsent(consent: Consent) {
  set({ consent });
  // 준비되면 동의 버튼 또는 '대화 시작' 버튼에 포커스: Enter 한 번으로 진행할 수 있게.
  if (ui.sessionId === undefined) return;
  if (consent === 'intro') focus('consent-hear');
  else if (consent === 'ask') focus('consent-yes');
  else if (consent === 'granted') {
    focus('conv-start');
    startReminders();
  }
}

/** 1단계: 안내 듣기(이 버튼 누름으로 소리 재생이 허용된다). 2단계: Enter=동의, Esc=거부 */
async function hearConsent() {
  unlockAudio();
  void preloadCues().catch(() => undefined);
  setConsent('ask');
  await healthReady;
  if (ui.consent !== 'ask') return;
  const text = consentText();
  push({ role: 'assistant', text });
  await speakAndWait(text);
}

async function answerConsent(granted: boolean) {
  if (ui.sessionId === undefined) return;
  stopSpeaking();
  try {
    const r = await api.consent(ui.sessionId, granted);
    setConsent(granted ? 'granted' : 'declined');
    await applyResult(r, false);
    if (granted) {
      // 같은 키 입력 안에서 마이크를 켜야 브라우저가 허용한다.
      void startConversation();
    } else {
      await speakAndWait(r.speech);
      focus('command');
    }
  } catch (e) {
    setError(errorMessage(e));
  }
}

/** 신청 기록 기한 알림: 웹·데스크톱 모두. 하루 한 번, 밤(22–7시)에는 지금/아침을 먼저 묻는다. '알겠어'면 그날은 다시 안 함. */
function startReminders() {
  if (ui.sessionId === undefined || reminderTimer !== undefined) return;
  const id = ui.sessionId;
  const check = async () => {
    const { text } = await api.reminders(id).catch(() => ({ text: null }));
    if (text == null || text.length === 0) return;
    const day = new Date().toDateString();
    const key = `cheongeum.reminded.${day}`;
    const ackKey = `cheongeum.remindAck.${day}`;
    let seen = null;
    let acked = null;
    try {
      seen = localStorage.getItem(key);
      acked = localStorage.getItem(ackKey);
    } catch {
      seen = null;
    }
    if (acked === text || seen === text || ui.phase === 'speaking' || ui.phase === 'hearing') return;
    const hour = new Date().getHours();
    const night = hour >= 22 || hour < 7;
    if (night && sessionStorage.getItem(`cheongeum.remindNight.${day}`) === null) {
      sessionStorage.setItem(`cheongeum.remindNight.${day}`, '1');
      push({ role: 'assistant', text: `기한 알림이 있어요. 지금 들을까요, 아침에 들을까요?` });
      await cue('reminder');
      await speakAndWait('기한 알림이 있어요. 지금 들으려면 \'지금\', 아침에 들으려면 \'아침\'이라고 해 주세요.');
      return;
    }
    try {
      localStorage.setItem(key, text);
    } catch {
      /* 저장소를 못 쓰면 매번 알린다 */
    }
    push({ role: 'assistant', text: `알림: ${text}` });
    await cue('reminder');
    void speakAndWait(`알림이에요. ${text} 들으셨으면 '알겠어'라고 해 주세요.`);
  };
  void check();
  reminderTimer = setInterval(() => void check(), 60 * 60 * 1000);
}

// ---------------------------------------------------------------- 명령·버튼

async function send(text: string) {
  const t = text.trim();
  if (t.length === 0 || ui.sessionId === undefined) return;
  set({clearInput: ui.clearInput + 1}); // 입력창에 원문(특히 민감정보)이 남지 않게 즉시 비운다.
  // 기한 알림: '알겠어'면 그날 같은 알림 반복 안 함. 밤 안내는 지금/아침.
  const day = new Date().toDateString();
  try {
    if (/^(알겠어|알았어|알겠어요|알았어요)/.test(t)) {
      const key = `cheongeum.reminded.${day}`;
      const seen = localStorage.getItem(key);
      if (seen !== null) localStorage.setItem(`cheongeum.remindAck.${day}`, seen);
    }
    if (/^지금/.test(t) && sessionStorage.getItem(`cheongeum.remindNight.${day}`) !== null) {
      sessionStorage.removeItem(`cheongeum.remindNight.${day}`);
      // 곧 startReminders 주기에서 다시 읽어 말함
    }
    if (/^아침/.test(t) && sessionStorage.getItem(`cheongeum.remindNight.${day}`) !== null) {
      localStorage.setItem(`cheongeum.remindAck.${day}`, localStorage.getItem(`cheongeum.reminded.${day}`) ?? 'morning');
    }
  } catch {
    /* storage */
  }
  const epoch = turnEpoch;
  set({ busy: true, error: undefined });
  try {
    await applyResult(await whileBusy(api.turn(ui.sessionId, t)), true, () => epoch === turnEpoch);
  } catch (e) {
    if (epoch === turnEpoch) setError(errorMessage(e));
  } finally {
    if (epoch === turnEpoch) {
      set({ busy: false });
      focus('command');
    }
  }
}

async function stopAll() {
  const epoch = ++turnEpoch;
  cueStopped();
  endConversation(false);
  stopSpeaking();
  stopButtonCapture();
  set({ busy: false });
  if (ui.sessionId === undefined) return;
  try {
    await applyResult(await api.cancel(ui.sessionId), true, () => epoch === turnEpoch && loop === undefined);
  } catch (e) {
    setError(errorMessage(e));
  }
}

async function confirm(approve: boolean) {
  if (ui.sessionId === undefined) return;
  const epoch = turnEpoch;
  set({ busy: true });
  try {
    await applyResult(await api.confirm(ui.sessionId, approve), true, () => epoch === turnEpoch);
  } catch (e) {
    if (epoch === turnEpoch) setError(errorMessage(e));
  } finally {
    if (epoch === turnEpoch) set({ busy: false });
  }
}

function stopButtonCapture() {
  buttonCapture?.abort();
  buttonCapture = undefined;
  recording = undefined;
  const stop = stopListening;
  stopListening = undefined;
  stop?.();
  set({ listening: false });
}

async function toggleMic() {
  const id = ui.sessionId;
  if (id === undefined || loop !== undefined) return;
  const previous = buttonCapture;
  if (previous !== undefined) {
    if (recording !== undefined) {
      const rec = recording;
      recording = undefined;
      set({ listening: false, busy: true });
      announce('인식 중입니다.');
      try {
        const audio = await rec.stop();
        if (previous.signal.aborted) return;
        void cue('done');
        const active = () => !previous.signal.aborted;
        const result = await withProgressCues(whileBusy(api.audioTurn(id, audio)), active);
        await applyResult(result, true, active);
      } catch (error) {
        if (!previous.signal.aborted) setError(errorMessage(error));
      } finally {
        if (buttonCapture === previous) {
          buttonCapture = undefined;
          set({ busy: false });
        }
      }
    } else if (stopListening !== undefined) {
      // 브라우저의 최종 받아쓰기 결과를 기다린다.
      stopListening();
    } else if (!ui.busy) {
      stopButtonCapture();
    }
    return;
  }
  if (ui.busy) return;
  const capture = new AbortController();
  buttonCapture = capture;
  stopSpeaking();
  set({ listening: true, error: undefined });
  try {
    await cue('listen', () => !capture.signal.aborted);
    if (capture.signal.aborted) return;
    if (ui.voiceMode.stt) {
      const rec = await startRecording(15000, capture.signal);
      if (capture.signal.aborted) { rec.cancel(); return; }
      recording = rec;
      announce('듣는 중입니다. 말씀을 마치면 버튼을 다시 누르세요.');
      return;
    }
    announce('듣는 중입니다. 말씀하세요.');
    stopListening = browserStt.listen(
      text => {
        if (capture.signal.aborted) return;
        void cue('done');
        void withProgressCues(send(text));
      },
      message => { if (!capture.signal.aborted) setError(message); },
      () => {
        if (buttonCapture !== capture) return;
        stopListening = undefined;
        buttonCapture = undefined;
        set({ listening: false });
      },
      partial => {
        if (capture.signal.aborted) return;
        const text = partial.trim();
        if (/(멈춰|멈추|멈춤|중지|중단|그만|정지|스톱)/.test(text) && !/(취소\s*(하지|안)|멈추지\s*마)/.test(text)) {
          stopSpeaking();
          void api.cancel(id).catch(() => undefined);
        }
      },
    );
  } catch {
    if (buttonCapture !== capture) return;
    stopButtonCapture();
    setError('마이크를 사용할 수 없습니다. 브라우저 마이크 권한을 확인하거나 텍스트로 입력하세요.');
  }
}
export function toggleTts() { if (ui.tts) stopSpeaking(); set({tts: !ui.tts}); }
export function toggleContrast() { set({contrast: !ui.contrast}); }
export function soundCheck() { set({error: undefined}); speak('소리 확인입니다. 이 목소리가 들리면 음성 안내가 정상입니다.'); }
export function selectMic(id: string) {
  set({micId: id});
  try { localStorage.setItem('cheongeum.micId', id); } catch { /* 이번 대화에만 적용 */ }
  if (loop !== undefined) endConversation();
}
export async function selectLanguage(lang: Lang) {
  if (ui.sessionId === undefined) return;
  set({ pendingLang: lang });
  // 그 사이 다른 언어를 골랐으면 그 선택을 화면에 남긴다.
  const settle = () => { if (ui.pendingLang === lang) set({ pendingLang: undefined }); };
  try {
    const r = await api.language(ui.sessionId, lang);
    settle();
    await applyResult(r, loop === undefined);
    if (loop !== undefined) await speakAndWait(r.speech);
  } catch (error) {
    settle();
    setError(errorMessage(error));
  }
}
function bind() {
  // 데스크톱 앱: 전역 단축키(Cmd/Ctrl+Shift+Space)로 '지금 말하기'
  desktop?.onTalk(() => talkNow());

  // 스페이스: 캡처 단계에서 가로채 포커스된 버튼(예: 대화 끝내기)이 눌리지 않게 한다. 글 입력 중에는 제외.
  window.addEventListener(
    'keydown',
    (e) => {
      const t = e.target;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
      if (e.code !== 'Space' || typing || loop === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) talkNow();
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (e.code === 'Space' && loop !== undefined && !(e.target instanceof HTMLInputElement)) e.preventDefault();
    },
    true,
  );
  // 동의 안내 중 Esc = 동의하지 않음
  window.addEventListener('keydown', (e) => {
    if (ui.consent === 'ask' && e.key === 'Escape') {
      e.preventDefault();
      void answerConsent(false);
    }
  });
  // 첫 클릭·키 입력 때 소리 채널을 잠금 해제(자동재생 정책).
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);
  // 새로고침·탭 닫기 때 이 세션의 브라우저 창을 닫는다.
  window.addEventListener('pagehide', () => {
    turnEpoch++;
    endConversation(false);
    stopButtonCapture();
    stopSpeaking();
    clearInterval(reminderTimer);
    if (ui.sessionId !== undefined) api.close(ui.sessionId);
  });
}

let starting: Promise<void> | undefined;
function start() { return starting ??= initialize(); }

async function initialize() {
  bind();
  push({ role: 'system', text: '모의 브라우저 창을 준비하는 중입니다…' });
  healthReady = api
    .health()
    .then((h) => {
      set({
        voiceMode: {
          stt: h.stt.supported,
          tts: h.tts.supported,
          label: `인식: ${h.stt.supported ? h.stt.provider : '브라우저'} · 안내: ${h.tts.supported ? h.tts.provider : '브라우저'}`,
          localLanguages: h.stt.localLanguages ?? [],
          llmRoles: h.llmRoles ?? {},
        },
        ...(h.tts.supported ? { tts: true } : {}),
      });
    })
    .catch(() => undefined);
  try {
    const s = await api.createSession();
    if (s.speechPrefs) applySpeechPrefs(s.speechPrefs);
    set({ sessionId: s.sessionId, state: s.state });
    push({
      role: 'system',
      text: s.consentRequired
        ? "시작 전에 안내를 듣고 동의해 주세요. '안내 듣고 시작하기' 버튼이 선택되어 있습니다. Enter를 누르세요."
        : `준비되었습니다. (의도 분석: ${s.llmProvider}) '대화 시작'을 누르거나 Enter를 누르면 음성으로 대화합니다.`,
    });
    setConsent(s.consentRequired ? 'intro' : 'granted');
    // 데스크톱 앱: 켜자마자 동의 안내를 읽는다(버튼을 찾을 필요 없음). Enter=동의, Esc=거부.
    if (desktop && s.consentRequired) void hearConsent();
  } catch (e) {
    setError(`세션을 시작하지 못했습니다: ${errorMessage(e)} — 청음 서버가 실행 중인지 확인하세요.`);
  }
}


export {
  answerConsent, confirm, consentText, endConversation, EXAMPLES, hearConsent,
  PHASE_LABELS, send, start, startConversation, stopAll, stopSpeaking, talkNow,
  toggleMic, UNSUPPORTED, voiceHelp,
};
