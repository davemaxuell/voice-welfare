// 화면 위 아바타에는 현재 선택지와 짧은 안내만 표시한다.
// 입력값·파일 이름·받아쓴 글·화면 원문은 넣지 않는다. 승인 내용은 대화 창의 검토 화면에서 본다.
import { workspaceText } from './workspace-language.js';

export const APPROVE_LABELS = {
  'vault-save': '내 정보 저장',
  'vault-clear': '내 정보 삭제',
  'public-research': '자료 조사 승인',
  'field-entry': '입력 승인',
  click: '누르기 승인',
  'file-transfer': '파일 전송 승인',
  'visual-navigation': '화면 사진 전송 승인',
  'practice-submission': '모의접수 승인',
};

// 승인 카드의 질문은 동작 종류로만 만든다(누를 버튼 이름 같은 화면 글은 항상 위에 뜨는 창에 두지 않는다. '내용 확인'에서 본다).
const APPROVE_PROMPTS = {
  'vault-save': '내 정보를 저장할까요?',
  'vault-clear': '저장된 내 정보를 모두 지울까요?',
  'public-research': '질문을 저장하고 조사를 맡길까요?',
  'field-entry': '입력란을 채울까요?',
  click: '버튼을 누를까요?',
  'file-transfer': '받은 파일을 보낼까요?',
  'visual-navigation': '링크를 찾으려고 화면 사진을 보낼까요?',
  'practice-submission': '모의접수를 할까요?',
};

const AUTH_PROMPTS = {
  login: '{site}에서 직접 로그인해 주세요.',
  verification: '{site}에서 직접 인증해 주세요.',
  captcha: '{site}에서 보안 확인을 직접 해 주세요.',
};

/**
 * 카드: key가 같으면 같은 결정이다(선택지 묶음 번호를 유지한다). ref는 서버 쪽 참조로, 대화 창 밖으로 보내지 않는다.
 * open이 있는 선택지는 고르면 대화 창을 그 자리(focus)로 연다.
 */
export function currentDecision(ui) {
  if (!ui.sessionId) return undefined;
  const t = text => workspaceText(text, ui.lang);
  if (ui.consent === 'intro' || ui.consent === 'ask') {
    return {
      key: 'consent',
      kind: 'consent',
      prompt: t('시작 전 안내를 듣고 동의해 주세요.'),
      choices: [
        { key: 'consent-yes', label: t('동의하고 음성 대화 시작') },
        { key: 'consent-no', label: t('동의하지 않음') },
        { key: 'review', label: t('안내 보기'), open: 'consent' },
      ],
    };
  }
  const last = ui.last;
  const pending = ui.state === 'WAITING_FOR_USER_CONFIRMATION' ? last?.pendingConfirmation : undefined;
  if (pending) {
    return {
      key: `approval:${pending.actionId}`,
      kind: 'approval',
      prompt: t(APPROVE_PROMPTS[pending.kind] ?? '이 동작을 진행할까요?'),
      site: pending.site,
      choices: [
        { key: 'approve', label: t(APPROVE_LABELS[pending.kind] ?? '이 동작 승인') },
        { key: 'review', label: t('내용 확인'), open: 'confirm' },
        { key: 'reject', label: t('취소') },
      ],
      ref: { actionId: pending.actionId },
    };
  }
  const offered = last?.offeredChoices ?? [];
  if (!offered.length) return undefined;
  const handoff = last.authHandoff?.status === 'waiting' ? last.authHandoff : undefined;
  return {
    key: `offer:${last.turnId}`,
    kind: 'offer',
    prompt: handoff ? t(AUTH_PROMPTS[handoff.kind] ?? AUTH_PROMPTS.login).replace('{site}', () => handoff.site)
      : t(offered.length === 1 && offered[0].key === 'read-main' ? '이 페이지의 본문을 읽어 드릴까요?' : '이 화면에서 할 수 있는 일이에요.'),
    choices: offered.slice(0, 3).map(({ key, label }) => ({ key, label })),
    ref: { turnId: last.turnId, handoffId: handoff?.id },
  };
}

// Only surface public catalogue names and app-authored cues. A reply can contain
// form values, screen contents or dictation even when its intent is informational.
export function turnNotice(turn) {
  if (!turn.speech || turn.semanticAction === 'stop' || turn.intentType === 'STOP' || turn.pendingConfirmation || turn.offeredChoices?.length
      || turn.semanticAction === 'consent' || turn.intentType === 'CONSENT') return null;
  const t = text => workspaceText(text, turn.lang);
  if (turn.semanticAction === 'set-language') return turn.speech;
  if (turn.answerCard?.grounded && turn.answerCard.serviceName) {
    return t('{service} 안내를 찾았어요. 저를 누르면 답변과 출처를 볼 수 있어요.')
      .replace('{service}', () => turn.answerCard.serviceName);
  }
  if (turn.state === 'VALIDATION_ERROR') return t('확인이 필요한 입력란이 있어요. 저를 눌러 확인해 주세요.');
  if (turn.state === 'AWAITING_FIELD_VALUE') return t('입력할 새 값을 말씀해 주세요.');
  if (turn.semanticAction === 'clarify' || turn.state === 'NEEDS_CLARIFICATION') {
    const [first, second] = turn.publicSuggestions ?? [];
    if (second) return t('1번 {first}, 2번 {second} 중 어느 쪽인가요?').replace('{first}', () => first).replace('{second}', () => second);
    if (first) return t('“{first}” 말씀이세요?').replace('{first}', () => first);
    return t('어떤 뜻인지 확인하고 싶어요. 저를 눌러 질문을 보고 답해 주세요.');
  }
  if (turn.verification?.fieldValueMatches) return t('입력했어요. 다음 항목으로 가려면 “다음으로”라고 말씀해 주세요.');
  if (turn.state === 'MOCK_SUBMITTED') return t('연습 신청을 마쳤어요. 저를 누르면 결과를 볼 수 있어요.');
  return t('답변이 도착했어요. 저를 누르면 읽을 수 있어요.');
}

/** 한 줄 상태와 모드. 모드 순서가 곧 우선순위다. */
const MODES = [
  ['starting', (ui) => !ui.sessionId && ui.consent === 'loading' && !ui.error, () => '청음을 준비하는 중이에요.'],
  ['ended', (ui) => !ui.sessionId && !ui.error, () => '이용을 마쳤어요. 다시 시작하려면 저를 눌러 대화를 여세요.'],
  ['consent', (ui) => ui.consent === 'intro' || ui.consent === 'ask', () => '시작 전에 동의가 필요해요.'],
  ['auth-handoff', (ui) => ui.last?.authHandoff?.status === 'waiting', () => '사이트에서 직접 진행해 주세요.'],
  ['choice', (_ui, live) => !!live.card, () => '선택을 기다리고 있어요.'],
  ['problem', (ui) => !!ui.error, (ui) => String(ui.error).slice(0, 120)],
  ['ready', (_ui, live) => live.sleeping, () => '멈췄어요.'],
  ['working', (ui) => ui.busy || ui.phase === 'thinking' || ui.phase === 'starting', () => '처리하는 중이에요.'],
  ['speaking', (ui, live) => live.speaking || ui.phase === 'speaking', () => '말하는 중이에요.'],
  ['listening', (ui, live) => ui.phase === 'listening' || ui.phase === 'hearing' || ui.listening || live.recording, () => '듣는 중이에요. 말씀하세요.'],
  ['ready', () => true, (ui, live) => {
    if (ui.consent === 'declined') return '음성 대화는 꺼져 있어요. 저를 누르면 글로 물어볼 수 있어요.';
    if (live.capture === 'on') return '대화 중이에요.';
    return '기다리고 있어요.';
  }],
];

/**
 * 아바타 창에 보내는 표시 상태.
 * live: { capture: 'on'|'off', speaking, recording, message, card, pending } — ui 밖에서 대화 창이 알고 있는 것.
 */
export function desktopView(ui, live) {
  const [mode, , status] = MODES.find(([, when]) => when(ui, live));
  const card = live.card;
  const busy = !!ui.busy || ui.phase === 'thinking';
  const sleeping = !!live.sleeping && mode === 'ready';
  return {
    connected: true,
    mode,
    capture: live.capture,
    speaking: live.speaking || ui.phase === 'speaking',
    busy,
    sleeping,
    // 청음 소개 중이면 줄마다 정한 동작(말하는 동안에도 이 동작을 보인다)
    introPose: live.introPose ?? null,
    resting: mode === 'ready' && ui.consent === 'granted' && live.capture === 'off' && !busy && !live.speaking && !card,
    lang: ui.lang,
    state: ui.state,
    reading: ui.state === 'BROWSING' && ui.last?.semanticAction === 'read-main',
    status: workspaceText(status(ui, live), ui.lang),
    message: card || !ui.sessionId || mode === 'problem' || sleeping ? null : live.message ?? null,
    prompt: card?.prompt ?? null,
    site: card?.site ?? null,
    choiceSetId: card?.id ?? null,
    choices: card ? card.choices.map(({ key, label, open }) => (open ? { key, label, open } : { key, label })) : [],
    pending: !!card && live.pending,
  };
}
