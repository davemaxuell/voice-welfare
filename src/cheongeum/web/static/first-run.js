// 첫 실행 설정. 키를 넣기 전(1단계)은 녹음해 둔 문장(setup-audio)을 틀고, 키가 된 뒤(2단계)는 청음 목소리로 말한다.
// 동의 전이라 마이크는 쓰지 않는다. 대답은 숫자·Enter·Esc·스페이스 키와 버튼으로만 받는다.
import { api } from './api.js';

const LANGS = ['ko', 'en', 'zh', 'ja'];
const SPEEDS = [0.85, 1, 1.35, 1.6];
// 단계가 바뀐 직후의 키는 받지 않는다(같은 키를 두 번 눌러 다음 단계까지 답하지 않게)
const SETTLE_MS = 250;

const TEXT = {
  ko: {
    title: '청음 처음 설정', language: '대화 언어', who: '설정하는 분', key: 'OpenAI API 키', keyLabel: 'API 키',
    keyHelp: '키 받는 방법', keyLimit: 'OpenAI 계정에서 사용 한도를 정해 두세요.', keyEmpty: '키를 입력해 주세요.',
    keyHelper: 'OpenAI API 키를 붙여 넣고 Enter를 눌러 주세요.', next: '다음', back: '이전',
    keyKeep: '저장된 키가 있어요. 그대로 쓰려면 비워 두고 Enter를 누르세요.',
    self: '사용하실 분 본인', helper: '가족이나 복지관 직원', pc: '이 컴퓨터', personal: '혼자 써요', shared: '여러 사람이 써요',
    handover: '사용하실 분께 넘기기', ready: '준비됐어요', saveError: '설정을 저장하지 못했어요.',
    sound: '소리 확인', soundSay: '제 목소리가 들리시면 Enter를 눌러 주세요.', replay: '다시 듣기', heard: '잘 들려요',
    soundHelp: '소리가 안 들리면 스피커 연결과 소리 크기를 확인해 주세요.', soundCheck: '소리 확인',
    speed: '말 빠르기', speedSay: '이 정도 빠르기면 괜찮으세요? 더 천천히는 1번, 그대로는 2번, 더 빠르게는 3번.',
    slower: '더 천천히', keep: '그대로', faster: '더 빠르게',
    browser: '브라우저', browserSay: '평소 쓰는 크롬을 쓰면 사이트 로그인이 그대로 남아요. 평소 크롬은 1번, 따로 쓰는 브라우저는 2번.',
    chrome: '평소 쓰는 크롬', separate: '따로 쓰는 브라우저', browserLater: '다음에 청음을 켤 때부터 적용돼요.',
    autostart: '컴퓨터를 켤 때', autostartSay: '컴퓨터를 켤 때 청음도 함께 켤까요? 켜려면 1번, 아니면 2번.', yes: '네', no: '아니요',
    guardian: '보호자 연락처', guardianSay: '도움이 필요할 때 연락할 보호자를 적어 주세요. 건너뛰려면 Esc 대신 “건너뛰기”를 누르세요.',
    guardianName: '보호자 이름', guardianPhone: '휴대전화 번호', skip: '건너뛰기', save: '저장',
    guardianError: '이름과 휴대전화 번호를 확인해 주세요.',
  },
  en: {
    title: 'Cheongeum first-time setup', language: 'Language', who: 'Who is setting up', key: 'OpenAI API key', keyLabel: 'API key',
    keyHelp: 'How to get a key', keyLimit: 'Set a spending limit in your OpenAI account.', keyEmpty: 'Enter a key.',
    keyHelper: 'Paste the OpenAI API key and press Enter.', next: 'Next', back: 'Back',
    keyKeep: 'A key is saved. Leave this empty and press Enter to keep it.',
    self: 'The user', helper: 'Family or staff', pc: 'This computer', personal: 'Only me', shared: 'Several people',
    handover: 'Hand over', ready: 'Ready', saveError: 'The settings could not be saved.',
    sound: 'Sound check', soundSay: 'If you can hear my voice, press Enter.', replay: 'Play again', heard: 'I can hear you',
    soundHelp: 'If you hear nothing, check the speaker connection and volume.', soundCheck: 'Check sound',
    speed: 'Speech speed', speedSay: 'Is this speed comfortable? Press 1 for slower, 2 to keep it, 3 for faster.',
    slower: 'Slower', keep: 'Keep', faster: 'Faster',
    browser: 'Browser', browserSay: 'With your usual Chrome, your site logins stay. Press 1 for your usual Chrome, 2 for a separate browser.',
    chrome: 'Usual Chrome', separate: 'Separate browser', browserLater: 'This applies the next time Cheongeum starts.',
    autostart: 'At startup', autostartSay: 'Start Cheongeum when the computer starts? Press 1 for yes, 2 for no.', yes: 'Yes', no: 'No',
    guardian: 'Guardian contact', guardianSay: 'Add a guardian to contact when help is needed, or choose Skip.',
    guardianName: 'Guardian name', guardianPhone: 'Mobile number', skip: 'Skip', save: 'Save',
    guardianError: 'Check the name and mobile number.',
  },
  zh: {
    title: '青音初次设置', language: '对话语言', who: '设置人', key: 'OpenAI API 密钥', keyLabel: 'API 密钥',
    keyHelp: '如何获取密钥', keyLimit: '请在 OpenAI 账户中设定使用限额。', keyEmpty: '请输入密钥。',
    keyHelper: '粘贴 OpenAI API 密钥后按回车键。', next: '下一步', back: '上一步',
    keyKeep: '已保存密钥。要继续使用，请留空并按回车键。',
    self: '使用者本人', helper: '家人或工作人员', pc: '这台电脑', personal: '只有我用', shared: '多人共用',
    handover: '交给使用者', ready: '准备好了', saveError: '无法保存设置。',
    sound: '声音确认', soundSay: '如果能听到我的声音，请按回车键。', replay: '再听一次', heard: '听得到',
    soundHelp: '如果听不到，请检查扬声器连接和音量。', soundCheck: '声音确认',
    speed: '语速', speedSay: '这个语速可以吗？要更慢请按1，保持请按2，要更快请按3。',
    slower: '更慢', keep: '保持', faster: '更快',
    browser: '浏览器', browserSay: '使用平时的 Chrome，网站登录会保留。平时的 Chrome 请按1，单独的浏览器请按2。',
    chrome: '平时的 Chrome', separate: '单独的浏览器', browserLater: '下次启动青音时生效。',
    autostart: '开机时', autostartSay: '电脑开机时也启动青音吗？是请按1，否请按2。', yes: '是', no: '否',
    guardian: '监护人联系方式', guardianSay: '请填写需要帮助时可联系的监护人，或选择跳过。',
    guardianName: '监护人姓名', guardianPhone: '手机号码', skip: '跳过', save: '保存',
    guardianError: '请检查姓名和手机号码。',
  },
  ja: {
    title: 'チョンウムの初期設定', language: '会話の言語', who: '設定する方', key: 'OpenAI API キー', keyLabel: 'API キー',
    keyHelp: 'キーの取得方法', keyLimit: 'OpenAI アカウントで利用上限を設定してください。', keyEmpty: 'キーを入力してください。',
    keyHelper: 'OpenAI API キーを貼り付けて Enter を押してください。', next: '次へ', back: '戻る',
    keyKeep: 'キーは保存済みです。そのまま使うなら空欄のまま Enter を押してください。',
    self: 'ご本人', helper: 'ご家族・職員', pc: 'このパソコン', personal: '自分だけ', shared: '複数の人',
    handover: 'ご本人に交代', ready: '準備できました', saveError: '設定を保存できませんでした。',
    sound: '音の確認', soundSay: '私の声が聞こえたら Enter を押してください。', replay: 'もう一度', heard: '聞こえます',
    soundHelp: '聞こえない場合は、スピーカーの接続と音量を確認してください。', soundCheck: '音の確認',
    speed: '話す速さ', speedSay: 'この速さで大丈夫ですか？遅くするなら1番、このままなら2番、速くするなら3番。',
    slower: '遅く', keep: 'このまま', faster: '速く',
    browser: 'ブラウザー', browserSay: 'いつもの Chrome を使うとサイトのログインが残ります。いつもの Chrome は1番、別のブラウザーは2番。',
    chrome: 'いつもの Chrome', separate: '別のブラウザー', browserLater: '次にチョンウムを起動したときから使われます。',
    autostart: '起動時', autostartSay: 'パソコンの起動時にチョンウムも起動しますか？はいは1番、いいえは2番。', yes: 'はい', no: 'いいえ',
    guardian: '保護者の連絡先', guardianSay: '困ったときに連絡する保護者を入力するか、スキップを選んでください。',
    guardianName: '保護者の名前', guardianPhone: '携帯電話番号', skip: 'スキップ', save: '保存',
    guardianError: '名前と携帯電話番号を確認してください。',
  },
};

let manifest = null;
async function loadManifest() {
  manifest ??= await fetch('/setup-audio/manifest.json').then((r) => r.json()).catch(() => ({}));
  return manifest;
}

/**
 * deps: { desktop, speak(text, lang, rate) → Promise, stopSpeaking(), onSaved() → Promise, onConsentReady() }
 * open(stage): 1 = 언어부터, 2 = 소리 확인부터(1단계를 저장한 뒤 앱을 닫았다 연 경우)
 */
export function createFirstRun(deps) {
  const dialog = document.getElementById('first-run');
  const host = document.getElementById('first-run-steps');
  const live = document.getElementById('first-run-live');
  const state = { lang: 'ko', helper: false, key: '', deviceUse: 'personal', browser: 'separate', speed: 1.35, prefs: {} };
  let current = null;
  let history = [];
  let settling = false;
  let busy = false;
  let replays = 0;

  const t = (k) => (TEXT[state.lang] ?? TEXT.ko)[k] ?? TEXT.ko[k];
  const clip = (id) => manifest?.[id]?.[id.startsWith('lang-') ? id.slice(5) : state.lang] ?? '';

  // ---------------------------------------------------------- 소리
  let audio = null;
  let clipToken = 0;
  function stopSound() {
    clipToken++;
    audio?.pause();
    audio = null;
    deps.stopSpeaking?.();
  }
  function playOne(src) {
    return new Promise((resolve) => {
      const a = new Audio(src);
      audio = a;
      a.onended = a.onerror = a.onpause = () => resolve();
      a.play().catch(() => resolve());
    });
  }
  async function playClips(ids) {
    stopSound();
    const token = clipToken;
    for (const id of ids) {
      if (token !== clipToken) return;
      await playOne(`/setup-audio/${id.startsWith('lang-') ? id.slice(5) : state.lang}/${id}.mp3`);
    }
  }
  function say(text) {
    stopSound();
    return deps.speak(text, state.lang, state.speed).catch(() => undefined);
  }
  function announce(text) {
    live.textContent = '';
    live.textContent = text;
  }

  // ---------------------------------------------------------- 그리기
  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter(Boolean));
    return node;
  }
  function choice(label, key, act) {
    const b = el('button', { type: 'button', className: 'first-run-choice' }, el('kbd', { textContent: key === ' ' ? 'Space' : key }), ' ', label);
    b.addEventListener('click', () => answer(act));
    return b;
  }
  function backButton() {
    const b = el('button', { type: 'button', className: 'first-run-back', textContent: t('back') });
    b.addEventListener('click', () => back());
    return b;
  }

  // 단계마다: 제목, 화면 글(녹음 문장과 같음), 틀 소리, 키 → 할 일
  const STEPS = {
    language: () => ({
      title: TEXT.ko.language + ' · Language',
      text: LANGS.map((l) => clip(`lang-${l}`)).join(' · '),
      clips: LANGS.map((l) => `lang-${l}`),
      keys: Object.fromEntries(LANGS.map((l, i) => [String(i + 1), () => { state.lang = l; go('who'); }])),
      labels: LANGS.map((l) => clip(`lang-${l}`)),
    }),
    who: () => ({
      title: t('who'), text: clip('who'), clips: ['who'],
      keys: { 1: () => { state.helper = false; go('key'); }, 2: () => { state.helper = true; go('key'); } },
      labels: [t('self'), t('helper')],
    }),
    key: () => ({
      title: t('key'),
      text: [state.helper ? t('keyHelper') : clip('key-alone'), state.prefs.hasKey && t('keyKeep')].filter(Boolean).join(' '),
      clips: state.helper ? [] : ['key-alone'],
      input: 'key', submit: submitKey,
    }),
    pc: () => ({
      title: t('pc'), text: clip('pc'), clips: ['pc'],
      keys: { 1: () => afterPc('personal'), 2: () => afterPc('shared') },
      labels: [t('personal'), t('shared')],
    }),
    browser: () => ({
      title: t('browser'), text: `${t('browserSay')} ${t('browserLater')}`,
      keys: { 1: () => { state.browser = 'chrome'; void helperNext('browser'); }, 2: () => { state.browser = 'separate'; void helperNext('browser'); } },
      labels: [t('chrome'), t('separate')],
    }),
    autostart: () => ({
      title: t('autostart'), text: t('autostartSay'),
      keys: { 1: () => { deps.desktop?.setAutoStart?.(true); void helperNext('autostart'); }, 2: () => { deps.desktop?.setAutoStart?.(false); void helperNext('autostart'); } },
      labels: [t('yes'), t('no')],
    }),
    guardian: () => ({ title: t('guardian'), text: t('guardianSay'), extra: guardianForm }),
    handover: () => ({
      title: t('handover'), text: clip('handover'), clips: ['handover'],
      keys: { Enter: () => go('sound') }, labels: [], ready: true,
    }),
    // 2단계: 키가 됐으니 청음 목소리로 말한다. 아직 동의 전이라 마이크는 쓰지 않는다.
    sound: () => ({
      title: t('sound'), text: t('soundSay'), speak: true,
      keys: { Enter: () => go('speed'), ' ': () => replaySound() },
      labels: [t('heard'), t('replay')],
    }),
    speed: () => ({
      title: t('speed'), text: t('speedSay'), speak: true,
      keys: { 1: () => setSpeed(-1), 2: () => void finishStage2(), 3: () => setSpeed(1) },
      labels: [t('slower'), t('keep'), t('faster')],
      extra: () => el('p', { className: 'first-run-speed', textContent: `${state.speed}×` }),
    }),
  };

  function render(step, def) {
    const section = el('section', { className: 'first-run-step' });
    section.dataset.step = step;
    const h = el('h2', { tabIndex: -1, textContent: def.title });
    section.append(h, el('p', { className: 'first-run-text', textContent: def.text }));
    if (def.input === 'key') {
      const input = el('input', { id: 'first-run-key', type: 'password', autocomplete: 'off', spellcheck: false, maxLength: 512 });
      input.setAttribute('aria-label', t('keyLabel'));
      const form = el('form', { className: 'first-run-form' }, input, el('button', { type: 'submit', className: 'primary', textContent: t('next') }));
      form.addEventListener('submit', (e) => { e.preventDefault(); if (!settling && !busy) void def.submit(); });
      section.append(form);
      if (state.helper) {
        section.append(el('p', { className: 'hint' },
          el('a', { href: 'https://platform.openai.com/api-keys', target: '_blank', rel: 'noopener', textContent: t('keyHelp') }), ' · ', t('keyLimit')));
      }
    }
    if (def.labels?.length) {
      const keys = Object.keys(def.keys);
      section.append(el('div', { className: 'first-run-choices' }, ...def.labels.map((label, i) => choice(label, keys[i], def.keys[keys[i]]))));
    }
    if (def.ready) section.append(el('div', { className: 'first-run-choices' }, choice(t('ready'), 'Enter', def.keys.Enter)));
    if (def.extra) section.append(def.extra());
    if (history.length) section.append(backButton());
    host.replaceChildren(section);
    return { section, h };
  }

  function show(step) {
    current = step;
    const def = STEPS[step]();
    const { section, h } = render(step, def);
    settling = true;
    setTimeout(() => { settling = false; }, SETTLE_MS);
    (section.querySelector('input') ?? h).focus();
    announce(def.text);
    if (def.clips?.length) void playClips(def.clips);
    else if (def.speak) void say(def.text);
    def.enter?.();
  }

  function go(step) {
    history.push(current);
    show(step);
  }

  function back() {
    if (busy || !history.length) return;
    show(history.pop());
  }

  function answer(act) {
    if (settling || busy) return;
    stopSound();
    act();
  }

  async function submitKey() {
    const key = document.getElementById('first-run-key').value.trim();
    // '설정 다시 해줘': 저장된 키가 있으면 비워 두고 넘어가 그 키를 그대로 쓴다
    if (!key && state.prefs.hasKey) return go('pc');
    if (!key) return announce(t('keyEmpty'));
    busy = true;
    void playClips(['key-checking']);
    announce(clip('key-checking'));
    let result;
    try {
      result = (await api.checkKey(key)).result;
    } catch (e) {
      result = e.code === 'INVALID_SETTINGS' ? 'invalid' : 'network';
    }
    busy = false;
    if (result === 'ok') {
      state.key = key;
      return go('pc');
    }
    void playClips([`key-${result}`]);
    announce(clip(`key-${result}`));
    document.getElementById('first-run-key').focus();
  }

  async function afterPc(deviceUse) {
    state.deviceUse = deviceUse;
    if (deviceUse !== 'personal') state.browser = 'separate';
    if (!state.helper) {
      // 혼자 설정하면 브라우저·자동 실행·보호자는 묻지 않는다(따로 쓰는 브라우저, 자동 실행 안 함). 나중에 설정에서 바꾼다.
      if (await save()) go('sound');
      return;
    }
    void helperNext('pc');
  }

  // 도와주는 분의 순서: 키 → 이 PC → 브라우저(개인 PC) → 자동 실행(데스크톱) → 저장 → 보호자(개인 PC) → 넘기기
  async function helperNext(after) {
    const personal = state.deviceUse === 'personal';
    if (after === 'pc' && personal) return go('browser');
    if ((after === 'pc' || after === 'browser') && deps.desktop?.setAutoStart) return go('autostart');
    if (!(await save())) return;
    go(personal ? 'guardian' : 'handover');
  }

  function guardianForm() {
    const name = el('input', { id: 'first-run-guardian-name', autocomplete: 'off', maxLength: 20 });
    const phone = el('input', { id: 'first-run-guardian-phone', type: 'tel', autocomplete: 'off', maxLength: 16 });
    name.setAttribute('aria-label', t('guardianName'));
    phone.setAttribute('aria-label', t('guardianPhone'));
    const form = el('form', { className: 'first-run-form first-run-guardian' },
      el('label', {}, t('guardianName'), name), el('label', {}, t('guardianPhone'), phone),
      el('button', { type: 'submit', className: 'primary', textContent: t('save') }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (settling || busy) return;
      busy = true;
      try {
        await api.saveGuardian({ name: name.value, phone: phone.value });
        busy = false;
        go('handover');
      } catch {
        busy = false;
        announce(t('guardianError'));
        name.focus();
      }
    });
    const skip = el('button', { type: 'button', textContent: t('skip') });
    skip.addEventListener('click', () => answer(() => go('handover')));
    return el('div', { className: 'first-run-choices' }, form, skip);
  }

  // 소리 확인: 스페이스로 다시 듣기. 세 번째부터는 스피커를 확인하라는 안내를 화면에 남긴다.
  function replaySound() {
    replays++;
    if (replays >= 3 && !host.querySelector('.first-run-sound-help')) {
      host.querySelector('.first-run-step')?.append(el('p', { className: 'hint first-run-sound-help', textContent: t('soundHelp') }));
      announce(t('soundHelp'));
    }
    void say(t('soundSay'));
  }

  function setSpeed(dir) {
    const near = SPEEDS.reduce((best, s, k) => (Math.abs(s - state.speed) < Math.abs(SPEEDS[best] - state.speed) ? k : best), 0);
    state.speed = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, near + dir))];
    const shown = host.querySelector('.first-run-speed');
    if (shown) shown.textContent = `${state.speed}×`;
    announce(`${t('speed')} ${state.speed}×`);
    void say(t('speedSay'));
  }

  async function finishStage2() {
    if (await save()) await deps.onConsentReady();
  }

  async function save() {
    busy = true;
    try {
      await api.saveSettings({
        apiKey: state.key, language: state.lang, region: state.prefs.region ?? '', speed: state.speed,
        deviceUse: state.deviceUse, browser: state.browser,
        rememberService: state.deviceUse === 'personal' && state.prefs.rememberService === true,
      });
      state.key = '';
      await deps.onSaved?.();
      return true;
    } catch (e) {
      announce(`${t('saveError')} ${e.message ?? ''}`.trim());
      return false;
    } finally {
      busy = false;
    }
  }

  dialog.addEventListener('cancel', (e) => e.preventDefault());
  // 초점이 대화 상자 밖(body)에 있어도 키를 받는다(창을 다시 누르거나 그림을 다시 그리면 초점이 빠질 수 있다)
  document.addEventListener('keydown', (e) => {
    if (!dialog.open || !current) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!settling) back();
      return;
    }
    if (e.target instanceof HTMLInputElement) return;
    const act = STEPS[current]().keys?.[e.key];
    if (!act) return;
    e.preventDefault();
    answer(act);
  });

  return {
    get open() { return dialog.open; },
    async start(stage = 1, prefill) {
      await loadManifest();
      try {
        state.prefs = prefill ?? await api.settings();
      } catch {
        state.prefs = {};
      }
      state.lang = state.prefs.language ?? 'ko';
      state.speed = Number(state.prefs.speed) || 1.35;
      state.deviceUse = state.prefs.deviceUse === 'shared' ? 'shared' : 'personal';
      state.browser = state.prefs.browser ?? 'separate';
      history = [];
      replays = 0;
      deps.desktop?.showSetup?.();
      if (!dialog.open) dialog.showModal();
      dialog.lang = state.lang;
      show(stage === 2 ? 'sound' : 'language');
    },
    finish() {
      stopSound();
      dialog.close();
      current = null;
    },
  };
}
