// 청음 웹 UI(빌드 없는 바닐라 JS). 화면 골격은 index.html에 있고, 여기서는 상태를 바꾸고 해당 부분만 다시 그린다.
// 입력란·버튼은 다시 만들지 않으므로 포커스가 유지된다(화면낭독기 사용자를 위해).
import { api } from './api.js';
import { syncWorkspace } from './workflows.js';
import { LiveConversation } from './voice-edge.js';
import { localizeWorkspace, workspaceText } from './workspace-language.js';
import profile from './voice-profile.json' with { type: 'json' };
import { getSpeechLang, setSpeechLang, unlockAudio } from './audio.js';
import { APPROVE_LABELS, currentDecision, desktopView, turnNotice } from './companion.js';
import { fullGuide, localizePanel, localizeSettings } from './onboarding.js';
import { createFirstRun } from './first-run.js';
import { renderRecordingReview } from './recording-review.js';
import { listMicrophones, preferredMicrophone, startRecording, VoiceLoop } from './mic.js';
import { applySpeechPrefs, speechPrefs, earcon, onSpeaking, preloadCues, progressVoice, serverTts, withPrivateReadback, takeInterruptedSpeech, transitionCue } from './speaker.js';

const STATE_LABELS_KO = {
  AWAITING_CONSENT: '동의 대기',
  IDLE: '대기',
  LISTENING: '듣는 중',
  TRANSCRIBED: '전사 완료',
  INTENT_DETECTED: '의도 파악',
  OBSERVING: '화면 확인 중',
  PLANNING: '계획 중',
  POLICY_CHECK: '안전 확인 중',
  EXECUTING: '실행 중',
  VERIFYING: '결과 확인 중',
  SPEAKING: '안내 중',
  APPLICATION_OPEN: '신청서 작성 중',
  BROWSING: '웹 페이지 읽는 중(읽기 전용)',
  NEEDS_CLARIFICATION: '확인 필요',
  AWAITING_FIELD_VALUE: '새 값 기다리는 중',
  VALIDATION_ERROR: '입력 오류',
  WAITING_FOR_USER_CONFIRMATION: '승인 대기',
  AUTH_HANDOFF: '직접 인증 필요',
  RECOVERING: '오류 복구 중',
  PAUSED: '일시정지',
  STOPPED: '중단됨',
  MOCK_SUBMITTED: '모의접수 완료',
  DONE: '완료',
};

const EXAMPLES = [
  '장애인연금 신청 도와줘',
  '이름은 김하늘',
  '주소는 부산광역시 예시구 예시로 10',
  '주소 다시 읽어줘',
  '다음으로',
  '이 항목은 무슨 뜻이야?',
  '화면 설명해줘',
  '복지로 열어줘',
  '정부24에서 주민등록등본 발급 방법 찾아줘',
  '장학재단에서 국가장학금 신청 기간 알려줘',
  '국민신문고 열어줘',
  '본문 읽어줘',
  '링크 목록 알려줘',
  '장애인연금 얼마 받아?',
  '지금까지 쓴 내용 읽어줘',
  '모의 접수 내용을 확인했어',
];

const BACKGROUND = new URLSearchParams(location.search).get('background') === '1';

function voiceRouteText() {
  if (!ui.voiceMode.known) return '음성 설정을 확인하고 있어요.';
  if (!ui.voiceMode.stt && !ui.voiceMode.tts) return dictationHelp();
  return '음성 입력과 안내 문장은 음성 API로 전송됩니다. 청음은 녹음을 저장하지 않습니다.' +
    (ui.voiceMode.edge ? ' 실시간 음성 대화를 시작할 때는 감지된 개인정보를 가린 최근 대화 일부도 OpenAI로 보냅니다.' : '');
}

function dictationHelp() {
  return workspaceText('음성 입력과 안내를 쓰려면 이용 설정에 OpenAI API 키를 등록해 주세요. 글로도 질문할 수 있어요.', ui.lang);
}

/** 역할별 LLM이 어디로 가는지(/api/health.llmRoles). rules·mock은 밖으로 안 나감. */
function llmRouteText(roles = {}) {
  if (!ui.voiceMode.known) return '질문과 화면에서 읽은 글은 이해와 요약을 위해 외부 인공지능 서비스로 전송될 수 있습니다.';
  const label = { understand: '말씀 이해', goal: '목표 수행', web: '화면·검색 요약' };
  const external = Object.entries(roles)
    .filter(([k, v]) => label[k] && v && !/^(rules|mock)/i.test(String(v)))
    .map(([k, v]) => `${label[k]}은 ${v}`);
  if (!external.length) return '글 이해는 이 컴퓨터의 규칙으로만 처리합니다.';
  return `글 이해에 쓰는 인공지능은 역할마다 다를 수 있어요. ${external.join(', ')}.`;
}

/** 시작 동의 안내: 무엇을 하는지, 무엇이 외부로 나가는지, 무엇을 하지 않는지, 어떻게 멈추는지 */
function consentText(lang = ui.lang) {
  const translated = fullGuide(lang, ui.voiceMode, BACKGROUND, /Mac/.test(navigator.platform) ? 'Command' : 'Control');
  if (translated) return translated;
  return (
    '공공서비스 음성 도우미 청음입니다. ' +
    '동의하시면 청음은 별도의 브라우저 창에서 웹사이트를 열고 화면을 읽어 드립니다. 연습용 신청서 작성도 도와드려요. ' +
    '승인이 필요한 입력이나 클릭은 실행 전에 대상과 내용을 알려 드립니다. 실제 접수와 본인 인증은 직접 하셔야 합니다. ' +
    (ui.voiceMode.llmRoles.vision === 'disabled'
      ? '이 설정에서는 웹페이지를 글로 읽어 드립니다. '
      : '화면 설명은 먼저 페이지 글을 확인합니다. 그림을 봐야 답할 수 있으면 현재 탭의 전체 페이지 사진도 본문, 최근 요청 일부와 함께 OpenAI에 보냅니다. 입력란과 내장 문서, 감지된 개인정보는 가립니다. 그림 속 개인정보는 남을 수 있습니다. 글로만 들으려면 “사진 없이 화면 설명해 줘”라고 하세요. ') +
    '받은 파일에 대해 질문하거나 요약을 요청하면 파일 전체나 본문을 OpenAI 파일 분석 서버에 보낼 수 있습니다. 파일마다 보낼 곳을 알려 드리고 동의를 받습니다. ' +
    `${voiceRouteText()} ${llmRouteText(ui.voiceMode.llmRoles)} 비밀번호나 주민등록번호는 말하지 마세요. ` +
    "언제든 '멈춰'라고 말하면 멈춥니다. " +
    (BACKGROUND
      ? `동의하시면 ${/Mac/.test(navigator.platform) ? '커맨드' : '컨트롤'}, 시프트, 스페이스 키를 함께 눌러 주세요. 동의하지 않으시면 메뉴 막대의 청음에서 종료를 고르세요.`
      : '동의하시면 Enter를, 동의하지 않으시면 Escape를 눌러 주세요.')
  );
}

// 서버 음성 설정을 받아 오기 전에는 동의 안내를 읽지 않는다(어디로 전송되는지가 바뀌므로)
let healthReady = Promise.resolve();

const GREETINGS = {
  ko: '무엇을 도와드릴까요? 띵 소리 뒤에 말씀하세요.',
  en: 'How can I help? Speak after the tone.',
  zh: '需要什么帮助？请在提示音后说话。',
  ja: 'どのようなお手伝いが必要ですか。合図のあとにお話しください。',
};

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

const $ = (id) => document.getElementById(id);
// 첫 실행 설정(키·이 PC·소리 확인·빠르기). 끝나면 동의 화면으로 넘어간다.
const firstRun = createFirstRun({
  desktop,
  speak: async (text, lang, rate) => {
    unlockAudio();
    const status = await serverTts.speak(text, (chunk, speed, signal) => api.speak(chunk, lang, speed, rate, signal), 0, rate, lang);
    if (status === 'blocked') throw new Error('PLAYBACK_BLOCKED');
    return status;
  },
  stopSpeaking: () => serverTts.cancel(),
  onSaved: () => refreshHealth(),
  onConsentReady: async () => {
    firstRun.finish();
    // '설정 다시 해줘'로 연 경우는 대화가 이미 있다: 저장한 설정은 서버가 열린 대화에 넘긴다
    if (ui.sessionId) announce('이용 설정을 저장했어요.');
    else await chooseSession();
  },
});

const readMicId = () => {
  try {
    return localStorage.getItem('cheongeum.micId') ?? undefined;
  } catch {
    return undefined;
  }
};

/** 화면 상태(바뀌면 render()로 해당 부분만 다시 그린다) */
const ui = {
  sessionId: undefined,
  state: 'IDLE',
  last: undefined,
  lang: 'ko',
  busy: false,
  hasTurn: false,
  practiceMode: false,
  listening: false,
  voiceMode: { known: false, stt: false, tts: false, label: '', llmRoles: {} },
  tts: false,
  contrast: false,
  error: undefined,
  phase: 'off',
  baseSpeed: profile.speed,
  consent: 'loading', // loading | intro | ask | granted | declined
  mics: [],
  micId: readMicId(),
};

// 긴 비동기 루프·녹음 상태(화면에는 직접 나오지 않음)
let conversationOn = false;
let loop;
let checkingMic = false;
let recording;
let openingMic = false;
let reminderTimer;
let reminderSeen;
let reminderNight = false;
let recoverable = false;
let recoveryChoice;
let heartbeatTimer;
let sessionGeneration = 0;
let stoppedGeneration = 0;
const RECOVERY_KEY = 'cheongeum.recovery';
const PROGRESS_KEY = 'cheongeum.progressSeq';

function tabStore(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    return null;
  }
}
let messageSeq = 0;
// 일하는 동안: 사용자가 말하는 중 / 청음이 짧은 안내(진행 상황)를 말하는 중
let userTalking = false;
let busyTalking = false;
/** 마이크 경로 신호음은 음성 안내 꺼짐과 관계없이 낸다. 결과·알림 신호음은 ui.tts를 따른다. */
const MIC_CUES = new Set(['start', 'listen', 'done', 'thinking', 'working', 'stopped', 'end']);
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
  card: undefined,
  // 청음 소개 중인 줄의 아바타 동작(없으면 null)
  introPose: null,
  consumed: new Set(),
  dropped: new Set(),
  sent: '',
  speaking: false,
  message: null,
  sleeping: false,
  wakeCount: 0,
  stopGeneration: null,
  stopping: null,
  waking: null,
};

function cue(kind) {
  if (!MIC_CUES.has(kind) && !ui.tts) return Promise.resolve();
  return earcon(kind);
}

function cueStopped() {
  stopCuedAt = Date.now();
  void cue('stopped');
}

function set(patch) {
  if (patch.busy === true || patch.phase === 'hearing' || patch.phase === 'thinking') desk.message = null;
  Object.assign(ui, patch);
  render();
}

function announce(text) {
  $('announce').textContent = text;
}

function setError(message) {
  set({ error: message });
}

function push(m) {
  const log = $('log');
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight <= 40;
  const li = document.createElement('li');
  li.className = `msg ${m.role}`;
  li.dataset.id = `${Date.now()}-${messageSeq++}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = workspaceText(m.role === 'user' ? '나' : m.role === 'assistant' ? '청음' : '안내', ui.lang) + ': ';
  if (m.summary) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.append(who, document.createTextNode(m.summary));
    const body = document.createElement('p');
    body.textContent = m.text;
    details.append(summary, body);
    li.append(details);
  } else {
    li.append(who, document.createTextNode(m.text));
  }
  log.append(li);
  if (follow) log.scrollTop = log.scrollHeight;
  return li;
}

function recordConsent(reply) {
  let record = $('consent-record');
  if (!record) {
    const row = push({ role: 'assistant', summary: workspaceText('시작 안내와 동의 기록', ui.lang), text: consentText() });
    record = row.querySelector('details');
    record.id = 'consent-record';
    if (ui.voiceMode.tts) {
      const replay = document.createElement('button');
      replay.type = 'button';
      replay.textContent = workspaceText('시작 안내 다시 듣기', ui.lang);
      replay.addEventListener('click', () => speak(consentText()));
      record.append(replay);
    }
  }
  if (reply) {
    const outcome = document.createElement('p');
    outcome.textContent = reply;
    record.append(outcome);
  }
}

// ---------------------------------------------------------------- 그리기

function show(id, visible) {
  $(id).hidden = !visible;
}

let springTiming;
/** 배치가 바뀐 요소를 바뀌기 전 자리(from: 화면 위쪽 좌표)에서 새 자리로 미끄러지게 한다. */
function glide(el, from) {
  if (from == null || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const dy = from - el.getBoundingClientRect().top;
  if (Math.abs(dy) < 2) return;
  springTiming ??= (() => {
    const [, ms, easing] = /^([\d.]+)ms\s+(.+)$/s.exec(getComputedStyle(document.documentElement).getPropertyValue('--spring').trim());
    return { duration: Number(ms), easing };
  })();
  el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], springTiming);
}

/** 대화 영역을 맨 아래에서 보고 있으면 새 메시지·카드가 붙어도 계속 맨 아래를 보여 준다. */
function followThread(thread) {
  let pinned = true;
  thread.addEventListener('scroll', () => {
    pinned = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 48;
  }, { passive: true });
  const keep = new ResizeObserver(() => { if (pinned) thread.scrollTop = thread.scrollHeight; });
  for (const child of thread.children) keep.observe(child);
}
/** 글 조각. class가 'words'면 화면에서는 숨기고(고대비에서는 보임) 화면 낭독기는 읽는다. */
function textSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function syncCard() {
  const decision = currentDecision(ui);
  const next = decision && !desk.dropped.has(decision.key) ? decision : undefined;
  if (next?.key === desk.card?.key && (!next || desk.card.lang === ui.lang)) return;
  desk.card = next && { ...next, lang: ui.lang, id: `${desk.instance}-${++desk.seq}` };
}

/** 데스크톱 앱이면 아바타 창에 표시 상태를 보낸다(바뀐 때만, 번호를 늘려 순서를 정한다). */
function publishDesktop() {
  if (!desktop?.publish) return;
  const view = desktopView(ui, {
    capture: conversationOn || recording || ui.listening || ui.phase === 'starting' ? 'on' : 'off',
    speaking: desk.speaking,
    recording: !!recording,
    message: desk.message,
    sleeping: desk.sleeping,
    introPose: desk.introPose,
    card: desk.card,
    pending: !!desk.card && desk.consumed.has(desk.card.id),
  });
  const text = JSON.stringify(view);
  if (text === desk.sent) return;
  desk.sent = text;
  desktop.publish({ instance: desk.instance, revision: ++desk.revision, ...view });
}

function renderPhase() {
  let phase = ui.phase;
  let label = workspaceText('음성 대화', ui.lang) + ': ' + workspaceText(PHASE_LABELS[phase], ui.lang);
  if (phase === 'off') {
    if (ui.listening) {
      phase = 'listening';
      label = '음성 입력: 듣고 있어요';
    } else if (desk.speaking) {
      phase = 'speaking';
      label = '음성 안내 중';
    } else if (ui.busy) {
      phase = 'thinking';
      label = '요청을 처리하고 있어요';
    }
  }
  const indicator = $('phase');
  const text = workspaceText(label, ui.lang);
  if (indicator.className !== `phase phase-${phase}`) indicator.className = `phase phase-${phase}`;
  if ($('phase-label').textContent !== text) $('phase-label').textContent = text;
}

function bindCardButtons(panelId, cardId, buttons, activate = choose) {
  const panel = $(panelId);
  if (panel.dataset.card === cardId) return;
  panel.dataset.card = cardId;
  // A held pointer or key belongs to the original rendered button, even if a new card replaces it.
  for (const [id, key] of buttons) {
    const previous = $(id);
    const button = previous.cloneNode(true);
    button.addEventListener('click', () => { if (button.isConnected) void activate(cardId, key); });
    previous.replaceWith(button);
  }
}

function render() {
  localizeWorkspace(ui.lang);
  syncWorkspace(ui.sessionId, ui.consent === 'granted' && ui.workspaceAvailable && !recoveryChoice, ui.lang);
  syncCard();
  renderRecordingReview(ui, Boolean(recoveryChoice));
  const { sessionId, state, last, busy, listening, voiceMode, tts, contrast, error, phase, consent, mics, micId, lang } = ui;
  const decision = desk.card;
  const decisionTaken = !!decision && desk.consumed.has(decision.id);
  $('app').className = contrast ? 'app high-contrast' : 'app';

  // 도구 막대
  const ttsBtn = $('tts-toggle');
  ttsBtn.setAttribute('aria-pressed', String(tts));
  ttsBtn.textContent = workspaceText(`음성 안내 ${tts ? '켜짐' : '꺼짐'}`, lang);
  ttsBtn.disabled = !voiceMode.tts;
  $('sound-check').disabled = !voiceMode.tts;
  $('consent-full').disabled = !voiceMode.tts;
  const contrastBtn = $('contrast-toggle');
  contrastBtn.setAttribute('aria-pressed', String(contrast));
  contrastBtn.textContent = workspaceText(`고대비 ${contrast ? '켜짐' : '꺼짐'}`, lang);

  // 동의 화면
  $('session-end').disabled = !sessionId;
  const signingIn = last?.authHandoff?.status === 'waiting';
  $('mic-check').disabled = checkingMic || !sessionId || consent !== 'granted' || signingIn || state === 'STOPPED';
  const consentShown = consent === 'intro' || consent === 'ask';
  const sessionReady = !!sessionId && !recoveryChoice && (consent === 'granted' || consent === 'declined');
  const stage = sessionReady ? (ui.hasTurn ? 'active' : 'ready') : 'onboarding';
  if ($('app').dataset.stage !== stage) {
    const layout = document.querySelector('.layout');
    const from = $('app').dataset.stage ? layout.getBoundingClientRect().top : null;
    $('app').dataset.stage = stage;
    show('welcome-panel', stage === 'ready');
    glide(layout, from);
  }
  show('practice-banner', ui.practiceMode);
  for (const button of $('starter-actions').querySelectorAll('button[data-request]')) {
    button.disabled = !sessionReady || busy;
    if (button.dataset.consent) button.hidden = button.dataset.consent !== consent;
  }
  show('consent-panel', consentShown);
  if (consentShown && $('consent-panel').lang !== ui.lang) {
    localizePanel($('consent-panel'), ui.lang);
    $('consent-text').textContent = consentText();
  }
  show('consent-hear', consent === 'intro');
  $('consent-hear').disabled = !sessionId;
  show('consent-yes', consent === 'ask');
  show('consent-no', consent === 'ask');

  // 대화 조절
  show('conv-start', phase === 'off');
  $('conv-start').disabled = !sessionId || consent !== 'granted' || signingIn || !voiceMode.stt;
  show('conv-end', phase !== 'off');
  renderPhase();
  show('conv-hint', phase !== 'off');
  $('conv-hint').textContent = workspaceText(edge ? '자연스럽게 말씀하세요. 답변 중에도 끼어들 수 있어요.' : '띵 소리 뒤에 말씀하세요. 스페이스 키나 박수 두 번으로 안내를 끊거나, 하던 말을 바로 보낼 수 있어요.', lang);
  show('mic-wrap', mics.length > 1);
  show('conversation-mode-wrap', !!voiceMode.edge);
  const modeLabels = ({
    ko: ['대화 방식', '말하는 중에도 끼어드는 실시간 대화', '한 번씩 받아쓰고 답변 듣기'],
    en: ['Voice mode', 'Talk live and interrupt anytime', 'Transcribe each turn and hear a reply'],
    ja: ['音声モード', '話の途中でも割り込めるリアルタイム会話', '発話ごとに文字起こしして応答'],
    zh: ['语音模式', '可随时打断的实时对话', '逐次转写并朗读回答'],
  })[lang] ?? ['Voice mode', 'Live conversation', 'Dictate and hear a reply'];
  $('conversation-mode-label').textContent = modeLabels[0];
  $('conversation-mode').options[0].textContent = modeLabels[1] + ' · ' + (voiceMode.edge ?? '');
  $('conversation-mode').options[1].textContent = modeLabels[2] + ' · gpt-live-transcribe';
  const micSelect = $('mic-select');
  if (micSelect.dataset.ids !== mics.map((m) => m.id).join('|')) {
    micSelect.replaceChildren(
      ...mics.map((m) => {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.label;
        return o;
      }),
    );
    micSelect.dataset.ids = mics.map((m) => m.id).join('|');
  }
  micSelect.value = micId ?? '';
  $('lang-select').value = lang;

  // 오류
  const errEl = $('error');
  errEl.hidden = !error;
  errEl.textContent = error ?? '';

  // 명령 입력
  $('command').disabled = !sessionId || !!recoveryChoice;
  const send = $('send');
  send.disabled = !sessionId || busy || !!recoveryChoice;
  send.setAttribute('aria-busy', String(busy));
  send.textContent = workspaceText(busy ? '처리 중…' : '보내기', lang);
  show('typing', busy && !!sessionId);
  const micBtn = $('mic-btn');
  show('mic-btn', phase === 'off');
  micBtn.setAttribute('aria-pressed', String(listening));
  micBtn.disabled = !sessionId || signingIn || consent !== 'granted' || (busy && !listening) || !voiceMode.stt;
  const dictationHint = $('dictation-hint');
  dictationHint.hidden = !sessionReady || consent !== 'granted' || voiceMode.stt;
  dictationHint.textContent = dictationHelp();
  micBtn.textContent = workspaceText(listening ? '말하기 끝 (보내기)' : '음성 입력', lang);
  const talkBtn = $('talk-btn');
  show('talk-btn', phase !== 'off');
  talkBtn.disabled = phase === 'starting' || phase === 'thinking';
  talkBtn.textContent = workspaceText(phase === 'speaking' ? '지금 말하기 (안내 끊기)' : phase === 'hearing' && !edge ? '말 끝 (바로 보내기)' : '듣는 중 — 말씀하세요', lang);
  $('command-help').textContent = workspaceText('비밀번호, 주민등록번호, 계좌번호는 입력하거나 말하지 마세요.', lang);
  $('voice-details').textContent = [voiceRouteText(), voiceMode.label, llmRouteText(voiceMode.llmRoles)].filter(Boolean).join(' ');
  for (const b of $('examples').querySelectorAll('button')) b.disabled = !sessionId || !!recoveryChoice || busy;

  // 현재 상태
  const obs = last?.observation;
  const step = obs?.step;
  const hasStep = Number.isFinite(step?.index) && Number.isFinite(step?.total) && step.total > 0;
  const progress = $('step-progress');
  progress.hidden = !hasStep;
  if (hasStep) {
    progress.max = step.total;
    progress.value = step.index;
    progress.style.setProperty('--p', String(step.index / step.total));
  }
  $('st-state').textContent = workspaceText(STATE_LABELS_KO[state] ?? state, lang);
  $('st-state').dataset.state = state;
  $('st-step').textContent = hasStep ? `${step.index}/${step.total} — ${step.name}` : '없음';
  $('st-title').textContent = obs?.title ?? '아직 열지 않음';
  $('st-access').textContent =
    last?.accessMode === 'full' ? '지원 사이트(연습 신청 가능)' : last?.accessMode === 'read-only' ? '읽기 전용(읽기·이동·검색만)' : '없음';
  $('st-access').dataset.mode = last?.accessMode ?? 'none';
  $('st-step').parentElement.hidden = !hasStep;
  $('st-title').parentElement.hidden = !obs?.title;
  $('st-access').parentElement.hidden = last?.accessMode !== 'full' && last?.accessMode !== 'read-only';
  const visibleFields = obs?.fields.filter((f) => f.visible && f.type !== 'checkbox') ?? [];
  show('fields-wrap', visibleFields.length > 0);
  $('fields').replaceChildren(
    ...visibleFields.map((f) => {
      // 화면에는 이름과 값만 보이고(상태는 아이콘), 화면 낭독기는 예전 문장 그대로 듣는다
      const li = document.createElement('li');
      li.append(
        textSpan('field-name', f.label),
        textSpan('words', ` ${f.required ? '(필수)' : ''} — ${!f.sensitive && f.filled ? '입력됨: ' : ''}`),
        textSpan('field-value', f.sensitive ? '직접 입력 항목' : f.filled ? f.value : '비어 있음'),
        textSpan('words', f.invalid ? ' · 오류' : ''),
      );
      li.dataset.state = f.invalid ? 'invalid' : f.sensitive ? 'private' : f.filled ? 'filled' : 'empty';
      return li;
    }),
  );

  // 승인 확인
  const pending = state === 'WAITING_FOR_USER_CONFIRMATION' ? last?.pendingConfirmation : undefined;
  show('confirm-panel', !!pending);
  if (pending) {
    $('confirm-yes').textContent = workspaceText(APPROVE_LABELS[pending.kind] ?? '이 동작 승인', lang);
    show('confirm-edit', pending.kind === 'practice-submission');
    show('confirm-hint', !!pending.description);
    $('confirm-hint').textContent = pending.description ?? '';
    $('confirm-purpose').textContent = pending.purpose;
    $('confirm-site').textContent = pending.site;
    $('confirm-values').replaceChildren(
      ...pending.values.map((v) => {
        const div = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = v.label;
        const dd = document.createElement('dd');
        dd.textContent = v.value;
        div.append(dt, dd);
        return div;
      }),
    );
  }
  bindCardButtons('confirm-panel', decision?.kind === 'approval' ? decision.id : '',
    [['confirm-yes', 'approve'], ['confirm-no', 'reject']]);
  $('confirm-yes').disabled = busy || decisionTaken;
  $('confirm-no').disabled = busy || decisionTaken;

  show('auth-panel', signingIn);
  const authCard = decision?.kind === 'offer' && decision.ref.handoffId ? decision : undefined;
  bindCardButtons('auth-panel', authCard?.id ?? (signingIn ? last.turnId : ''),
    [['auth-done', 'auth-done'], ['auth-cancel', 'auth-cancel']], (cardId, key) =>
      authCard ? choose(cardId, key) : send(key === 'auth-done' ? '다 했어' : '인증 취소'));
  $('auth-done').textContent = authCard?.choices.find((c) => c.key === 'auth-done')?.label ?? '직접 확인을 마쳤어요';
  $('auth-done').disabled = busy || decisionTaken;
  $('auth-cancel').disabled = busy || decisionTaken;
  const receipt = state === 'MOCK_SUBMITTED' ? last?.verification?.receipt : undefined;
  show('result-panel', !!receipt);
  $('receipt').textContent = receipt ?? '';

  const card = last?.answerCard;
  show('answer-panel', !!card);
  if (card) {
    $('answer-text').textContent = card.answer;
    $('answer-text').lang = last.lang ?? lang;
    $('answer-source').href = card.source.url;
    $('answer-source').textContent = card.source.title;
    $('answer-origin').textContent = card.dataOrigin === 'fixture'
      ? '연습용 예시 · 저장된 자료'
      : { live: '공식 API 실시간 조회', stored: '저장된 자료', 'private-program': '공공데이터에 실린 민간 사업' }[card.dataKind];
    $('answer-date').textContent = card.dataDate ?? '자료에 기준일 없음';
    $('answer-checked').textContent = card.source.lastCheckedAt;
    $('answer-next').textContent = card.nextAction;
    $('answer-next').lang = last.lang ?? lang;
  }
  const sources = (last?.sources ?? []).filter((source) => source.url !== card?.source.url);
  show('sources-panel', sources.length > 0);
  $('sources').replaceChildren(
    ...sources.map((s) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = s.title;
      li.append(a, document.createTextNode(` (확인일 ${s.lastCheckedAt}${s.note ? `, ${s.note}` : ''})`));
      return li;
    }),
  );

  const actions = last?.actions ?? [];
  show('actions-panel', actions.length > 0);
  $('actions').replaceChildren(
    ...actions.map((a) => {
      const li = document.createElement('li');
      const ok = a.policy.allowed && a.result?.ok;
      li.append(
        textSpan('action-reason', a.action.reason),
        textSpan('words', ' — '),
        textSpan(ok ? 'words' : 'action-result', a.policy.allowed ? (ok ? '성공' : `실패(${a.result?.errorCode ?? '미실행'})`) : `차단: ${a.policy.reason}`),
      );
      li.dataset.result = !a.policy.allowed ? 'blocked' : ok ? 'ok' : 'failed';
      return li;
    }),
  );
  publishDesktop();
}

function setPhase(p) {
  if (ui.phase !== p) set({ phase: p });
}

function desktopNotice(text) {
  return text ? { id: `m-${++desk.seq}`, text } : null;
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
  if (desk.stopping) await desk.stopping;
  if (!sid || sid !== ui.sessionId || stop !== stoppedGeneration) return false;
  const generation = desk.stopGeneration;
  if (generation == null) return true;
  if (desk.waking?.generation === generation && desk.waking.sid === sid) return desk.waking.promise;
  const current = () => sid === ui.sessionId && stop === stoppedGeneration && generation === desk.stopGeneration;
  const promise = api.wake(sid, generation).then(({ state }) => {
    if (!current()) return false;
    desk.stopGeneration = null;
    set({ state });
    return true;
  }).catch(error => {
    if (current()) {
      desk.sleeping = true;
      setError(error.message);
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

async function applyResult(r, speakIt = true, sleepOnStop = true) {
  const apply = () => applyTurnResult(r, speakIt, sleepOnStop);
  return r.localSpeechOnly === true ? withPrivateReadback(apply) : apply();
}

async function applyTurnResult(r, speakIt, sleepOnStop) {
  const prevTurn = ui.last?.turnId;
  if (!ui.sessionId || r.sessionId !== ui.sessionId || prevTurn === r.turnId) return;
  if (r.intentType === 'READ_START_GUIDE') r.speech = consentText(r.lang);
  if (r.intentType === 'SETUP_RESTART') {
    // 처음 설정 화면이 녹음한 문장을 틀므로 응답은 말하지 않는다
    speakIt = false;
    endConversation(false);
    void firstRun.start(1);
  }
  const prevState = ui.state;
  const stopped = r.intentType === 'STOP' || r.semanticAction === 'stop';
  const wake = desk.wakeCount;
  if (r.state === 'STOPPED' && Number.isInteger(r.stopGeneration)) desk.stopGeneration = r.stopGeneration;
  else if (r.state !== 'STOPPED') desk.stopGeneration = null;
  if (stopped && sleepOnStop) {
    desk.sleeping = true;
    if (conversationOn || startingLoop) endConversation(false);
  } else if (r.state !== 'STOPPED') {
    desk.sleeping = false;
  }
  let confirmationRestart;
  if (r.pendingConfirmation && edge) {
    endConversation(false);
    confirmationRestart = conversationStarts;
  }
  if (r.authHandoff?.status === 'waiting') {
    endConversation(false);
    recording?.cancel();
    recording = undefined;
    set({ listening: false });
  }
  setSpeechLang(r.lang);
  if (r.speechPrefs) applySpeechPrefs(r.speechPrefs);
  edge?.setLanguage(r.lang, Math.min(4, Math.max(0.25, ui.baseSpeed * speechPrefs.rate / profile.normalRate)));
  // 새 응답: 남아 있는 결정이어도 새 카드 번호로(이전 화면에서 누른 버튼은 무효)
  desk.card = undefined;
  desk.dropped.clear();
  desk.message = desktopNotice(turnNotice(r));
  const isConsent = r.intentType === 'CONSENT' || r.semanticAction === 'consent';
  const hasTurn = ui.hasTurn || (!isConsent && r.semanticAction !== 'set-language');
  set({ last: r, state: r.state, lang: r.lang ?? 'ko', hasTurn });
  if (isConsent) {
    recordConsent(ui.consent === 'granted' ? r.speech : undefined);
    if (ui.consent !== 'granted') push({ role: 'assistant', text: r.speech });
  } else {
    push({ role: 'user', text: r.userUtterance });
    push({ role: 'assistant', text: r.speech });
  }
  announce(workspaceText('상태', ui.lang) + ': ' + workspaceText(STATE_LABELS_KO[r.state] ?? r.state, ui.lang));
  const kind = stopped && !sleepOnStop ? null : transitionCue(prevState, r.state);
  if (kind && !(kind === 'stopped' && Date.now() - stopCuedAt < STOP_CUE_WINDOW_MS)) await cue(kind);
  if (r.turnId !== ui.last?.turnId || (stopped && wake !== desk.wakeCount)) return;
  if (r.introScript?.length && speakIt) {
    void playIntro(r);
  } else if (confirmationRestart !== undefined) {
    await speakTurn(r);
    if (confirmationRestart === conversationStarts && r.turnId === ui.last?.turnId) void startConversation();
  } else if (ui.tts && speakIt) {
    // 본인인증 인계: 안내 한 번만 말하고 TTS를 멈춰 화면 낭독기가 입력 칸을 읽게 한다
    if (r.state === 'AUTH_HANDOFF') void speakTurn(r).then(() => stopSpeaking());
    else void speakTurn(r);
  }
  if (r.state === 'WAITING_FOR_USER_CONFIRMATION' && r.turnId === ui.last?.turnId) {
    $('confirm-title').focus();
    // 제목만 보이는 자리에 멈추지 않게 카드 끝(승인 버튼)까지 보인다
    $('confirm-panel').scrollIntoView({ block: 'end' });
  }
}

function speak(text) {
  void speakAndWaitFrom(text);
}

// 청음 소개: 줄마다 카드(정지 그림·글)를 보이고 아바타에 그 동작을 보낸 뒤 말한다.
// Esc·건너뛰기는 남은 줄을 넘기되, 묻는 줄(ask: 연습 신청서 제안)은 말한다.
const INTRO_STILL = { welcome: 'ready' };
let introRun = 0;
let introSkipped = false;

async function playIntro(result) {
  const run = ++introRun;
  introSkipped = false;
  show('intro-card', true);
  try {
    for (const line of result.introScript) {
      if (run !== introRun) return;
      if (introSkipped && !line.ask) continue;
      $('intro-text').textContent = line.text;
      $('intro-pose').src = `/avatar/poses/${INTRO_STILL[line.pose] ?? line.pose}.webp`;
      desk.introPose = line.ask ? null : line.pose;
      publishDesktop();
      if (ui.tts && ui.voiceMode.tts) await speakTurn(result, line.text);
      else await new Promise((done) => setTimeout(done, 2500));
    }
  } finally {
    if (run === introRun) {
      desk.introPose = null;
      show('intro-card', false);
      publishDesktop();
    }
  }
}

function skipIntro() {
  if ($('intro-card').hidden) return false;
  introSkipped = true;
  stopSpeaking();
  return true;
}

function stopSpeaking() {
  serverTts.cancel();
  if (edge && ui.phase === 'speaking') edge.interrupt();
}

async function speakAndWaitFrom(text, fromChunk = 0, rate = speechPrefs.rate) {
  if (!ui.tts || !ui.voiceMode.tts) return;
  try {
    const lang = getSpeechLang();
    const result = await serverTts.speak(text, (chunk, speed, signal) => api.speak(chunk, lang, speed, undefined, signal), fromChunk, rate, lang);
    if (result === 'blocked') setError('소리를 재생하려면 화면을 한 번 누른 뒤 소리 확인을 선택해 주세요.');
  } catch (error) {
    if (error.code === 'VOICE_KEY' || error.code === 'VOICE_QUOTA') desktop?.showSetup?.();
    setError(error.code ? error.message : '음성 API 안내를 재생하지 못했어요. 연결을 확인해 주세요. 안내는 화면에서도 읽을 수 있어요.');
  }
}

const speakAndWait = (text) => speakAndWaitFrom(text);

async function speakTurn(result, text = result.speech) {
  if (!result.localSpeechOnly) return speakAndWait(text);
  const lang = result.lang ?? ui.lang;
  const decision = currentDecision(ui);
  const cue = workspaceText('개인정보가 있는 안내를 대화 기록에 표시했어요. 화면 낭독기로 내용을 들을 수 있어요.', lang);
  const purpose = result.authHandoff?.status === 'waiting' ? workspaceText('마이크를 껐어요. 사이트에서 직접 로그인이나 본인 확인을 마쳐 주세요.', lang)
    : decision?.kind === 'approval' ? decision.prompt : '';
  return withPrivateReadback(() => speakAndWait([purpose, cue].filter(Boolean).join(' ')));
}

const THINKING_DELAY_MS = 1000;
const WORKING_START_MS = 3000;
const WORKING_EVERY_MS = 2500;

/** work가 끝날 때까지만 생각중·일하는중 신호음을 낸다. 답을 말하기 전에 그치고, 일하는 중에 안내를 말하는 동안은 건너뛴다. */
async function withProgressCues(work) {
  const tick = (kind) => {
    if (!busyTalking) void cue(kind);
  };
  let intervalId;
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

// 대화 시작 번호: 끝내기(인증 인계·멈춤·종료)가 늘려, 마이크를 여는 사이에 끝내라는 요청이 오면 시작을 그만둔다
let conversationStarts = 0;
let startingLoop;
let edge;

function endConversation(withCue = true) {
  conversationStarts += 1;
  startingLoop?.stop();
  startingLoop = undefined;
  edge?.stop();
  edge = undefined;
  $('live-caption').hidden = true;
  $('live-caption').textContent = '';
  if (withCue && conversationOn) void cue('end');
  conversationOn = false;
  loop?.stop();
  loop = undefined;
  setPhase('off');
}

/**
 * 핸즈프리 대화: 인사 → (듣기 → 서버로 보내 받아쓰기·실행 → 답 말하기) 반복.
 * 브라우저 정책상 마이크·소리는 사용자 동작이 한 번 필요해서 '대화 시작' 버튼으로 시작한다.
 */
async function startConversation() {
  if (conversationOn || startingLoop || !ui.sessionId) return;
  unlockAudio();
  const ticket = ++conversationStarts;
  if (!await readyForInput() || ticket !== conversationStarts || ui.last?.authHandoff?.status === 'waiting') return;
  if (!ui.voiceMode.stt) {
    const fallback = `지금은 연속 음성 대화를 사용할 수 없어요. ${dictationHelp()}`;
    setError(fallback);
    if (ui.tts) speak(fallback);
    return;
  }
  if (ui.consent !== 'granted') {
    setError('동의하지 않으셔서 음성 대화를 시작하지 않습니다. 복지 제도 질문은 텍스트로 입력할 수 있습니다.');
    return;
  }
  void preloadCues();
  set({ error: undefined });
  setPhase('starting');
  const sessionId = ui.sessionId;
  if (ui.voiceMode.edge && $('conversation-mode').value === 'native') {
    const caption = $('live-caption');
    let captionEnd = -1;
    const approvalId = ui.last?.pendingConfirmation?.actionId ?? '';
    const current = new LiveConversation(sessionId, {
      offer: (socket, sdp) => api.voiceOffer(socket, sdp, approvalId), phase: setPhase, notice: setError,
      caption(event) {
        if (ticket !== conversationStarts || !event.delta) return;
        caption.hidden = false;
        const previous = event.start_ms - captionEnd > 1100 ? '' : caption.textContent;
        caption.textContent = (previous + event.delta).slice(-550);
        captionEnd = event.end_ms;
      },
      async result(result, exact) {
        if (ticket !== conversationStarts) return;
        if (result.lang) current.language = result.lang;
        if (result.state === 'STOPPED' || result.state === 'AUTH_HANDOFF') {
          endConversation(false);
          await applyResult(result, true);
          return;
        }
        if (result.pendingConfirmation) {
          await applyResult(result, false);
          return;
        }
        if (exact) {
          current.paused = true;
          current.updateAudio();
        }
        try {
          await applyResult(result, false);
          if (exact && ticket === conversationStarts) await speakTurn(result);
        } finally {
          if (ticket === conversationStarts) {
            current.paused = false;
            current.updateAudio();
            setPhase('listening');
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
      setPhase('listening');
      await cue('start');
    } catch (error) {
      current.fail(error.message);
    }
    return;
  }
  const current = new VoiceLoop(() => api.liveAudio(sessionId));
  current.ignore = () => desk.speaking;
  startingLoop = current;
  const micTrouble =
    '마이크 연결이 끊겼거나 소리가 들어오지 않습니다. 아이폰 등 다른 기기 마이크가 선택돼 있을 수 있어요. 아래 마이크 선택에서 이 컴퓨터의 마이크를 고른 뒤 대화를 다시 시작해 주세요.';
  try {
    // 저장된 마이크가 없으면 권한을 받은 뒤 내장 마이크를 골라 다시 연다(아이폰 연속성 마이크 회피).
    await current.start(ui.micId);
    const list = await listMicrophones().catch(() => []);
    set({ mics: list });
    const preferred = ui.micId ?? preferredMicrophone(list);
    if (!ui.micId && preferred && list.length > 1) {
      if (ticket !== conversationStarts) throw new Error('stopped');
      current.stop();
      await current.start(preferred);
      set({ micId: preferred });
    }
    if (await current.isSilent()) throw new Error('silent');
  } catch {
    current.stop();
    if (ticket !== conversationStarts) return;
    startingLoop = undefined;
    setPhase('off');
    setError(micTrouble);
    announce(micTrouble);
    void cue('problem').then(() => speakAndWait(micTrouble));
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
    if (reason === 'ended') {
      endConversation(false);
      void cue('problem').then(() => speakAndWait(micTrouble));
    }
  };
  void current.startClapDetector(() => talkNow(), ui.micId);
  loop = current;
  conversationOn = true;
  setPhase('speaking');
  await cue('start');
  const greeting = GREETINGS[ui.lang] ?? GREETINGS.ko;
  push({ role: 'assistant', text: greeting });
  await speakAndWait(greeting);

  let failures = 0;
  let missed = 0;
  while (loop === current && conversationOn) {
    setPhase('listening');
    announce('듣고 있습니다. 말씀하세요.');
    await cue('listen');
    // 승인은 듣기 시작할 때 있던 결정에만 묶는다(듣는 사이에 새로 뜬 승인을 '응'으로 하지 않게)
    const asked = ui.last?.pendingConfirmation?.actionId ?? '';
    const audio = await current.listenOnce(() => setPhase('hearing'));
    if (!audio || loop !== current) { audio?.cancel?.(); break; }
    void cue('done');
    setPhase('thinking');
    try {
      const r = await voiceTurn(audio, asked, current);
      if (loop !== current) break;
      failures = 0;
      missed = 0;
      await applyResult(r, r.state === 'STOPPED');
      if (loop !== current) break;
      setPhase('speaking');
      // 끼어들기: 안내 중에 사용자가 말하면 안내를 멈추고 바로 듣는다.
      // 2초 안에 말이 없으면 거짓 끼어들기로 보고 멈춘 안내를 이어 말한다.
      let barged = false;
      const stopWatch = current.watchBargeIn(() => {
        barged = true;
        stopSpeaking();
        announce('말씀을 들을게요.');
      });
      await speakTurn(r);
      stopWatch();
      if (barged && conversationOn) {
        const interrupted = takeInterruptedSpeech();
        setPhase('listening');
        const bargeAsked = ui.last?.pendingConfirmation?.actionId ?? '';
        const clip = await current.listenAfterBarge(2000, () => setPhase('hearing'));
        if (!clip) {
          if (interrupted?.kind === 'server' && interrupted.text) {
            setPhase('speaking');
            await speakAndWaitFrom(interrupted.text, interrupted.fromChunk || 0);
          }
          continue;
        }
        void cue('done');
        setPhase('thinking');
        try {
          const again = await voiceTurn(clip, bargeAsked, current);
          if (loop !== current) break;
          await applyResult(again, again.state === 'STOPPED');
          if (loop !== current) break;
          setPhase('speaking');
          await speakTurn(again);
        } catch (be) {
          if (interrupted?.kind === 'server' && interrupted.text && be.code === 'EMPTY_TRANSCRIPT') {
            setPhase('speaking');
            await speakAndWaitFrom(interrupted.text, interrupted.fromChunk || 0);
          } else {
            throw be;
          }
        }
      }
    } catch (e) {
      if (loop !== current) break;
      const message = e.message;
      if (e.code === 'EMPTY_TRANSCRIPT') {
        setPhase('speaking');
        await cue('problem');
        if (++missed >= 2) {
          await speakAndWait('마이크에서 말씀을 구분하기 어려워 듣기를 잠시 멈췄어요. 준비되면 대화 시작을 눌러 주세요.');
          break;
        }
        await speakAndWait(message);
        continue;
      }
      setError(message);
      if (++failures >= 3) {
        await cue('problem');
        await speakAndWait('문제가 계속되어 대화 모드를 끝냅니다. 텍스트로 입력해 주세요.');
        break;
      }
    }
    // 스피커 소리 잔향이 마이크로 들어가지 않게 잠깐 쉰다.
    await new Promise((r) => setTimeout(r, 300));
  }
  if (loop === current) endConversation();
}

/** 대화 모드의 음성 한 턴. 보내는 동안 떠 있는 카드를 잡아 버튼과 말이 함께 나가지 않게 한다. */
async function voiceTurn(audio, asked, voice) {
  const held = holdCard();
  try {
    return await withProgressCues(whileBusy(api.audioTurn(ui.sessionId, audio, asked), voice));
  } finally {
    releaseCard(held);
  }
}

const PROGRESS_POLL_MS = 2000;

/** 서버가 일하는 동안(work가 끝날 때까지): 목표 수행의 새 단계를 말하고, 대화 모드(voice)면 '멈춰'와 '지금 어디까지 했어?'를 듣는다. */
async function whileBusy(work, voice) {
  const stops = [watchProgress(voice), ...(voice ? [listenForStopWhileBusy(voice)] : [])];
  try {
    return await work;
  } finally {
    for (const stop of stops) stop();
  }
}

/** 몇 초마다 진행 상황을 물어, 말할 단계가 있으면 한 문장 말한다(간격과 조용히 할 때는 progressVoice가 정함). 반환값을 부르면 그친다. */
function watchProgress(voice) {
  let on = true;
  progressVoice.start();
  const timer = setInterval(async () => {
    const p = await api.progress(ui.sessionId).catch(() => undefined);
    if (recoverable && p?.seq != null) tabStore(PROGRESS_KEY, String(p.seq));
    // 묻는 사이에 일이 끝났으면 말하지 않는다(답을 끊지 않게)
    const text = on && p && progressVoice.pick(p, userTalking || busyTalking);
    if (!text) return;
    push({ role: 'assistant', text });
    announce(text);
    void sayWhileBusy({ speech: text }, voice);
  }, PROGRESS_POLL_MS);
  return () => {
    on = false;
    clearInterval(timer);
  };
}

/** 일하는 동안 짧게 말한다. 그동안은 멈춤 듣기를 쉰다(안내 소리를 받아쓰지 않게). */
async function sayWhileBusy(result, voice) {
  busyTalking = true;
  voice?.cancelListening();
  await speakTurn(result);
  busyTalking = false;
}

/**
 * 일하는 동안에도 '멈춰'와 '지금 어디까지 했어?'는 듣는다. 서버가 그 둘만 실행하고(진행 물음은 답을 말한다) 나머지는 버린다.
 * 반환값을 부르면 듣기를 그친다.
 */
function listenForStopWhileBusy(voice) {
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
      if (!clip && busyTalking && on) continue;
      if (!clip || !on) { clip?.cancel?.(); break; }
      try {
        const r = await api.audioStop(ui.sessionId, clip);
        if (loop !== voice) break;
        if (r.stopped) {
          cueStopped();
          announce('멈출게요.');
          await applyResult(r.result);
          break;
        } else if (on && r.result) {
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
function talkNow() {
  if ($('settings-dialog').open) return;
  // 백그라운드 데스크톱 앱: 창이 없어 Enter를 누를 수 없으므로 동의 안내 중의 단축키 = 동의
  if (ui.consent === 'intro') return void hearConsent();
  if (ui.consent === 'ask') return void answerConsent(true);
  if (!conversationOn && ui.last?.authHandoff?.status === 'waiting') {
    // 인증 중에는 마이크를 켜지 않는다(비밀번호를 듣지 않게). 조용히 무시하지 않고 다음에 할 일을 알린다.
    const label = desk.card?.choices.find((c) => c.key === 'auth-done')?.label ?? '로그인했어요';
    notice(`지금은 사이트에서 직접 로그인하는 중이라 마이크를 꺼 두었어요. 마치면 컨트롤, 시프트, K를 누르고 '${label}'를 고르세요.`);
    return;
  }
  if (!conversationOn) {
    if (ui.consent === 'granted') void startConversation();
    return;
  }
  if (edge && ui.phase === 'thinking') return void stopAll();
  if (ui.phase === 'speaking') {
    stopSpeaking();
    announce('안내를 멈췄습니다. 말씀하세요.');
  } else if (ui.phase === 'hearing') {
    loop?.endUtterance();
  } else if (ui.phase === 'thinking') {
    // 창이 없는 데스크톱 모드에서는 단축키가 유일한 멈춤 수단이다.
    void stopAll();
  }
}

// ---------------------------------------------------------------- 동의

function setConsent(consent) {
  set({ consent });
  // 준비되면 동의 버튼 또는 '대화 시작' 버튼에 포커스: Enter 한 번으로 진행할 수 있게.
  if (!ui.sessionId) return;
  if (consent === 'intro') $('consent-hear').focus();
  else if (consent === 'ask') $('consent-yes').focus();
  else if (consent === 'granted') {
    $(ui.voiceMode.stt ? 'conv-start' : 'command').focus();
    startReminders();
  }
}

/** 1단계: 안내 듣기(이 버튼 누름으로 소리 재생이 허용된다). 2단계: Enter=동의, Esc=거부 */
async function hearConsent() {
  unlockAudio();
  void preloadCues();
  setConsent('ask');
  await healthReady;
  recordConsent();
  if (!ui.voiceMode.tts) {
    $('consent-panel').querySelector('details').open = true;
    return;
  }
  const mac = /Mac/.test(navigator.platform);
  const modifier = mac ? 'Command' : 'Control';
  const brief = {
    ko: '청음입니다. 공공서비스 화면을 읽어 드려요. 음성과 안내 문장은 음성 API로, 질문과 화면 내용은 설정한 AI로 보낼 수 있어요. 비밀번호는 말하지 마세요. '
      + (BACKGROUND ? '동의하려면 ' + (mac ? '커맨드' : '컨트롤') + ' 시프트 스페이스를 함께 누르세요.' : '동의는 엔터, 거절은 이스케이프예요.'),
    en: 'Cheongeum can read public service pages for you. Audio and narration go to the speech API. Your question and page text may go to your configured AI. Keep passwords private. '
      + (BACKGROUND ? 'Press ' + modifier + ', Shift and Space together to agree.' : 'Press Enter to agree or Escape to decline.'),
    zh: '青音可以为您朗读公共服务网页。语音和朗读文本会发送给语音服务，问题和网页内容可能会发送给您设置的人工智能。请不要说出密码。'
      + (BACKGROUND ? '同时按 ' + modifier + '、Shift 和空格键表示同意。' : '按回车键同意，按退出键拒绝。'),
    ja: 'チョンウムが公共サービスの画面を読み上げます。音声と読み上げ文は音声サービスに、質問や画面の内容は設定したAIに送られる場合があります。パスワードは言わないでください。'
      + (BACKGROUND ? '同意するには ' + modifier + '、Shift、スペースを同時に押してください。' : '同意はエンター、辞退はエスケープです。'),
  }[ui.lang];
  await speakAndWaitFrom(brief);
}

let consentSending = false;

async function answerConsent(granted) {
  // 단축키와 카드 버튼이 함께 와도 한 번만 보낸다
  if (!ui.sessionId || consentSending || (ui.consent !== 'intro' && ui.consent !== 'ask')) return;
  consentSending = true;
  try {
    await sendConsent(granted);
  } finally {
    consentSending = false;
  }
}

async function sendConsent(granted) {
  stopSpeaking();
  try {
    const r = await api.consent(ui.sessionId, granted);
    setConsent(granted ? 'granted' : 'declined');
    await applyResult(r, false);
    if (granted && ui.voiceMode.stt) {
      // 같은 키 입력 안에서 마이크를 켜야 브라우저가 허용한다.
      void startConversation();
    } else if (granted) {
      const fallback = $('dictation-hint').hidden ? dictationHelp() : $('dictation-hint').textContent;
      desk.message = desktopNotice(fallback);
      publishDesktop();
      announce(fallback);
      if (ui.tts) speak(fallback);
      $('command').focus();
    } else {
      await speakTurn(r);
      $('command').focus();
    }
  } catch (e) {
    setError(e.message);
  }
}

/** 신청 기록 기한 알림: 웹·데스크톱 모두. 하루 한 번, 밤(22–7시)에는 지금/아침을 먼저 묻는다. '알겠어'면 그날은 다시 안 함. */
function startReminders() {
  if (!ui.sessionId || reminderTimer) return;
  const check = async () => {
    const generation = sessionGeneration;
    const { text } = await api.reminders(ui.sessionId).catch(() => ({ text: null }));
    if (!text || generation !== sessionGeneration) return;
    const signature = `${new Date().toDateString()}|${text}`;
    if (reminderSeen === signature || ui.phase === 'speaking' || ui.phase === 'hearing') return;
    const hour = new Date().getHours();
    const night = hour >= 22 || hour < 7;
    if (night && !reminderNight) {
      reminderNight = true;
      desk.message = desktopNotice(workspaceText('기한 알림이 있어요. 지금 들을까요, 아침에 들을까요?', ui.lang));
      publishDesktop();
      push({ role: 'assistant', text: `기한 알림이 있어요. 지금 들을까요, 아침에 들을까요?` });
      await cue('reminder');
      await speakAndWait('기한 알림이 있어요. 지금 들으려면 \'지금\', 아침에 들으려면 \'아침\'이라고 해 주세요.');
      return;
    }
    reminderSeen = signature;
    desk.message = desktopNotice(workspaceText('기한 알림이 있어요. 저를 눌러 확인해 주세요.', ui.lang));
    publishDesktop();
    push({ role: 'assistant', text: `알림: ${text}` });
    await cue('reminder');
    void speakAndWait(`알림이에요. ${text} 들으셨으면 '알겠어'라고 해 주세요.`);
  };
  void check();
  reminderTimer = setInterval(() => void check(), 60 * 60 * 1000);
}

// ---------------------------------------------------------------- 명령·버튼

async function send(text, actionId = ui.last?.pendingConfirmation?.actionId ?? '') {
  const t = text.trim();
  if (!t || !ui.sessionId || recoveryChoice) return;
  if (!await readyForInput()) return;
  const origin = document.activeElement;
  const fromForm = $('command-form').contains(origin) || $('examples').contains(origin);
  if (reminderNight && /^지금[.! ]*$/.test(t)) {
    const { text: due } = await api.reminders(ui.sessionId).catch(() => ({}));
    if (due) {
      reminderSeen = `${new Date().toDateString()}|${due}`;
      push({ role: 'assistant', text: due });
      if (ui.tts) speak(due);
    }
    return;
  }
  if (reminderNight && /^아침[.! ]*$/.test(t)) return;
  const stop = stoppedGeneration;
  set({ busy: true, error: undefined });
  try {
    const result = await whileBusy(api.turn(ui.sessionId, t, actionId));
    if (stop === stoppedGeneration) await applyResult(result);
  } catch (e) {
    setError(e.message);
  } finally {
    set({ busy: false });
    if (fromForm && stop === stoppedGeneration && !recoveryChoice && ui.sessionId &&
        (document.activeElement === origin || document.activeElement === document.body)) {
      if (ui.state === 'WAITING_FOR_USER_CONFIRMATION') $('confirm-title').focus();
      else if (ui.last?.authHandoff?.status === 'waiting') $('auth-done').focus();
      else $('command').focus();
    }
  }
}

function stopAll() {
  const operation = stopSession();
  desk.stopping = operation;
  return operation.finally(() => {
    if (desk.stopping === operation) desk.stopping = null;
  });
}

async function stopSession() {
  const stop = ++stoppedGeneration;
  const wake = desk.wakeCount;
  const previousTurn = ui.last;
  desk.sleeping = !!ui.sessionId;
  // 멈춘 뒤에는 떠 있던 카드를 누를 수 없게(멈춤 응답을 기다리는 사이에 승인이 나가지 않게)
  if (desk.card) desk.dropped.add(desk.card.key);
  desk.card = undefined;
  desk.message = null;
  cueStopped();
  endConversation(false);
  stopSpeaking();
  recording?.cancel();
  recording = undefined;
  set({ listening: false, error: undefined });
  if (!ui.sessionId) return;
  try {
    const result = await api.cancel(ui.sessionId);
    if (stop !== stoppedGeneration) return;
    const stillSleeping = wake === desk.wakeCount;
    if (!stillSleeping && ui.last !== previousTurn) return;
    if (recoveryChoice) announce(result.speech);
    else await applyResult(result, stillSleeping, stillSleeping);
  } catch (e) {
    if (stop !== stoppedGeneration || wake !== desk.wakeCount) return;
    desk.sleeping = false;
    setError(e.message);
  }
}

/** 승인·거절: 화면에 보여 준 승인 번호(actionId)로만 보낸다. */
async function confirm(approve, actionId) {
  if (!ui.sessionId || recoveryChoice) return;
  const stop = stoppedGeneration;
  set({ busy: true });
  try {
    const result = await whileBusy(api.confirm(ui.sessionId, approve, actionId));
    if (stop === stoppedGeneration) await applyResult(result);
  } catch (e) {
    setError(e.message);
  } finally {
    set({ busy: false });
  }
}

/** 서버가 제안한 선택지(인증 마침·인증 취소·본문 읽기): 그 응답(turnId)과 인계 번호에 묶어 보낸다. */
async function chooseOffer(card, key) {
  if (!ui.sessionId || recoveryChoice) return;
  const stop = stoppedGeneration;
  const generation = sessionGeneration;
  set({ busy: true, error: undefined });
  try {
    const body = { turnId: card.ref.turnId, key, ...(card.ref.handoffId ? { handoffId: card.ref.handoffId } : {}) };
    const result = await whileBusy(api.choice(ui.sessionId, body));
    if (stop === stoppedGeneration && generation === sessionGeneration) await applyResult(result);
  } catch (e) {
    if (e.code !== 'CHOICE_EXPIRED') setError(e.message);
    else {
      desk.dropped.add(card.key);
      notice(e.message);
    }
  } finally {
    set({ busy: false });
  }
}

/** 카드 종류 → 선택지 → 실행. 서버 제안(offer)은 선택지 이름을 그대로 서버로 보낸다. */
const CARD_ACTIONS = {
  consent: { 'consent-yes': () => answerConsent(true), 'consent-no': () => answerConsent(false) },
  approval: { approve: (card) => confirm(true, card.ref.actionId), reject: (card) => confirm(false, card.ref.actionId) },
};

/**
 * 카드의 선택지 하나를 실행한다(대화 창 버튼·아바타 버튼 공용). 보여 준 카드 번호가 지금 카드가 아니면 실행하지 않는다.
 * 같은 카드는 한 번만: 기다리기 전에 표시해 두므로 두 번 누르기와 동시에 온 다른 화면의 선택이 둘 다 나가지 않는다.
 */
async function choose(choiceSetId, key) {
  const card = desk.card;
  if (!card || card.id !== choiceSetId) {
    notice('선택지가 바뀌었어요. 지금 안내를 다시 확인해 주세요.');
    return;
  }
  const offered = card.choices.some((c) => c.key === key && !c.open);
  const run = offered && (card.kind === 'offer' ? chooseOffer : CARD_ACTIONS[card.kind][key]);
  if (!run || ui.busy) return;
  const origin = document.activeElement;
  const fromDecision = $('confirm-panel').contains(origin) || $('auth-panel').contains(origin);
  const held = holdCard();
  if (!held) return;
  try {
    await run(card, key);
  } finally {
    releaseCard(held);
    if (fromDecision && document.activeElement === document.body) reveal();
  }
}

/** 지금 카드를 '보내는 중'으로 잡는다(이미 잡혀 있으면 undefined). 음성 한 턴도 카드를 잡아 버튼과 함께 나가지 않게 한다. */
function holdCard() {
  const id = desk.card?.id;
  if (!id || desk.consumed.has(id)) return undefined;
  desk.consumed.add(id);
  render();
  return id;
}

/** 응답이 오지 않아(오류) 같은 카드가 남아 있으면 다시 고를 수 있게 놓는다. 새 응답이 왔으면 이미 새 카드다. */
function releaseCard(id) {
  if (id && desk.card?.id === id) {
    desk.consumed.delete(id);
    render();
  }
}

/** 짧은 알림: 기록에 남기고 소리로도 알린다. */
function notice(text) {
  push({ role: 'assistant', text });
  announce(text);
  if (ui.tts) speak(text);
}

/** 대화 창을 연 뒤 지금 결정할 자리로 초점을 옮긴다(아바타·트레이에서 연 경우). */
function reveal(focus) {
  const where = focus ?? (!ui.sessionId ? 'ended' : desk.card?.kind === 'approval' ? 'confirm' : desk.card?.kind === 'consent' ? 'consent'
    : ui.last?.authHandoff?.status === 'waiting' ? 'auth' : 'command');
  const target = {
    confirm: 'confirm-title',
    consent: ui.consent === 'ask' ? 'consent-yes' : 'consent-hear',
    auth: 'auth-done',
    command: 'command',
    ended: 'session-new',
  }[where];
  const el = $(target);
  if (el && !el.disabled && !el.hidden) el.focus();
  else $('log').focus();
}

/** 한 번 누르면 녹음하고 다시 누르면 음성 API에 보낸다. */
async function toggleMic() {
  if (openingMic || !ui.sessionId || !ui.voiceMode.stt || ui.consent !== 'granted') return;
  if (!await readyForInput() || openingMic || ui.last?.authHandoff?.status === 'waiting') return;
  if (recording) {
    const rec = recording;
    const generation = stoppedGeneration;
    recording = undefined;
    set({ listening: false, busy: true });
    announce('인식 중입니다.');
    const audio = await rec.stop();
    void cue('done');
    try {
      const result = await withProgressCues(whileBusy(api.audioTurn(ui.sessionId, audio, rec.asked)));
      if (generation === stoppedGeneration) await applyResult(result);
    } catch (e) {
      if (generation === stoppedGeneration) setError(e.message);
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
    await cue('listen');
    const asked = ui.last?.pendingConfirmation?.actionId ?? '';
    const rec = await startRecording(() => api.liveAudio(sessionId), ui.micId, () => void toggleMic());
    if (sessionId !== ui.sessionId || generation !== stoppedGeneration || ui.consent !== 'granted'
        || $('settings-dialog').open || ui.last?.authHandoff?.status === 'waiting') {
      rec.cancel();
      return;
    }
    recording = Object.assign(rec, { asked });
    set({ listening: true });
    announce('듣는 중입니다. 말씀을 마치면 버튼을 다시 누르세요.');
  } catch {
    setError('마이크를 사용할 수 없습니다. 브라우저 마이크 권한을 확인하거나 텍스트로 입력하세요.');
  } finally {
    openingMic = false;
  }
}

// ---------------------------------------------------------------- 이벤트 연결

function bind() {
  followThread($('thread'));
  $('intro-skip').addEventListener('click', () => skipIntro());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && skipIntro()) e.preventDefault();
  });
  $('open-settings').addEventListener('click', () => void openSettings());
  $('settings-form').addEventListener('submit', saveSettings);
  $('setup-device').addEventListener('change', () => {
    const remember = $('setup-remember-service');
    remember.disabled = $('setup-device').value !== 'personal';
    $('setup-browser').disabled = remember.disabled;
    if (remember.disabled) remember.checked = false;
  });
  $('setup-language').addEventListener('change', () => {
    const modal = $('settings-dialog');
    localizeSettings(modal, $('setup-language').value, modal.dataset.keyState, Boolean(ui.sessionId));
  });
  $('setup-cancel').addEventListener('click', () => $('settings-dialog').close());
  $('settings-dialog').addEventListener('cancel', e => {
    if ($('setup-cancel').hidden || $('setup-save').disabled) e.preventDefault();
  });
  $('settings-dialog').addEventListener('close', () => { $('setup-key').value = ''; });
  $('consent-full').addEventListener('click', () => speak(consentText()));
  $('consent-text').textContent = consentText();
  $('dictation-hint').textContent = dictationHelp();
  const command = $('command');
  command.addEventListener('input', () => {
    if (command.value.trim()) command.dataset.actionId ??= ui.last?.pendingConfirmation?.actionId ?? '';
    else delete command.dataset.actionId;
  });
  $('starter-actions').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-request]');
    if (!button || button.disabled) return;
    command.value = button.dataset.request;
    command.dataset.actionId = ui.last?.pendingConfirmation?.actionId ?? '';
    command.focus();
    command.setSelectionRange(command.value.length, command.value.length);
  });
  $('unsupported').replaceChildren(
    ...UNSUPPORTED.map((u) => {
      const li = document.createElement('li');
      li.textContent = u;
      return li;
    }),
  );
  $('examples').replaceChildren(
    ...EXAMPLES.map((ex) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = ex;
      b.disabled = true;
      b.addEventListener('click', () => void send(b.textContent));
      li.append(b);
      return li;
    }),
  );

  $('stop-all').addEventListener('click', () => void stopAll());
  $('session-end').addEventListener('click', () => void endSession());
  $('session-new').addEventListener('click', () => void chooseSession());
  $('recovery-yes').addEventListener('click', () => void answerRecovery(true));
  $('recovery-no').addEventListener('click', () => void answerRecovery(false));
  $('tts-toggle').addEventListener('click', () => {
    if (ui.tts) {
      stopSpeaking();
      set({ tts: false });
    } else set({ tts: true });
    if (edge) {
      edge.enabled = ui.tts;
      edge.updateAudio();
    }
  });
  $('mic-check').addEventListener('click', async () => {
    if ($('mic-check').disabled) return;
    checkingMic = true;
    render();
    const status = $('mic-check-result');
    status.textContent = workspaceText('마이크를 확인하고 있어요.', ui.lang);
    let probe;
    try {
      let track = (edge?.stream ?? loop?.stream)?.getAudioTracks().find((t) => t.readyState === 'live');
      if (!track) {
        probe = await navigator.mediaDevices.getUserMedia({ audio: ui.micId ? { deviceId: { exact: ui.micId } } : true });
        track = probe.getAudioTracks()[0];
      }
      status.textContent = workspaceText(track?.readyState === 'live' ? '마이크를 사용할 수 있어요.' : '연결된 마이크를 확인해 주세요.', ui.lang);
    } catch (error) {
      status.textContent = workspaceText(error.name === 'NotAllowedError'
        ? '마이크 권한이 꺼져 있어요. 기기의 마이크 권한 설정을 확인해 주세요.'
        : '마이크를 열 수 없어요. 연결과 입력 장치 선택을 확인해 주세요.', ui.lang);
    } finally {
      probe?.getTracks().forEach((track) => track.stop());
      checkingMic = false;
      render();
    }
  });
  $('sound-check').addEventListener('click', () => {
    unlockAudio();
    set({ error: undefined });
    speak(workspaceText('소리 확인입니다. 이 목소리가 들리면 음성 안내가 정상입니다.', ui.lang));
  });
  $('stop-speaking').addEventListener('click', stopSpeaking);
  $('contrast-toggle').addEventListener('click', () => set({ contrast: !ui.contrast }));

  $('consent-hear').addEventListener('click', () => void hearConsent());
  $('consent-yes').addEventListener('click', () => void answerConsent(true));
  $('consent-no').addEventListener('click', () => void answerConsent(false));

  $('conv-start').addEventListener('click', () => void startConversation());
  $('conv-end').addEventListener('click', () => endConversation());
  const mode = $('conversation-mode');
  try { if (localStorage.getItem('cheongeum.voiceMode') === 'dictate') mode.value = 'dictate'; } catch {}
  mode.addEventListener('change', () => {
    try { localStorage.setItem('cheongeum.voiceMode', mode.value); } catch {}
    if (conversationOn || startingLoop) endConversation();
  });
  $('mic-select').addEventListener('change', (e) => {
    set({ micId: e.target.value });
    try {
      localStorage.setItem('cheongeum.micId', e.target.value);
    } catch {
      /* 저장소를 못 쓰면 이번만 */
    }
    if (conversationOn) endConversation();
  });
  $('lang-select').addEventListener('change', async (e) => {
    if (!ui.sessionId) return;
    try {
      const r = await api.language(ui.sessionId, e.target.value);
      await applyResult(r, !conversationOn);
      if (conversationOn) await speakTurn(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : '언어를 바꾸지 못했습니다.');
    }
  });

  $('command-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = command.value.trim();
    if (!text || $('send').disabled) return;
    const actionId = command.dataset.actionId ?? '';
    command.value = '';
    delete command.dataset.actionId;
    void send(text, actionId);
  });
  $('mic-btn').addEventListener('click', () => void toggleMic());
  $('talk-btn').addEventListener('click', talkNow);

  $('confirm-edit').addEventListener('click', () => $('command').focus());

  // 데스크톱 앱: 전역 단축키(Cmd/Ctrl+Shift+Space)로 '지금 말하기'
  desktop?.onTalk(() => talkNow());
  // 아바타·트레이에서 온 동작(메인 프로세스가 모양을 확인해 넘긴다)
  desktop?.onAction?.((action) => {
    if (action.type === 'settings') void openSettings();
    else if (action.type === 'stop') void stopAll();
    else if (action.type === 'reveal') {
      wakeAvatar();
      reveal(action.focus);
    }
    else if (action.type === 'choose') void choose(action.choiceSetId, action.key);
  });
  onSpeaking((speaking) => {
    desk.speaking = speaking;
    if (edge) {
      edge.localSpeech = speaking;
      edge.updateAudio();
    }
    renderPhase();
    publishDesktop();
  });

  // 스페이스: 캡처 단계에서 가로채 포커스된 버튼(예: 대화 끝내기)이 눌리지 않게 한다. 글 입력 중에는 제외.
  window.addEventListener(
    'keydown',
    (e) => {
      const t = e.target;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
      if (e.code !== 'Space' || typing || !conversationOn) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) talkNow();
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (e.code === 'Space' && conversationOn && !(e.target instanceof HTMLInputElement)) e.preventDefault();
    },
    true,
  );
  // 동의 안내 중 Esc = 동의하지 않음
  window.addEventListener('keydown', (e) => {
    if (!$('settings-dialog').open && ui.consent === 'ask' && e.key === 'Escape') {
      e.preventDefault();
      void answerConsent(false);
    }
  });
  // 첫 클릭·키 입력 때 소리 채널을 잠금 해제(자동재생 정책).
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);
  // 새로고침·탭 닫기 때 이 세션의 브라우저 창을 닫는다.
  window.addEventListener('pagehide', () => {
    if (!ui.sessionId) return;
    if (recoverable) api.detach(ui.sessionId);
    else api.close(ui.sessionId);
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
}

function showRecovery(choice, title, message, yes, no) {
  recoveryChoice = choice;
  $('recovery-title').textContent = title;
  $('recovery-message').textContent = message;
  $('recovery-yes').textContent = yes;
  $('recovery-no').textContent = no;
  show('recovery-panel', true);
  show('session-new', false);
  render();
  $('recovery-title').focus();
}

function closeRecovery() {
  recoveryChoice = undefined;
  show('recovery-panel', false);
  render();
}

function connect(s) {
  desk.message = null;
  desk.sleeping = s.state === 'STOPPED';
  desk.stopGeneration = s.stopGeneration ?? null;
  recoverable = !!s.token;
  api.writer(s.writer);
  if (recoverable) {
    tabStore(RECOVERY_KEY, s.token);
  }
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => void api.heartbeat(s.sessionId).catch(() => undefined), 15000);
  set({ sessionId: s.sessionId, state: s.state ?? 'IDLE' });
}

async function endSession() {
  const sid = ui.sessionId;
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
  setSpeechLang('ko');
  set({ sessionId: undefined, state: 'IDLE', last: undefined, hasTurn: false, busy: false, listening: false, consent: undefined, lang: 'ko' });
  $('command').value = '';
  delete $('command').dataset.actionId;
  $('log').replaceChildren();
  show('session-new', true);
  $('session-new').focus();
  try {
    if (sid) await api.end(sid);
  } catch (error) {
    if (error.status !== 404) setError(error.message);
  } finally {
    if (!ui.sessionId) api.writer(undefined);
  }
}

async function answerRecovery(yes) {
  const choice = recoveryChoice;
  if (choice === 'new') {
    closeRecovery();
    return openSession(yes);
  }
  if (choice === 'retry') {
    closeRecovery();
    if (yes) return chooseSession();
    tabStore(RECOVERY_KEY, null);
    tabStore(PROGRESS_KEY, null);
    return chooseSession();
  }
  if (choice !== 'resume') return;
  if (!yes) return endSession();
  $('recovery-yes').disabled = true;
  try {
    const checkpoint = await api.resume(ui.sessionId);
    desk.sleeping = checkpoint.state === 'STOPPED';
    desk.stopGeneration = checkpoint.stopGeneration ?? null;
    closeRecovery();
    setSpeechLang(checkpoint.lang ?? 'ko');
    set({ state: checkpoint.state, lang: checkpoint.lang ?? 'ko', last: { authHandoff: checkpoint.authHandoff }, hasTurn: true });
    tabStore(PROGRESS_KEY, String(checkpoint.progressSeq ?? 0));
    const consent = checkpoint.consent === 'pending' ? 'ask' : checkpoint.consent;
    setConsent(consent);
    const step = checkpoint.step ? `연습 신청서 ${checkpoint.step}단계예요. ` : '';
    const approval = checkpoint.approvalKind ? '실행할 동작을 다시 요청하고 새로 확인해 주세요. ' : '';
    const message = `${step || '이전 작업에 연결했어요. '}${approval}음성 입력을 쓰려면 마이크를 다시 켜 주세요.`;
    push({ role: 'assistant', text: message });
    if (ui.tts) speak(message);
    if (consent !== 'intro') $('command').focus();
  } catch (error) {
    if (error.status === 410 || error.status === 404) await endSession();
    setError(error.message);
  } finally {
    $('recovery-yes').disabled = false;
  }
}

async function chooseSession() {
  show('session-new', false);
  const health = await healthReady;
  const token = tabStore(RECOVERY_KEY);
  if (token && health?.recoveryAvailable !== false) {
    try {
      let restored;
      for (let retry = 0; retry < 4; retry += 1) {
        try {
          restored = await api.recover(token);
          break;
        } catch (error) {
          if (error.code !== 'SESSION_WRITER_ACTIVE' || retry === 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      connect(restored);
      showRecovery('resume', '이전 작업을 이어 할까요?', '이 탭에서 작업을 이어 할 수 있어요. 마이크는 꺼져 있습니다.', '이전 작업 이어하기', '이용 종료');
      return;
    } catch (error) {
      if (error.status !== 404 && error.status !== 400) {
        showRecovery('retry', '이전 작업에 연결하지 못했어요', error.message, '이전 작업 다시 연결', '새 작업 시작');
        return;
      }
    }
  }
  tabStore(RECOVERY_KEY, null);
  tabStore(PROGRESS_KEY, null);
  if (health?.recoveryAvailable) {
    showRecovery('new', '같은 탭 작업 복구', '개인 컴퓨터에서 작업을 이어갈 수 있게 할까요? 브라우저가 열려 있으면 연결이 끊긴 뒤 5분 동안 돌아올 수 있어요.', '복구 켜고 시작', '복구 없이 시작');
  } else {
    await openSession(false);
  }
}

async function start() {
  bind();
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('cheongeum.reminded.') || key.startsWith('cheongeum.remindAck.')) localStorage.removeItem(key);
    }
  } catch { /* 저장소 비활성 */ }
  render();
  announce('청음을 준비하고 있어요.');
  const health = await refreshHealth();
  if (health?.setupRequired) return firstRun.start(1);
  // 1단계를 저장한 뒤 앱을 닫았으면 소리 확인부터 한 번 이어 간다
  if (health?.firstRun === 'stage2') return firstRun.start(2);
  if (health && !health.stt.supported) desktop?.showSetup?.();
  await chooseSession();
}

function refreshHealth() {
  healthReady = api.health().then(h => {
    set({
      practiceMode: h.practiceMode === true,
      workspaceAvailable: h.workspaceAvailable === true,
      baseSpeed: h.voiceSpeed ?? profile.speed,
      voiceMode: {
        known: true, stt: h.stt.supported, tts: h.tts.supported, edge: h.voiceEdge, llmRoles: h.llmRoles ?? {},
        label: [h.voiceEdge && '실시간 대화 ' + h.voiceEdge,
          h.stt.supported && '받아쓰기 ' + (h.stt.liveModel ?? h.stt.provider),
          h.tts.supported && '음성 안내 ' + h.tts.provider].filter(Boolean).join(' · '),
      },
      tts: h.tts.supported,
    });
    show('open-settings', h.settingsAvailable === true);
    $('consent-text').textContent = consentText();
    return h;
  }).catch(error => {
    setError(error.message);
    return undefined;
  });
  return healthReady;
}

async function openSettings(first = false) {
  const modal = $('settings-dialog');
  if (modal.open) return;
  endConversation(false);
  recording?.cancel();
  recording = undefined;
  set({ listening: false });
  stopSpeaking();
  if (first) desktop?.showSetup?.();
  modal.showModal();
  $('setup-cancel').hidden = first;
  $('setup-error').hidden = true;
  $('setup-save').disabled = true;
  $('setup-key').value = '';
  try {
    const prefs = await api.settings();
    modal.dataset.keyState = prefs.loadError ? 'error' : prefs.hasKey ? 'saved' : 'empty';
    $('setup-language').value = prefs.language;
    modal.dataset.savedLanguage = prefs.language;
    $('setup-device').value = prefs.sharedDevice ? 'shared' : (prefs.deviceUse ?? 'unidentified');
    $('setup-device').disabled = prefs.sharedDevice === true;
    $('setup-remember-service').disabled = $('setup-device').value !== 'personal';
    $('setup-remember-service').checked = !$('setup-remember-service').disabled && prefs.rememberService === true;
    $('setup-browser').value = prefs.browser ?? 'separate';
    $('setup-browser').disabled = $('setup-device').value !== 'personal';
    show('setup-browser-fallback', prefs.browserFallback === true);
    show('setup-autostart-row', !!desktop?.getAutoStart);
    if (desktop?.getAutoStart) $('setup-autostart').checked = await desktop.getAutoStart();
    $('setup-region').replaceChildren(new Option('선택 안 함', ''), ...prefs.regions.map(s => new Option(s, s)));
    $('setup-region').options[0].dataset.onboarding = 'none';
    $('setup-region').value = prefs.region;
    const speed = $('setup-speed');
    if (![...speed.options].some(o => Number(o.value) === prefs.speed)) speed.add(new Option(prefs.speed + '배', String(prefs.speed)));
    speed.value = String(prefs.speed);
    localizeSettings(modal, prefs.language, modal.dataset.keyState, Boolean(ui.sessionId));
    (first ? $('setup-language') : $('setup-key')).focus();
  } catch (error) {
    $('setup-error').textContent = error.message;
    $('setup-error').hidden = false;
  } finally {
    $('setup-save').disabled = false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  if ($('setup-save').disabled) return;
  $('setup-save').disabled = true;
  $('setup-cancel').disabled = true;
  try {
    await api.saveSettings({ apiKey: $('setup-key').value.trim(), language: $('setup-language').value,
      region: $('setup-region').value, speed: Number($('setup-speed').value), deviceUse: $('setup-device').value,
      rememberService: $('setup-remember-service').checked, browser: $('setup-browser').value });
    if (desktop?.setAutoStart) desktop.setAutoStart($('setup-autostart').checked);
    $('setup-key').value = '';
    $('settings-dialog').close();
    await refreshHealth();
    if (ui.sessionId) {
      if ($('setup-language').value !== $('settings-dialog').dataset.savedLanguage) {
        setSpeechLang($('setup-language').value);
        set({ lang: $('setup-language').value });
      }
      announce('이용 설정을 저장했어요.');
    } else {
      await chooseSession();
    }
  } catch (error) {
    $('setup-error').textContent = error.message;
    $('setup-error').hidden = false;
  } finally {
    $('setup-save').disabled = false;
    $('setup-cancel').disabled = false;
  }
}

async function openSession(recovery) {
  set({ error: undefined });
  try {
    const s = await api.createSession(recovery);
    connect(s);
    setSpeechLang(s.lang ?? 'ko');
    set({ lang: s.lang ?? 'ko' });
    if (s.speechPrefs) applySpeechPrefs(s.speechPrefs);
    if (!s.consentRequired) {
      setConsent('granted');
      announce('청음이 준비됐어요.');
      return;
    }
    let first = s.firstStartupGuide;
    try {
      first ??= !localStorage.getItem('cheongeum.startupGuideSeen');
      localStorage.setItem('cheongeum.startupGuideSeen', '1');
    } catch { /* 설치본은 서버 설정 폴더의 기록을 사용한다. */ }
    if (first === false) {
      setConsent('ask');
      recordConsent();
    } else {
      setConsent('intro');
      if (desktop) void hearConsent();
    }
  } catch (e) {
    setError(`세션을 시작하지 못했습니다. ${e.message}`);
    show('session-new', true);
    $('session-new').focus();
  }
}

void start();
