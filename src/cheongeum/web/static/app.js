// 청음 웹 UI(빌드 없는 바닐라 JS). 화면 골격은 index.html에 있고, 여기서는 상태를 바꾸고 해당 부분만 다시 그린다.
// 입력란·버튼은 다시 만들지 않으므로 포커스가 유지된다(화면낭독기 사용자를 위해).
import { api } from './api.js';
import { getSpeechLang, setSpeechLang, unlockAudio } from './audio.js';
import { browserStt, listMicrophones, preferredMicrophone, startRecording, VoiceLoop } from './mic.js';
import { applySpeechPrefs, browserTts, earcon, preloadCues, progressVoice, serverTts, takeInterruptedSpeech, transitionCue } from './speaker.js';

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
  '본문 읽어줘',
  '링크 목록 알려줘',
  '장애인연금 얼마 받아?',
  '지금까지 쓴 내용 읽어줘',
  '모의 접수 내용을 확인했어',
];

const BACKGROUND = new URLSearchParams(location.search).get('background') === '1';

const ALL_LANGS = ['ko', 'en', 'zh', 'ja'];

/** 음성이 어디로 가는지(서버 /api/health의 stt.localLanguages = 이 컴퓨터 안에서 받아쓰는 언어) */
function voiceRouteText(local = []) {
  if (ALL_LANGS.every((l) => local.includes(l)))
    return '말씀하신 음성은 이 컴퓨터 안에서 글자로 바뀌며 밖으로 전송되지 않습니다. 청음은 녹음을 저장하지 않습니다.';
  if (local.includes('ko'))
    return '한국어 음성은 이 컴퓨터 안에서 글자로 바뀌며 밖으로 전송되지 않습니다. 영어, 중국어, 일본어 음성은 받아쓰기를 위해 외부 인공지능 서비스인 OpenAI로 전송됩니다. 청음은 녹음을 저장하지 않습니다.';
  return '말씀하신 음성은 받아쓰기를 위해 외부 인공지능 서비스인 OpenAI로 전송되며, 청음은 녹음을 저장하지 않습니다.';
}

/** 도움말 한 줄: 음성 인식이 어디서 이루어지는지 */
function voiceHelp(voiceMode) {
  const local = voiceMode.localLanguages ?? [];
  if (ALL_LANGS.every((l) => local.includes(l))) return '음성은 이 컴퓨터 안에서 받아씁니다';
  if (local.includes('ko')) return '한국어 음성은 이 컴퓨터 안에서 받아쓰고, 다른 언어는 외부 음성 인식 서비스로 전송됩니다';
  return '음성은 외부 음성 인식 서비스로 전송됩니다';
}

/** 역할별 LLM이 어디로 가는지(/api/health.llmRoles). rules·mock은 밖으로 안 나감. */
function llmRouteText(roles = {}) {
  const label = { understand: '말씀 이해', goal: '목표 수행', web: '화면·검색 요약' };
  const external = Object.entries(roles)
    .filter(([k, v]) => label[k] && v && !/^(rules|mock)/i.test(String(v)))
    .map(([k, v]) => `${label[k]}은 ${v}`);
  if (!external.length) return '글 이해는 이 컴퓨터의 규칙으로만 처리합니다.';
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

const $ = (id) => document.getElementById(id);

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
let conversationOn = false;
let loop;
let recording;
let stopListening;
let reminderTimer;
let messageSeq = 0;
// 일하는 동안: 사용자가 말하는 중 / 청음이 짧은 안내(진행 상황)를 말하는 중
let userTalking = false;
let busyTalking = false;
/** 마이크 경로 신호음은 음성 안내 꺼짐과 관계없이 낸다. 결과·알림 신호음은 ui.tts를 따른다. */
const MIC_CUES = new Set(['start', 'listen', 'done', 'thinking', 'working', 'stopped', 'end']);
const STOP_CUE_WINDOW_MS = 5000;
let stopCuedAt = 0;

function cue(kind) {
  if (!MIC_CUES.has(kind) && !ui.tts) return Promise.resolve();
  return earcon(kind);
}

function cueStopped() {
  stopCuedAt = Date.now();
  void cue('stopped');
}

function set(patch) {
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
  const li = document.createElement('li');
  li.className = `msg ${m.role}`;
  li.dataset.id = `${Date.now()}-${messageSeq++}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = `${m.role === 'user' ? '나' : m.role === 'assistant' ? '청음' : '안내'}: `;
  li.append(who, document.createTextNode(m.text));
  $('log').append(li);
}

// ---------------------------------------------------------------- 그리기

function show(id, visible) {
  $(id).hidden = !visible;
}

function render() {
  const { sessionId, state, last, busy, listening, voiceMode, tts, contrast, error, phase, consent, mics, micId, lang } = ui;
  $('app').className = contrast ? 'app high-contrast' : 'app';

  // 도구 막대
  const ttsBtn = $('tts-toggle');
  ttsBtn.setAttribute('aria-pressed', String(tts));
  ttsBtn.textContent = `음성 안내 ${tts ? '켜짐' : '꺼짐'}`;
  ttsBtn.disabled = !browserTts.supported && !voiceMode.tts;
  const contrastBtn = $('contrast-toggle');
  contrastBtn.setAttribute('aria-pressed', String(contrast));
  contrastBtn.textContent = `고대비 ${contrast ? '켜짐' : '꺼짐'}`;

  // 동의 화면
  const consentShown = consent === 'intro' || consent === 'ask';
  show('consent-panel', consentShown);
  show('consent-hear', consent === 'intro');
  $('consent-hear').disabled = !sessionId;
  show('consent-yes', consent === 'ask');
  show('consent-no', consent === 'ask');

  // 대화 조절
  show('conv-start', phase === 'off');
  $('conv-start').disabled = !sessionId || consent !== 'granted';
  show('conv-end', phase !== 'off');
  const phaseEl = $('phase');
  phaseEl.className = `phase phase-${phase}`;
  phaseEl.textContent = `음성 대화: ${PHASE_LABELS[phase]}`;
  show('conv-hint', phase !== 'off');
  show('mic-wrap', mics.length > 1);
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
  $('command').disabled = !sessionId;
  const send = $('send');
  send.disabled = !sessionId || busy;
  send.textContent = busy ? '처리 중…' : '보내기';
  const micBtn = $('mic-btn');
  show('mic-btn', phase === 'off');
  micBtn.setAttribute('aria-pressed', String(listening));
  micBtn.disabled = !sessionId || (busy && !listening) || (!voiceMode.stt && !browserStt.supported);
  micBtn.textContent = listening ? '말하기 끝 (보내기)' : '음성 입력';
  const talkBtn = $('talk-btn');
  show('talk-btn', phase !== 'off');
  talkBtn.disabled = phase === 'starting' || phase === 'thinking';
  talkBtn.textContent = phase === 'speaking' ? '지금 말하기 (안내 끊기)' : phase === 'hearing' ? '말 끝 (바로 보내기)' : '듣는 중 — 말씀하세요';
  $('command-help').textContent =
    `비밀번호·주민등록번호·계좌번호는 말하거나 입력하지 마세요. ${voiceHelp(voiceMode)}(${voiceMode.label}).` +
    (voiceMode.stt ? ' 음성 입력 버튼을 누르고 말한 뒤 다시 누르세요.' : !browserStt.supported ? ' 이 브라우저는 음성 인식을 지원하지 않아 텍스트 입력만 사용할 수 있습니다.' : '');
  for (const b of $('examples').querySelectorAll('button')) b.disabled = !sessionId || busy;

  // 현재 상태
  const obs = last?.observation;
  $('st-state').textContent = STATE_LABELS_KO[state] ?? state;
  $('st-step').textContent = obs?.step ? `${obs.step.index}/${obs.step.total} — ${obs.step.name}` : '없음';
  $('st-title').textContent = obs?.title ?? '아직 열지 않음';
  $('st-access').textContent =
    last?.accessMode === 'full' ? '지원 사이트(연습 신청 가능)' : last?.accessMode === 'read-only' ? '읽기 전용(읽기·이동·검색만)' : '없음';
  const visibleFields = obs?.fields.filter((f) => f.visible && f.type !== 'checkbox') ?? [];
  show('fields-wrap', visibleFields.length > 0);
  $('fields').replaceChildren(
    ...visibleFields.map((f) => {
      const li = document.createElement('li');
      li.textContent = `${f.label} ${f.required ? '(필수)' : ''} — ${f.sensitive ? '직접 입력 항목' : f.filled ? `입력됨: ${f.value}` : '비어 있음'}${f.invalid ? ' · 오류' : ''}`;
      return li;
    }),
  );

  // 승인 확인
  const pending = state === 'WAITING_FOR_USER_CONFIRMATION' ? last?.pendingConfirmation : undefined;
  show('confirm-panel', !!pending);
  if (pending) {
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
  $('confirm-yes').disabled = busy;
  $('confirm-no').disabled = busy;

  show('auth-panel', state === 'AUTH_HANDOFF');
  const receipt = state === 'MOCK_SUBMITTED' ? last?.verification?.receipt : undefined;
  show('result-panel', !!receipt);
  $('receipt').textContent = receipt ?? '';

  const sources = last?.sources ?? [];
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
      li.textContent = `${a.action.reason} — ${a.policy.allowed ? (a.result?.ok ? '성공' : `실패(${a.result?.errorCode ?? '미실행'})`) : `차단: ${a.policy.reason}`}`;
      return li;
    }),
  );
}

function setPhase(p) {
  set({ phase: p });
}

// ---------------------------------------------------------------- 응답·음성

async function applyResult(r, speakIt = true) {
  const prevTurn = ui.last?.turnId;
  const prevState = ui.state;
  setSpeechLang(r.lang);
  if (r.speechPrefs) applySpeechPrefs(r.speechPrefs);
  set({ last: r, state: r.state, lang: r.lang ?? 'ko' });
  push({ role: 'user', text: r.userUtterance });
  push({ role: 'assistant', text: r.speech });
  announce(`상태: ${STATE_LABELS_KO[r.state]}`);
  const kind = transitionCue(prevState, r.state);
  if (kind && !(kind === 'stopped' && Date.now() - stopCuedAt < STOP_CUE_WINDOW_MS)) await cue(kind);
  if (ui.tts && speakIt) {
    // 본인인증 인계: 안내 한 번만 말하고 TTS를 멈춰 화면 낭독기가 입력 칸을 읽게 한다
    if (r.state === 'AUTH_HANDOFF') void speakAndWait(r.speech).then(() => stopSpeaking());
    else speak(r.speech);
  }
  if (r.state === 'WAITING_FOR_USER_CONFIRMATION' && r.turnId !== prevTurn) $('confirm-title').focus();
}

/** 서버 TTS가 있으면 사용하고, 실패하면 브라우저 음성으로 대체한다. */
function speak(text) {
  if (!ui.voiceMode.tts) return browserTts.speak(text);
  void serverTts.speak(text, (chunk) => api.speak(chunk, getSpeechLang())).then((result) => {
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
async function speakAndWaitFrom(text, fromChunk = 0) {
  if (!ui.tts) return;
  if (!ui.voiceMode.tts) {
    await browserTts.speakAndWait(text);
    return;
  }
  const result = await serverTts.speak(text, (chunk) => api.speak(chunk, getSpeechLang()), fromChunk);
  if (result === 'failed') await browserTts.speakAndWait(text);
}

async function speakAndWait(text) {
  if (!ui.tts) return;
  if (!ui.voiceMode.tts) return browserTts.speakAndWait(text);
  const result = await serverTts.speak(text, (chunk) => api.speak(chunk, getSpeechLang()));
  if (result === 'failed') await browserTts.speakAndWait(text);
  if (result === 'blocked') setError('브라우저가 소리 재생을 막았습니다. 화면을 한 번 클릭해 주세요.');
}

const THINKING_DELAY_MS = 1000;
const WORKING_START_MS = 3000;
const WORKING_EVERY_MS = 2500;

/** 생각중·일하는중 신호음. 반환값을 부르면 타이머를 모두 지운다. */
function progressCues() {
  let cancelled = false;
  let intervalId;
  const thinkingId = setTimeout(() => {
    if (!cancelled) void cue('thinking');
  }, THINKING_DELAY_MS);
  const workingId = setTimeout(() => {
    if (cancelled) return;
    void cue('working');
    intervalId = setInterval(() => {
      if (!cancelled) void cue('working');
    }, WORKING_EVERY_MS);
  }, WORKING_START_MS);
  return () => {
    cancelled = true;
    clearTimeout(thinkingId);
    clearTimeout(workingId);
    if (intervalId !== undefined) clearInterval(intervalId);
  };
}

function endConversation(withCue = true) {
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
  if (conversationOn || !ui.sessionId) return;
  if (!ui.voiceMode.stt) {
    setError('대화 모드는 서버 음성 인식(STT_PROVIDER=local 또는 openai)이 필요합니다. 지금은 음성 입력 버튼이나 텍스트를 사용하세요.');
    return;
  }
  if (ui.consent === 'declined') {
    setError('동의하지 않으셔서 음성 대화를 시작하지 않습니다. 복지 제도 질문은 텍스트로 입력할 수 있습니다.');
    return;
  }
  unlockAudio();
  void preloadCues();
  set({ error: undefined });
  setPhase('starting');
  const current = new VoiceLoop();
  const micTrouble =
    '마이크 연결이 끊겼거나 소리가 들어오지 않습니다. 아이폰 등 다른 기기 마이크가 선택돼 있을 수 있어요. 아래 마이크 선택에서 이 컴퓨터의 마이크를 고른 뒤 대화를 다시 시작해 주세요.';
  try {
    // 저장된 마이크가 없으면 권한을 받은 뒤 내장 마이크를 골라 다시 연다(아이폰 연속성 마이크 회피).
    await current.start(ui.micId);
    const list = await listMicrophones().catch(() => []);
    set({ mics: list });
    const preferred = ui.micId ?? preferredMicrophone(list);
    if (!ui.micId && preferred && list.length > 1) {
      current.stop();
      await current.start(preferred);
      set({ micId: preferred });
    }
    if (await current.isSilent()) throw new Error('silent');
  } catch {
    current.stop();
    setPhase('off');
    setError(micTrouble);
    announce(micTrouble);
    void cue('problem').then(() => speakAndWait(micTrouble));
    return;
  }
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
  push({ role: 'system', text: `사용하는 마이크: ${current.deviceLabel || '기본 마이크'}` });
  loop = current;
  conversationOn = true;
  setPhase('speaking');
  await cue('start');
  push({ role: 'assistant', text: GREETING });
  await speakAndWait(GREETING);

  let failures = 0;
  while (conversationOn) {
    setPhase('listening');
    announce('듣고 있습니다. 말씀하세요.');
    await cue('listen');
    const audio = await current.listenOnce(() => setPhase('hearing'));
    if (!audio || !conversationOn) break;
    void cue('done');
    setPhase('thinking');
    const stopProgress = progressCues();
    try {
      const r = await whileBusy(api.audioTurn(ui.sessionId, audio), current);
      failures = 0;
      await applyResult(r, false);
      if (!conversationOn) break;
      setPhase('speaking');
      // 끼어들기: 안내 중에 사용자가 말하면 안내를 멈추고 바로 듣는다.
      // 2초 안에 말이 없으면 거짓 끼어들기로 보고 멈춘 안내를 이어 말한다.
      let barged = false;
      const stopWatch = current.watchBargeIn(() => {
        barged = true;
        stopSpeaking();
        announce('말씀을 들을게요.');
      });
      await speakAndWait(r.speech);
      stopWatch();
      if (barged && conversationOn) {
        const interrupted = takeInterruptedSpeech();
        setPhase('listening');
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
          const again = await whileBusy(api.audioTurn(ui.sessionId, clip), current);
          await applyResult(again, false);
          if (!conversationOn) break;
          setPhase('speaking');
          await speakAndWait(again.speech);
        } catch (be) {
          if (interrupted?.kind === 'server' && interrupted.text && /알아듣지 못했습니다/.test(be.message || '')) {
            setPhase('speaking');
            await speakAndWaitFrom(interrupted.text, interrupted.fromChunk || 0);
          } else {
            throw be;
          }
        }
      }
    } catch (e) {
      const message = e.message;
      if (/알아듣지 못했습니다/.test(message)) {
        setPhase('speaking');
        await cue('problem');
        await speakAndWait('잘 못 들었어요. 다시 말씀해 주세요.');
        continue;
      }
      setError(message);
      if (++failures >= 3) {
        await cue('problem');
        await speakAndWait('문제가 계속되어 대화 모드를 끝냅니다. 텍스트로 입력해 주세요.');
        break;
      }
    } finally {
      stopProgress();
    }
    // 스피커 소리 잔향이 마이크로 들어가지 않게 잠깐 쉰다.
    await new Promise((r) => setTimeout(r, 300));
  }
  endConversation();
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
    // 묻는 사이에 일이 끝났으면 말하지 않는다(답을 끊지 않게)
    const text = on && p && progressVoice.pick(p, userTalking || busyTalking);
    if (!text) return;
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
async function sayWhileBusy(text, voice) {
  busyTalking = true;
  voice?.cancelListening();
  await speakAndWait(text);
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
      if (!clip || !on) break;
      try {
        const r = await api.audioStop(ui.sessionId, clip);
        if (r.stopped) {
          cueStopped();
          announce('멈출게요.');
        } else if (r.result) {
          await applyResult(r.result, false);
          await sayWhileBusy(r.result.speech, voice);
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
  if (!conversationOn) {
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
    void api.cancel(ui.sessionId).catch(() => undefined);
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
    $('conv-start').focus();
    startReminders();
  }
}

/** 1단계: 안내 듣기(이 버튼 누름으로 소리 재생이 허용된다). 2단계: Enter=동의, Esc=거부 */
async function hearConsent() {
  unlockAudio();
  void preloadCues();
  setConsent('ask');
  await healthReady;
  const text = consentText();
  push({ role: 'assistant', text });
  await speakAndWait(text);
}

async function answerConsent(granted) {
  if (!ui.sessionId) return;
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
    const { text } = await api.reminders(ui.sessionId).catch(() => ({ text: null }));
    if (!text) return;
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
    if (night && !sessionStorage.getItem(`cheongeum.remindNight.${day}`)) {
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

async function send(text) {
  const t = text.trim();
  if (!t || !ui.sessionId) return;
  $('command').value = ''; // 입력창에 원문(특히 민감정보)이 남지 않게 즉시 비운다.
  // 기한 알림: '알겠어'면 그날 같은 알림 반복 안 함. 밤 안내는 지금/아침.
  const day = new Date().toDateString();
  try {
    if (/^(알겠어|알았어|알겠어요|알았어요)/.test(t)) {
      const key = `cheongeum.reminded.${day}`;
      const seen = localStorage.getItem(key);
      if (seen) localStorage.setItem(`cheongeum.remindAck.${day}`, seen);
    }
    if (/^지금/.test(t) && sessionStorage.getItem(`cheongeum.remindNight.${day}`)) {
      sessionStorage.removeItem(`cheongeum.remindNight.${day}`);
      // 곧 startReminders 주기에서 다시 읽어 말함
    }
    if (/^아침/.test(t) && sessionStorage.getItem(`cheongeum.remindNight.${day}`)) {
      localStorage.setItem(`cheongeum.remindAck.${day}`, localStorage.getItem(`cheongeum.reminded.${day}`) || 'morning');
    }
  } catch {
    /* storage */
  }
  set({ busy: true, error: undefined });
  try {
    await applyResult(await whileBusy(api.turn(ui.sessionId, t)));
  } catch (e) {
    setError(e.message);
  } finally {
    set({ busy: false });
    $('command').focus();
  }
}

async function stopAll() {
  cueStopped();
  endConversation(false);
  stopSpeaking();
  stopListening?.();
  recording?.cancel();
  recording = undefined;
  set({ listening: false });
  if (!ui.sessionId) return;
  try {
    await applyResult(await api.cancel(ui.sessionId));
  } catch (e) {
    setError(e.message);
  }
}

async function confirm(approve) {
  if (!ui.sessionId) return;
  set({ busy: true });
  try {
    await applyResult(await api.confirm(ui.sessionId, approve));
  } catch (e) {
    setError(e.message);
  } finally {
    set({ busy: false });
  }
}

async function toggleMic() {
  if (ui.voiceMode.stt) return toggleServerMic();
  if (ui.listening) {
    stopListening?.();
    return;
  }
  stopSpeaking();
  await cue('listen');
  set({ listening: true });
  announce('듣는 중입니다. 말씀하세요.');
  stopListening = browserStt.listen(
    (text) => {
      void cue('done');
      const stop = progressCues();
      void send(text).finally(stop);
    },
    (msg) => setError(msg),
    () => set({ listening: false }),
    (partial) => {
      // 중간 결과: 멈춤만 미리 반영(최종에서 확정). 서버 is_stop_utterance와 같이 부정은 빼고, 말 단위로만.
      const t = String(partial || '').trim();
      if (/(멈춰|멈추|멈춤|중지|중단|그만|정지|스톱)/.test(t) && !/(취소\s*(하지|안)|멈추지\s*마)/.test(t)) {
        stopSpeaking();
        void api.cancel(ui.sessionId).catch(() => undefined);
      }
    },
  );
}

/** 누르고 말하기: 한 번 누르면 녹음, 다시 누르면 서버로 보내 받아쓰기+실행. */
async function toggleServerMic() {
  if (!ui.sessionId) return;
  if (recording) {
    const rec = recording;
    recording = undefined;
    set({ listening: false, busy: true });
    announce('인식 중입니다.');
    const audio = await rec.stop();
    void cue('done');
    const stopProgress = progressCues();
    try {
      await applyResult(await whileBusy(api.audioTurn(ui.sessionId, audio)));
    } catch (e) {
      setError(e.message);
    } finally {
      stopProgress();
      set({ busy: false });
    }
    return;
  }
  stopSpeaking();
  set({ error: undefined });
  try {
    await cue('listen');
    recording = await startRecording();
    set({ listening: true });
    announce('듣는 중입니다. 말씀을 마치면 버튼을 다시 누르세요.');
  } catch {
    setError('마이크를 사용할 수 없습니다. 브라우저 마이크 권한을 확인하거나 텍스트로 입력하세요.');
  }
}

// ---------------------------------------------------------------- 이벤트 연결

function bind() {
  $('consent-text').textContent = consentText();
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
      b.addEventListener('click', () => void send(ex));
      li.append(b);
      return li;
    }),
  );

  $('stop-all').addEventListener('click', () => void stopAll());
  $('tts-toggle').addEventListener('click', () => {
    if (ui.tts) {
      stopSpeaking();
      set({ tts: false });
    } else set({ tts: true });
  });
  $('sound-check').addEventListener('click', () => {
    set({ error: undefined });
    speak('소리 확인입니다. 이 목소리가 들리면 음성 안내가 정상입니다.');
  });
  $('stop-speaking').addEventListener('click', stopSpeaking);
  $('contrast-toggle').addEventListener('click', () => set({ contrast: !ui.contrast }));

  $('consent-hear').addEventListener('click', () => void hearConsent());
  $('consent-yes').addEventListener('click', () => void answerConsent(true));
  $('consent-no').addEventListener('click', () => void answerConsent(false));

  $('conv-start').addEventListener('click', () => void startConversation());
  $('conv-end').addEventListener('click', () => endConversation());
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
      if (conversationOn) await speakAndWait(r.speech);
    } catch (err) {
      setError(err instanceof Error ? err.message : '언어를 바꾸지 못했습니다.');
    }
  });

  $('command-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void send($('command').value);
  });
  $('mic-btn').addEventListener('click', () => void toggleMic());
  $('talk-btn').addEventListener('click', talkNow);

  $('confirm-yes').addEventListener('click', () => void confirm(true));
  $('confirm-edit').addEventListener('click', () => $('command').focus());
  $('confirm-no').addEventListener('click', () => void confirm(false));

  // 데스크톱 앱: 전역 단축키(Cmd/Ctrl+Shift+Space)로 '지금 말하기'
  desktop?.onTalk(() => talkNow());

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
    if (ui.sessionId) api.close(ui.sessionId);
  });
}

async function start() {
  bind();
  render();
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
      $('consent-text').textContent = consentText();
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
    setError(`세션을 시작하지 못했습니다: ${e.message} — 서버(uv run cheongeum-server)가 실행 중인지 확인하세요.`);
  }
}

void start();
