// 아바타 창: 대화 창이 보낸 표시 상태를 그리고, 누른 버튼을 이름으로만 돌려보낸다(세션·마이크·재생은 대화 창이 맡는다).
const bridge = window.cheongeumOverlay;
const $ = (id) => document.getElementById(id);

const OFFLINE = { connected: false, capture: 'off', speaking: false, busy: false, choices: [], choiceSetId: null };
let snap = OFFLINE;
let order = { instance: undefined, revision: -1 };
let shownSet = null;
let receivedSnapshot = false;
let bubble = null;
let messageInstance;
const seenMessages = new Set();
let readTimer;
let readUntil = 0;
let readingTime = 0;
let lang;
const chromeText = {
  ko: { talk: '말하기', stop: '멈춰', hide: '숨기기', avatar: '청음 대화 열기', micOn: '마이크 켜짐', micOff: '마이크 꺼짐', on: '켜짐', off: '꺼짐', site: '대상', offline: '대화 창과 연결이 끊겼어요. 저를 누르면 대화 창을 열어요.', title: '청음 도우미' },
  en: { talk: 'Talk', stop: 'Stop', hide: 'Hide', avatar: 'Open Cheongeum chat', micOn: 'Mic on', micOff: 'Mic off', on: 'On', off: 'Off', site: 'Site', offline: 'The chat is disconnected. Select Cheongeum to open it.', title: 'Cheongeum assistant' },
  zh: { talk: '说话', stop: '停止', hide: '隐藏', avatar: '打开青音对话', micOn: '麦克风已开', micOff: '麦克风已关', on: '已开', off: '已关', site: '网站', offline: '对话连接已断开。点击青音可打开对话。', title: '青音助手' },
  ja: { talk: '話す', stop: '停止', hide: '隠す', avatar: 'チョンウムとの会話を開く', micOn: 'マイクオン', micOff: 'マイクオフ', on: 'オン', off: 'オフ', site: '対象', offline: '会話画面との接続が切れました。チョンウムを押すと会話画面が開きます。', title: 'チョンウムアシスタント' },
};
const choiceIcons = new Map([
  ['consent-yes', 'yes'], ['approve', 'yes'], ['auth-done', 'yes'],
  ['consent-no', 'no'], ['reject', 'no'], ['auth-cancel', 'no'],
  ['review', 'review'], ['read-main', 'read'],
]);

// 캐릭터: 움직이지 않는 아바타 설정이나 운영체제의 '애니메이션 줄이기'면 정지 그림. 3D를 못 쓰면 역시 정지 그림.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let prefs = { still: false };
let character = null;

// 자세: 모드·세션 상태 → 동작 이름(graphics/animations/index.html의 대응표). 말하는 동안은 언제나 'speaking'.
const MODE_POSES = { 'auth-handoff': 'auth-handoff', choice: 'confirmation', consent: 'confirmation', working: 'thinking', listening: 'listening', problem: 'try-again' };
const STATE_POSES = {
  AWAITING_CONSENT: 'confirmation', LISTENING: 'listening',
  TRANSCRIBED: 'thinking', INTENT_DETECTED: 'thinking', OBSERVING: 'screen-reading',
  PLANNING: 'thinking', POLICY_CHECK: 'thinking', EXECUTING: 'thinking', VERIFYING: 'thinking',
  WAITING_FOR_USER_CONFIRMATION: 'confirmation', NEEDS_CLARIFICATION: 'confirmation', AWAITING_FIELD_VALUE: 'confirmation',
  AUTH_HANDOFF: 'auth-handoff', VALIDATION_ERROR: 'try-again', RECOVERING: 'try-again',
  PAUSED: 'stopped', DONE: 'complete', MOCK_SUBMITTED: 'complete',
};
function poseFor(s) {
  if (s.introPose) return s.introPose;
  if (!s.connected || s.mode === 'starting' || s.mode === 'ended') return 'ready';
  if (s.mode === 'working' && s.state === 'OBSERVING') return 'screen-reading';
  return MODE_POSES[s.mode] ?? STATE_POSES[s.state] ?? (s.reading ? 'screen-reading' : 'ready');
}
// 정지 그림이 따로 없는 동작은 가까운 그림으로
const POSTER = { welcome: 'ready' };
const sleeping = (s) => !!s.connected && (s.sleeping ?? (s.mode === 'ready' && s.state === 'STOPPED'));

function updatePoster(s) {
  if (sleeping(s)) return;
  const pose = s.speaking && !s.introPose ? 'speaking' : poseFor(s);
  const src = `/avatar/poses/${POSTER[pose] ?? pose}.webp`;
  const still = $('still');
  if (still.getAttribute('src') !== src) still.src = src;
}

function showSurface(available) {
  $('figure').dataset.renderer = available ? 'webgl' : 'image';
  if (!available) {
    updatePoster(snap);
    Object.assign($('figure').dataset, { pose: 'still', clip: '' });
  }
  $('character').hidden = !available;
  $('still').hidden = available;
  $('sleeping-still').hidden = available;
}

function animate(prev, next) {
  const asleep = sleeping(next);
  $('overlay').dataset.pose = asleep ? 'sleeping' : next.speaking && !next.introPose ? 'speaking' : poseFor(next);
  $('figure').dataset.sleeping = String(asleep);
  if ($('figure').dataset.renderer === 'image') updatePoster(next);
  if (!character) return;
  // The spoken stop acknowledgement can finish while the character already sleeps.
  if (asleep) return character.pose('sleeping', { interrupt: true });
  // 청음 소개: 줄이 바뀔 때마다 그 줄의 동작을 처음부터
  if (next.introPose) return next.introPose === prev.introPose ? undefined : character.pose(next.introPose, { interrupt: true });
  if (next.speaking) return character.speak();
  const pose = poseFor(next);
  if (sleeping(prev) || character.waking) return character.pose(pose, { interrupt: true });
  if (next.connected && prev.capture !== 'on' && next.capture === 'on') return character.cue('welcome', pose);
  if (prev.mode === 'listening' && next.mode === 'working') return character.cue('voice-captured', pose);
  // 말이 그치면(끝나거나 끊기면) 입을 닫고 듣는 쪽으로 돌아선다
  if (prev.speaking) return character.cue('your-turn', pose);
  character.pose(pose);
}
let figureSetup = 0;

async function setupFigure() {
  const setup = ++figureSetup;
  const still = prefs.still || reducedMotion.matches;
  if (still) {
    character?.dispose();
    character = null;
  } else if (!character) {
    try {
      const { createCharacter } = await import('/avatar/character.js');
      if (setup !== figureSetup) return;
      // 새 캔버스에 그린다(이전 렌더러가 쓰던 WebGL 문맥을 다시 쓰지 않게)
      const canvas = $('character').cloneNode(false);
      $('character').replaceWith(canvas);
      const made = await createCharacter(canvas, (pose, clip) => {
        if (setup === figureSetup && (!character || character.surfaceAvailable)) {
          Object.assign($('figure').dataset, { pose, clip });
          queueGeometry();
        }
      }, (available) => {
        if (setup === figureSetup) showSurface(available);
      });
      if (setup !== figureSetup) return made?.dispose();
      character = made;
    } catch {
      if (setup !== figureSetup) return;
      character = null;
    }
  }
  if (setup !== figureSetup) return;
  showSurface(!!character?.surfaceAvailable);
  animate(snap, snap);
}

function accept(next) {
  if (!next || next.connected === false) {
    order = { instance: undefined, revision: -1 };
    return OFFLINE;
  }
  if (next.instance === order.instance && next.revision <= order.revision) return null;
  order = { instance: next.instance, revision: next.revision };
  return next;
}

function render() {
  const live = snap.connected;
  const root = $('overlay');
  const focused = document.hasFocus() && root.contains(document.activeElement) ? document.activeElement : null;
  root.dataset.mode = live ? snap.mode : 'offline';
  root.dataset.speaking = String(!!snap.speaking);
  const resting = snap.resting === true;
  root.classList.toggle('resting', resting);
  root.classList.toggle('stopped', sleeping(snap));
  const language = (snap.lang || lang || 'ko').toLowerCase().split('-')[0];
  const copy = chromeText[language] ?? chromeText.ko;
  if (lang !== language) {
    lang = language;
    document.documentElement.lang = chromeText[lang] ? lang : 'ko';
    document.title = copy.title;
    for (const id of ['talk', 'stop', 'hide', 'avatar']) {
      $(id).setAttribute('aria-label', copy[id]);
      $(id).title = copy[id];
    }
  }
  $('mic').dataset.capture = snap.capture;
  const micLabel = snap.capture === 'on' ? copy.micOn : copy.micOff;
  setText($('mic-text'), micLabel);
  setText($('mic-short'), snap.capture === 'on' ? copy.on : copy.off);
  $('mic').title = micLabel;
  const status = live ? snap.status : copy.offline;
  // 동의는 카드의 '동의하고 음성 대화 시작'으로만(말하기 버튼이 동의가 되지 않게)
  $('talk').disabled = !live || ['ended', 'starting', 'consent', 'auth-handoff'].includes(snap.mode);
  $('stop').hidden = !live || !(snap.busy || snap.speaking || snap.capture === 'on');
  root.classList.toggle('has-stop', !$('stop').hidden);
  renderCard(status, copy);
  setText($('status'), bubble ? $('card-prompt').textContent : status);
  if (focused && (!focused.isConnected || focused.disabled || focused.closest('[hidden], [inert]'))) focusFirst();
  queueGeometry();
}

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value ?? '';
}

function pauseReading() {
  if (readTimer === undefined) return;
  clearTimeout(readTimer);
  readTimer = undefined;
  readingTime = Math.max(0, readUntil - performance.now());
}

function resumeReading() {
  if (bubble?.kind !== 'message' || $('overlay').inert || readTimer !== undefined || $('card').matches(':hover, :focus-within')) return;
  readUntil = performance.now() + readingTime;
  readTimer = setTimeout(closeBubble, readingTime);
}

// Reverse the same timeline so a new request starts at the exact frame on screen.
function revealMotion(element, frames, duration, initiallyOpen) {
  let open = initiallyOpen;
  let animation;
  let settled;
  function finish() {
    const previous = animation;
    const callback = settled;
    animation = settled = undefined;
    if (previous) previous.onfinish = null;
    callback?.();
    previous?.cancel();
  }
  function set(next, animate, callback) {
    const changed = next !== open;
    open = next;
    settled = callback;
    if (!animate || prefs.still || reducedMotion.matches || (!changed && !animation)) return finish();
    if (!changed) return;
    if (!animation) {
      animation = element.animate(frames, { duration, easing: 'cubic-bezier(.22,.72,.26,1)', fill: 'both' });
      animation.pause();
      animation.currentTime = open ? 0 : duration;
      const run = animation;
      run.onfinish = () => {
        if (animation === run && run.playState === 'finished') finish();
      };
    }
    const time = Number(animation.currentTime);
    if (open ? time >= duration : time <= 0) return finish();
    animation.playbackRate = open ? 1 : -1.25;
    animation.play();
  }
  return { set, finish };
}

const bubbleMotion = revealMotion(document.querySelector('.bubble'), [
  { opacity: 0, transform: 'translateY(5px) scale(.94)' },
  { opacity: 1, transform: 'none' },
], 210, false);

function closeBubble() {
  if (!bubble) return;
  bubble = null;
  pauseReading();
  const card = $('card');
  card.inert = true;
  bubbleMotion.set(false, true, () => {
    card.hidden = true;
    shownSet = null;
    $('choices').replaceChildren();
    delete $('choices').dataset.set;
    reportSize();
  });
}

function showBubble(kind, key, prompt) {
  const changed = bubble?.kind !== kind || bubble.key !== key;
  const card = $('card');
  card.dataset.kind = kind;
  card.hidden = false;
  card.inert = false;
  setText($('card-prompt'), prompt);
  if (!changed) return;
  pauseReading();
  bubble = { kind, key };
  card.querySelector('.bubble-body').tabIndex = kind === 'choices' ? -1 : 0;
  card.querySelector('.bubble-body').scrollTop = 0;
  shownSet = null;
  delete $('choices').dataset.set;
  $('choices').replaceChildren();
  $('card-site').hidden = true;
  bubbleMotion.set(true, true);
  if (kind === 'message') {
    readingTime = Math.min(30000, Math.max(8000, prompt.length * 110));
    resumeReading();
  }
}

function renderCard(status, copy) {
  const message = snap.message;
  if (snap.connected && snap.instance !== messageInstance) {
    seenMessages.clear();
    messageInstance = snap.instance;
  }
  const choices = snap.choices ?? [];
  if (choices.length) {
    if (message?.id) seenMessages.add(message.id);
    showBubble('choices', JSON.stringify([snap.instance, snap.choiceSetId, lang]), snap.prompt ?? '');
    if (shownSet !== snap.choiceSetId) {
      shownSet = snap.choiceSetId;
      $('choices').dataset.set = snap.choiceSetId;
      $('choices').replaceChildren(...choices.map((choice) => choiceButton(snap.choiceSetId, choice)));
    }
    $('card-site').hidden = !snap.site;
    setText($('card-site'), snap.site ? `${copy.site}: ${snap.site}` : '');
    for (const b of $('choices').querySelectorAll('button')) b.disabled = !b.dataset.open && (!!snap.pending || !!snap.busy);
    return;
  }
  if ((receivedSnapshot && !snap.connected) || ['problem', 'auth-handoff', 'ended'].includes(snap.mode)) {
    if (message?.id) seenMessages.add(message.id);
    showBubble('status', status, status);
    return;
  }
  if (message?.id && message.text && !sleeping(snap)) {
    const key = JSON.stringify([snap.instance, message.id]);
    if ((bubble?.kind === 'message' && bubble.key === key) || !seenMessages.has(message.id)) {
      seenMessages.add(message.id);
      showBubble('message', key, message.text);
      return;
    }
  }
  if (message?.id) seenMessages.add(message.id);
  closeBubble();
}

function choiceButton(choiceSetId, choice) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = choice.label;
  const iconName = choiceIcons.get(choice.key);
  if (iconName) {
    const icon = $('choice-icon').content.firstElementChild.cloneNode(true);
    icon.querySelector('use').setAttribute('href', `#i-${iconName}`);
    b.prepend(icon);
  }
  b.dataset.key = choice.key;
  if (choice.open) b.dataset.open = choice.open;
  b.addEventListener('click', () => {
    if ($('card').inert || !b.isConnected || b.disabled || shownSet !== choiceSetId) return;
    if (choice.open) return bridge.open(choice.open);
    bridge.choose(choiceSetId, choice.key);
    bridge.release();
  });
  return b;
}

let lastGeometry;
let geometryFrame;
function queueGeometry() {
  if (geometryFrame !== undefined) return;
  geometryFrame = requestAnimationFrame(() => {
    geometryFrame = undefined;
    reportSize();
  });
}

function reportSize() {
  const root = $('overlay');
  const box = root.getBoundingClientRect();
  const regions = [];
  function include(element, xPadding, yPadding) {
    // Electron also clips painting to these hit rectangles. Use layout coordinates
    // so the native shape stays large enough throughout a visual scale or slide.
    let left = 0;
    let top = 0;
    for (let node = element; node && node !== root; node = node.offsetParent) {
      left += node.offsetLeft;
      top += node.offsetTop;
    }
    const x = Math.max(0, left - xPadding);
    const y = Math.max(0, top - yPadding);
    regions.push({
      x, y,
      width: Math.min(Math.ceil(box.width), left + element.offsetWidth + xPadding) - x,
      height: Math.min(Math.ceil(box.height), top + element.offsetHeight + yPadding) - y,
    });
  }
  include($('avatar'), 5, 6);
  include(document.querySelector('.panel'), 5, 6);
  if (!$('card').hidden) include($('card'), 6, 11);
  const geometry = [Math.ceil(box.width), Math.ceil(box.height), regions];
  const signature = JSON.stringify(geometry);
  if (lastGeometry === signature) return;
  lastGeometry = signature;
  bridge.resize(...geometry);
}

function focusFirst() {
  if ($('overlay').inert) return;
  const choice = bubble?.kind === 'choices' && $('choices').querySelector('button:enabled');
  const target = choice || ($('talk').disabled ? $('avatar') : $('talk'));
  target.focus({ preventScroll: true });
}

$('avatar').addEventListener('click', () => bridge.open());
$('talk').addEventListener('click', () => bridge.talk());
$('stop').addEventListener('click', () => bridge.stop());
$('hide').addEventListener('click', () => bridge.hide());
$('card').addEventListener('pointerenter', pauseReading);
$('card').addEventListener('pointerleave', resumeReading);
$('card').addEventListener('focusin', pauseReading);
$('card').addEventListener('focusout', () => queueMicrotask(resumeReading));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (bubble?.kind === 'message') closeBubble();
    bridge.release();
  }
});

// The window stays hidden until the first native visibility command.
const overlay = $('overlay');
const widgetMotion = revealMotion(overlay, [
  { '--companion-reveal': '0' }, { '--companion-reveal': '1' },
], 235, !bridge.onVisibility);

function finishMotion() {
  bubbleMotion.finish();
  widgetMotion.finish();
}

bridge.onSnapshot((next) => {
  const accepted = accept(next);
  if (!accepted) return;
  receivedSnapshot = true;
  const prev = snap;
  snap = accepted;
  animate(prev, snap);
  render();
});
bridge.onPrefs((next) => {
  const root = $('overlay');
  root.dataset.corner = next.corner;
  root.dataset.still = String(!!next.still);
  if (next.maxWidth > 0) root.style.setProperty('--available-width', next.maxWidth + 'px');
  if (next.maxHeight > 0) root.style.setProperty('--available-height', next.maxHeight + 'px');
  const changed = next.still !== prefs.still || figureSetup === 0;
  prefs = next;
  if (prefs.still) finishMotion();
  if (changed) void setupFigure();
  else character?.refreshResolution();
  reportSize();
});
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) finishMotion();
  void setupFigure();
});

if (bridge.onVisibility) {
  overlay.dataset.concealed = '';
  overlay.inert = true;
  bridge.onVisibility(({ visible, id, animate }) => {
    delete overlay.dataset.concealed;
    overlay.dataset.presenting = '';
    overlay.inert = !visible;
    if (visible) resumeReading();
    else pauseReading();
    widgetMotion.set(visible, animate, () => {
      delete overlay.dataset.presenting;
      overlay.toggleAttribute('data-concealed', !visible);
      if (!visible) bridge.visibilityDone(id);
    });
    if (visible) {
      reportSize();
      bridge.visibilityDone(id);
    }
  });
}

bridge.onFocus(focusFirst);
const sizeObserver = new ResizeObserver(reportSize);
sizeObserver.observe(overlay);
sizeObserver.observe($('card'));
render();
bridge.ready();
