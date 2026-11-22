// 아바타 창 E2E: node apps/desktop/test/avatar.e2e.cjs [시나리오 이름…]
// 실제 Electron 앱을 띄워 아바타 창과 대화 창이 세션 하나를 함께 쓰는지 확인한다(창이 잠깐 화면에 뜬다).
const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { launch, windows, until } = require('./harness.cjs');

const isController = (w) => w.url.includes('desktop=1');
const isOverlay = (w) => w.url.includes('/avatar/');

async function overlayState(overlay) {
  return overlay.evaluate(() => ({
    mode: document.getElementById('overlay').dataset.mode,
    speaking: document.getElementById('overlay').dataset.speaking === 'true',
    mic: document.getElementById('mic-text').textContent,
    status: document.getElementById('status').textContent,
    prompt: document.querySelector('#choices button') ? document.getElementById('card-prompt').textContent : null,
    choices: [...document.querySelectorAll('#choices button')].map((b) => ({ label: b.textContent, disabled: b.disabled })),
    stop: !document.getElementById('stop').hidden,
  }));
}

async function logLines(controller) {
  return controller.locator('#log li').allInnerTexts();
}

/** 대화 창에 글로 명령한다(창이 숨어 있어도 같은 입력란). */
async function type(controller, text) {
  const box = controller.locator('#command');
  await until(async () => box.isEnabled(), { what: 'command box' });
  await until(async () => !(await controller.locator('#send').isDisabled()), { what: 'send enabled' });
  await box.fill(text);
  await box.press('Enter');
  await until(async () => !(await controller.locator('#send').isDisabled()), { timeout: 30000, what: `turn "${text}"` });
}

async function consentByOverlay(overlay) {
  const yes = overlay.getByRole('button', { name: '동의하고 음성 대화 시작' });
  await yes.waitFor({ timeout: 60000 });
  await yes.click();
  await until(async () => (await overlayState(overlay)).prompt === null, { what: 'consent card gone' });
}

async function cardSet(overlay) {
  return overlay.locator('#choices').getAttribute('data-set');
}

async function figureOnScreen(app, overlay) {
  const origin = (await windows(app)).find(isOverlay).bounds;
  const { x, y, width, height } = await overlay.locator('#figure').boundingBox();
  return { x: origin.x + x, y: origin.y + y, width, height };
}

async function liveTracks(controller) {
  return controller.evaluate(() => (window.__tracks ?? []).filter((t) => t.readyState === 'live').length);
}

async function trackReport(controller) {
  return controller.evaluate(() => (window.__tracks ?? []).map((t) => `${t.readyState}:echo=${t.getSettings().echoCancellation}`).join(' '));
}

async function fills(server) {
  const { events } = await server('/api/events');
  return events.filter((e) => e.actionType === 'fill' && e.success).length;
}

const INTRO_POSES = ['welcome', 'listening', 'screen-reading', 'confirmation', 'auth-handoff', 'stopped', 'complete'];

/** 아바타의 data-pose가 바뀔 때마다 기록한다(같은 것이 이어지면 한 번만). */
async function recordPoses(overlay) {
  await overlay.evaluate(() => {
    const root = document.getElementById('overlay');
    window.__poses = [];
    new MutationObserver(() => {
      const pose = root.dataset.pose;
      if (window.__poses.at(-1) !== pose) window.__poses.push(pose);
    }).observe(root, { attributes: true, attributeFilter: ['data-pose'] });
  });
}

const scenarios = {
  async soak({ app, controller, overlay, errors }) {
    const dir = path.resolve(__dirname, '../../../reports/ux');
    await mkdir(dir, { recursive: true });
    const samples = [];
    async function sample(cycle, phase) {
      const processes = await app.evaluate(({ app, BrowserWindow }) => {
        const roles = new Map([[process.pid, 'main']]);
        for (const w of BrowserWindow.getAllWindows()) {
          const url = w.webContents.getURL();
          if (url.includes('desktop=1')) roles.set(w.webContents.getOSProcessId(), 'conversation');
          if (url.includes('/avatar/')) roles.set(w.webContents.getOSProcessId(), 'overlay');
        }
        return app.getAppMetrics().map(({ pid, type, name, cpu, memory }) => ({
          pid, role: roles.get(pid) ?? (name === '청음 서비스' ? 'service' : type),
          cpuPercent: cpu.percentCPUUsage, workingSetKiB: memory.workingSetSize,
        }));
      });
      for (const role of ['main', 'service', 'conversation', 'overlay']) {
        assert.ok(processes.some(p => p.role === role), `측정할 프로세스가 없습니다: ${role}`);
      }
      samples.push({ cycle, phase, time: Date.now(), processes });
    }
    // 숨기기 뒤 갱신된 트레이 메뉴에서 실제 '아바타 보이기' 동작을 고른다.
    await app.evaluate(({ Menu }) => {
      const build = Menu.buildFromTemplate;
      Menu.buildFromTemplate = function (template) {
        const toggle = template.find(item => item.label === '아바타 보이기');
        if (toggle) globalThis.__soakShow = () => toggle.click({ checked: true });
        return build.call(this, template);
      };
    });
    await consentByOverlay(overlay);
    const stop = overlay.getByRole('button', { name: '멈춰' });
    const talk = overlay.getByRole('button', { name: '말하기' });
    const visible = async () => (await windows(app)).find(isOverlay).visible;
    await until(async () => await liveTracks(controller) > 0, { what: '합성 마이크 시작' });
    await stop.click();
    await until(async () => await liveTracks(controller) === 0, { what: '초기 마이크 종료' });
    await sample(0, 'idle');
    for (let cycle = 1; cycle <= 20; cycle++) {
      await overlay.getByRole('button', { name: '숨기기' }).click();
      await until(async () => !await visible(), { what: '아바타 숨김' });
      await app.evaluate(() => globalThis.__soakShow());
      await until(visible, { what: '아바타 표시' });
      await talk.click();
      await until(async () => await liveTracks(controller) > 0, { what: '합성 마이크 시작' });
      await sample(cycle, 'talk');
      await stop.click();
      await until(async () => await liveTracks(controller) === 0, { what: '마이크 트랙 해제' });
      await sample(cycle, 'stopped');
    }
    assert.deepEqual(errors, []);
    await writeFile(path.join(dir, 'soak.json'), JSON.stringify(samples, null, 2));
    await overlay.screenshot({ path: path.join(dir, 'soak.png') });
    return { cycles: 20, samples: samples.length };
  },
  // 청음 소개: 줄마다 정한 동작을 차례로 보인다(말하는 동안에도 'speaking'이 아니라 그 동작)
  async intro({ controller, overlay }) {
    await consentByOverlay(overlay);
    await recordPoses(overlay);
    await type(controller, '청음 소개 다시 해줘');
    await until(async () => (await overlay.evaluate(() => window.__poses)).includes('complete'), { timeout: 60000, what: 'intro reaches its last pose' });
    const poses = await overlay.evaluate(() => window.__poses);
    let at = -1;
    for (const pose of INTRO_POSES) {
      const i = poses.indexOf(pose, at + 1);
      assert.ok(i > at, `pose ${pose} in order: ${poses.join(' ')}`);
      at = i;
    }
    return { poses: poses.join(' ') };
  },

  // 움직이지 않는 아바타 설정: 소개 중에도 정지 그림
  async 'intro-still'({ controller, overlay }) {
    await consentByOverlay(overlay);
    await type(controller, '청음 소개 다시 해줘');
    await until(async () => (await overlay.evaluate(() => document.getElementById('overlay').dataset.pose)) === 'listening',
      { timeout: 60000, what: 'intro second line' });
    assert.equal(await overlay.locator('#figure').getAttribute('data-pose'), 'still');
    return {};
  },

  async visibility({ app, overlay, errors }) {
    const native = async () => (await windows(app)).find(isOverlay);
    await until(async () => (await native()).visible, { what: 'initial overlay paint' });
    const origin = await overlay.evaluate(() => performance.timeOrigin);
    await app.evaluate(({ BrowserWindow, Menu, ipcMain }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/avatar/'));
      const trace = globalThis.__avatarVisibilityTest = { hidden: 0, acknowledgements: [] };
      win.on('hide', () => trace.hidden++);
      ipcMain.on('overlay:visibility-done', (event, id) => {
        if (event.sender === win.webContents) trace.acknowledgements.push(id);
      });
      // The avatar's Hide button rebuilds the real tray menu. Capture its callbacks
      // to exercise tray commands without automating the desktop shell.
      const build = Menu.buildFromTemplate;
      Menu.buildFromTemplate = function (template) {
        const toggle = template.find((item) => item.label === '아바타 보이기');
        const focus = template.find((item) => item.label?.startsWith('선택지 보기'));
        if (toggle && focus) {
          trace.show = (visible) => toggle.click({ checked: visible });
          trace.focus = focus.click;
        }
        return build.call(this, template);
      };
    });
    await overlay.evaluate(() => {
      window.__visibilityRequests = [];
      window.cheongeumOverlay.onVisibility((request) => window.__visibilityRequests.push(request));
    });
    const acknowledged = (id) => app.evaluate((_, n) => globalThis.__avatarVisibilityTest.acknowledgements.includes(n), id);
    await overlay.getByRole('button', { name: '숨기기' }).click();
    await until(async () => !(await native()).visible, { what: 'native hide after exit' });
    const firstExit = await overlay.evaluate(() => window.__visibilityRequests.at(-1));
    assert.equal(firstExit.visible, false);
    assert.ok(await acknowledged(firstExit.id), 'renderer finished the exit before the native window was hidden');
    await app.evaluate(() => globalThis.__avatarVisibilityTest.show(true));
    await until(async () => (await native()).visible, { what: 'show from tray' });
    assert.equal((await native()).focusable, false, 'ordinary reveal preserves desktop focus');

    const visibleDuringExit = await app.evaluate(({ BrowserWindow }) => {
      const trace = globalThis.__avatarVisibilityTest;
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/avatar/'));
      trace.show(false);
      const visible = win.isVisible();
      trace.show(true);
      return visible;
    });
    assert.ok(visibleDuringExit, 'native window remains visible during exit');
    const latest = await until(() => overlay.evaluate(() => window.__visibilityRequests.length >= 4 && window.__visibilityRequests.slice(-2)),
      { what: 'interrupted exit and new entrance' });
    assert.deepEqual(latest.map((r) => r.visible), [false, true]);
    await until(() => acknowledged(latest[1].id), { what: 'entrance acknowledgement' });
    await overlay.evaluate((id) => window.cheongeumOverlay.visibilityDone(id), latest[0].id);
    await until(() => acknowledged(latest[0].id), { what: 'late exit acknowledgement delivered' });
    assert.equal(await app.evaluate(() => globalThis.__avatarVisibilityTest.hidden), 1, 'an interrupted exit never hid the window');
    assert.ok((await native()).visible);

    await app.evaluate(() => globalThis.__avatarVisibilityTest.show(false));
    await until(async () => !(await native()).visible, { what: 'hide from tray' });
    await app.evaluate(() => globalThis.__avatarVisibilityTest.focus());
    await until(async () => (await native()).focused, { what: 'explicit keyboard reveal' });
    assert.equal(await overlay.evaluate(() => performance.timeOrigin), origin);
    assert.deepEqual(errors, []);
  },
  /** 1단계: 아바타에서 동의·말하기·멈춤, 대화 창을 세 번 열고 닫아도 세션·심장 박동·기록이 하나씩 */
  async 'one-session'({ app, controller, overlay, requests, voice, errors }) {
    voice.said.push('장애인연금 신청 도와줘');
    const consent = overlay.getByRole('button', { name: '동의하고 음성 대화 시작' });
    await consent.waitFor({ timeout: 60000 });
    const beforeListening = await figureOnScreen(app, overlay);
    assert.deepEqual((await windows(app)).filter(isOverlay).map((w) => [w.visible, w.focusable, w.onTop]), [[true, false, true]], 'overlay shown on top without taking focus');
    assert.equal((await windows(app)).find(isController).visible, false, 'conversation starts hidden');
    await consent.click();
    await until(async () => (await overlayState(overlay)).mic === '마이크 켜짐', { what: 'mic on after consent' });

    await until(async () => (await logLines(controller)).includes('나: 장애인연금 신청 도와줘'), { timeout: 45000, what: 'spoken turn' });
    await until(async () => (await overlayState(overlay)).stop, { what: 'stop button' });
    await overlay.getByRole('button', { name: '멈춰' }).click();
    await until(async () => (await overlayState(overlay)).mic === '마이크 꺼짐', { what: 'mic off after stop' });
    await until(async () => {
      const stopped = await figureOnScreen(app, overlay);
      return Object.keys(stopped).every((axis) => Math.abs(stopped[axis] - beforeListening[axis]) <= 1);
    }, { what: 'stopped and consent figures at the same desktop coordinates and size' });

    const origin = await controller.evaluate(() => performance.timeOrigin);
    for (let i = 0; i < 3; i++) {
      await overlay.getByRole('button', { name: '청음 대화 열기' }).click();
      await until(async () => (await windows(app)).find(isController).visible, { what: `conversation shown ${i + 1}` });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('desktop=1')).close());
      await until(async () => !(await windows(app)).find(isController).visible, { what: `conversation hidden ${i + 1}` });
    }
    assert.equal(await controller.evaluate(() => performance.timeOrigin), origin, 'conversation page never reloaded');

    const beatFrom = Date.now();
    await new Promise((r) => setTimeout(r, 31000));
    const beats = requests.filter((r) => r.path.endsWith('/heartbeat') && r.at >= beatFrom).length;
    const created = requests.filter((r) => r.method === 'POST' && r.path === '/api/session').length;
    const closed = requests.filter((r) => r.method === 'DELETE' || r.path.endsWith('/detach')).length;
    const lines = await logLines(controller);
    const asked = lines.filter((l) => l === '나: 장애인연금 신청 도와줘');
    const reply = lines[lines.indexOf('나: 장애인연금 신청 도와줘') + 1];
    assert.equal(created, 1, 'one session created');
    assert.equal(closed, 0, 'session never closed or detached');
    assert.ok(beats >= 2 && beats <= 3, `one heartbeat loop (${beats} beats in 31s)`);
    assert.equal(asked.length, 1, 'user message once');
    assert.ok(reply?.startsWith('청음: '), 'reply follows the message');
    assert.equal(lines.filter((l) => l === reply).length, 1, 'reply once');
    assert.equal(voice.transcriptions, 1, 'one utterance transcribed');

    const blocked = await overlay.evaluate(() => fetch('/api/health').then(() => 'reached', () => 'blocked'));
    assert.equal(blocked, 'blocked', 'overlay cannot call the API');
    await overlay.getByRole('button', { name: '숨기기' }).click();
    await until(async () => !(await windows(app)).find(isOverlay).visible, { what: 'hide removes the avatar' });
    assert.equal((await windows(app)).find(isController).visible, false, 'hide leaves the session in place');
    assert.deepEqual(errors, []);
    return { created, beats, closed, reply };
  },

  /** 2단계: 같은 승인을 아바타 두 번 누르기·대화 창 버튼·음성 '응'으로 동시에 보내도 입력은 한 번. 지난 카드·지난 승인 번호는 0번. */
  async approvals({ controller, overlay, voice, server, session, requests, errors }) {
    await consentByOverlay(overlay);
    await type(controller, '127.0.0.1:5174/external.html 열어줘');
    await type(controller, '이름 칸에 김하늘 써줘');
    const approve = overlay.getByRole('button', { name: '입력 승인' });
    await approve.waitFor();
    const shown = await overlayState(overlay);
    assert.deepEqual(shown.choices.map((c) => c.label), ['입력 승인', '내용 확인', '취소']);
    assert.ok(!(await overlay.locator('body').innerText()).includes('김하늘'), 'typed value stays out of the overlay');
    const sid = session();
    const { pendingConfirmation } = await server(`/api/session/${sid}/state`);
    assert.equal(await fills(server), 0);

    // Keep both controls on the observed card until the competing inputs have arrived.
    let release;
    const pendingResponses = new Promise((resolve) => { release = resolve; });
    const competing = /\/api\/(?:audio\/turn|session\/[^/]+\/confirm)(?:\?|$)/;
    await controller.route(competing, async (route) => {
      await pendingResponses;
      await route.continue();
    });
    voice.said.push('응');
    const spoken = controller.evaluate(
      async ([id, actionId]) => {
        const { api } = await import('/api.js');
        const recording = api.liveAudio(id);
        recording.append(new ArrayBuffer(6000));
        return api.audioTurn(id, recording, actionId).then((r) => r.speech, (e) => 'error ' + e.message);
      },
      [sid, pendingConfirmation.actionId],
    );
    const confirmsBefore = requests.filter((r) => r.path.endsWith('/confirm')).length;
    let windowClick;
    try {
      await until(() => voice.liveCommits === 1, { what: 'spoken approval transcribed' });
      await approve.dblclick();
      await controller.locator('#confirm-yes').click({ force: true });
      windowClick = 'clicked';
    } finally {
      release();
    }
    const spokenSpeech = await spoken;
    await controller.unroute(competing);
    await until(async () => (await overlayState(overlay)).prompt === null, { what: 'approval card resolved' });
    await new Promise((r) => setTimeout(r, 1500));
    const afterRace = await fills(server);
    const confirmRequests = requests.filter((r) => r.path.endsWith('/confirm')).length - confirmsBefore;
    assert.equal(windowClick, 'clicked', 'the conversation window button was pressed too');
    assert.equal(voice.transcriptions, 1, 'spoken approval reached the server');
    assert.equal(confirmRequests, 1, `one button request left the controller (${confirmRequests}); window click: ${windowClick}`);
    assert.equal(afterRace, 1, `one write from the race (${afterRace})`);

    await type(controller, '이름 칸에 박하늘 써줘');
    await approve.waitFor();
    const oldSet = await cardSet(overlay);
    const oldAction = (await server(`/api/session/${sid}/state`)).pendingConfirmation.actionId;
    await type(controller, '이름 칸에 최하늘 써줘');
    await until(async () => (await cardSet(overlay)) && (await cardSet(overlay)) !== oldSet, { what: 'new card' });
    await overlay.evaluate((id) => window.cheongeumOverlay.choose(id, 'approve'), oldSet);
    await until(async () => (await logLines(controller)).some((l) => l.includes('선택지가 바뀌었어요')), { what: 'stale card notice' });
    const backend = await server(`/api/session/${sid}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true, actionId: oldAction }),
    });
    assert.match(backend.speech, /바뀌었어요/, 'old action id refused');
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await fills(server), 1, 'stale card and stale action id wrote nothing');

    await overlay.getByRole('button', { name: '취소' }).click();
    await until(async () => (await overlayState(overlay)).prompt === null, { what: 'rejected card gone' });
    assert.equal(await fills(server), 1, 'reject wrote nothing');
    assert.deepEqual(errors, []);
    return { afterRace, confirmRequests, windowClick, spokenSpeech, backend: backend.speech };
  },

  /**
   * 3단계: 연습 신청서 → 로그인 인계. 마이크를 놓고, 아바타 카드의 '로그인했어요'·'인증 취소'를 키보드로(대화 창은 닫힌 채).
   * 화면이 그대로면 계속 기다리고, 지난 카드·지난 인계 번호는 아무것도 하지 않는다.
   */
  async 'login-handoff'({ app, controller, overlay, server, session, requests, lastResult, errors }) {
    await consentByOverlay(overlay);
    await until(async () => (await liveTracks(controller)) > 0, { what: 'mic tracks open in conversation' });
    await type(controller, '장애인연금 신청 도와줘');
    await type(controller, '로그인하고 싶어');
    const done = overlay.getByRole('button', { name: '로그인했어요' });
    await done.waitFor();
    const handoff = await overlayState(overlay);
    assert.match(handoff.prompt, /에서 직접 로그인해 주세요\.$/);
    assert.deepEqual(handoff.choices.map((c) => c.label), ['로그인했어요', '인증 취소']);
    assert.equal(handoff.mic, '마이크 꺼짐');
    assert.equal(await controller.locator('#capture-label').innerText(), handoff.mic);
    assert.equal(await controller.locator('#task-label').innerText(), '사이트에서 직접 진행해 주세요.');
    assert.equal(await liveTracks(controller), 0, `mic tracks released at the handoff (${await trackReport(controller)})`);
    assert.equal((await windows(app)).find(isController).visible, false, 'conversation stays collapsed');

    const sid = session();
    const firstSet = await cardSet(overlay);
    const firstTurn = lastResult();
    assert.equal(firstTurn.state, 'AUTH_HANDOFF');
    await overlay.locator('#choices button').first().focus();
    await overlay.keyboard.press('Enter');
    await until(async () => {
      const set = await cardSet(overlay);
      return set && set !== firstSet;
    }, { what: 'new card after an unchanged gate' });
    const waiting = await server(`/api/session/${sid}/state`);
    assert.equal(waiting.state, 'AUTH_HANDOFF', 'unchanged login page keeps waiting');
    const userChoice = controller.locator('#log li.user').filter({ hasText: /^나:\s+로그인했어요$/u });
    assert.equal(await userChoice.count(), 1, '선택한 사용자의 말이 기록에 한 번 표시된다');

    const choicesBefore = requests.filter((r) => r.path.endsWith('/choice')).length;
    await overlay.evaluate((id) => window.cheongeumOverlay.choose(id, 'auth-done'), firstSet);
    await until(async () => (await logLines(controller)).some((l) => l.includes('선택지가 바뀌었어요')), { what: 'stale card notice' });
    assert.equal(requests.filter((r) => r.path.endsWith('/choice')).length, choicesBefore, 'stale card sent nothing');
    // 인계 번호는 그대로이고 응답만 지난 것: 지난 응답의 제안은 실행하지 않는다
    assert.equal(lastResult().authHandoff.id, firstTurn.authHandoff.id, 'same handoff is still waiting');
    const stale = await server(`/api/session/${sid}/choice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: firstTurn.turnId, key: 'auth-done', handoffId: firstTurn.authHandoff.id }),
    });
    assert.equal(stale.error, 'CHOICE_EXPIRED', 'superseded offer refused');

    await overlay.locator('#choices button', { hasText: '인증 취소' }).focus();
    await overlay.keyboard.press('Enter');
    await until(async () => (await overlayState(overlay)).prompt === null, { what: 'handoff card gone after cancel' });
    const after = await server(`/api/session/${sid}/state`);
    assert.notEqual(after.state, 'AUTH_HANDOFF');
    assert.equal(await liveTracks(controller), 0, 'mic stays off until the user starts it again');
    assert.equal((await overlayState(overlay)).mic, '마이크 꺼짐');
    assert.deepEqual(errors, []);
    return { waiting: waiting.state, after: after.state };
  },

  /** 4단계: 실제 재생 동안만 움직이고 끊으면 바로 멈춘다. 애니메이션 줄이기·모델 실패는 같은 버튼의 정지 그림. */
  async motion({ controller, overlay, voice, errors }) {
    voice.speechMs = 5000;
    const figure = () => overlay.evaluate(() => ({ ...document.getElementById('figure').dataset }));
    const framesIn = async (ms) => {
      const before = await overlay.evaluate(() => window.__frames);
      await new Promise((r) => setTimeout(r, ms));
      return (await overlay.evaluate(() => window.__frames)) - before;
    };
    await until(async () => (await figure()).renderer === 'webgl', { timeout: 60000, what: '3D character' });
    await until(async () => (await figure()).pose === 'speaking', { what: 'speaking pose during the consent guidance' });
    const speakingFrames = await framesIn(600);
    assert.ok(speakingFrames >= 10, `animates while audible (${speakingFrames} frames)`);

    await overlay.getByRole('button', { name: '동의하고 음성 대화 시작' }).click();
    // Both the consent recording and the post-consent greeting animate the mouth.
    // Interrupt only once the greeting is playing with the microphone running.
    await until(async () => {
      const state = await overlayState(overlay);
      return state.mic === '마이크 켜짐' && state.speaking && state.mode === 'speaking' &&
        (await figure()).pose === 'speaking';
    }, { what: 'post-consent greeting playing with the mic on' });
    const stoppedAt = Date.now();
    await overlay.getByRole('button', { name: '말하기' }).click();
    await until(async () => (await figure()).pose !== 'speaking', { timeout: 2000, what: 'mouth stops on interruption' });
    const settle = Date.now() - stoppedAt;
    const turned = (await figure()).clip;
    assert.ok(['your-turn', 'listening'].includes(turned), `turns to listen after the interruption (${turned})`);
    await until(async () => (await figure()).pose === 'still', { timeout: 8000, what: 'holds the listening pose' });
    assert.equal((await figure()).clip, 'listening');
    const idleFrames = await framesIn(800);
    assert.ok(idleFrames <= 1, `no drawing while still (${idleFrames} frames)`);

    await overlay.emulateMedia({ reducedMotion: 'reduce' });
    await until(async () => (await figure()).renderer === 'image', { what: 'still image under reduced motion' });
    await type(controller, '장애인연금이 뭐야');
    await until(async () => (await overlayState(overlay)).speaking, { timeout: 30000, what: 'audible reply with reduced motion' });
    const reducedFrames = await framesIn(600);
    assert.equal((await figure()).pose, 'still');
    assert.ok(reducedFrames <= 1, `no motion when reduced (${reducedFrames} frames)`);
    await overlay.emulateMedia({ reducedMotion: 'no-preference' });

    await overlay.route('**/cheongeum-avatar.glb', (route) => route.abort());
    await overlay.reload();
    await until(async () => (await overlayState(overlay).catch(() => ({}))).mode && (await overlayState(overlay)).mode !== 'offline', { what: 'overlay gets a fresh snapshot after reload' });
    await until(async () => (await figure()).renderer === 'image', { what: 'fallback image when the model fails' });
    assert.equal(await overlay.getByRole('button', { name: '말하기' }).isEnabled(), true, 'controls work without the model');
    assert.deepEqual(errors, []);
    return { speakingFrames, settleMs: settle, turned, idleFrames, reducedFrames };
  },

  async 'sleep-wake'({ controller, overlay, voice, lastResult, errors }) {
    const figure = overlay.locator('#figure');
    const talk = overlay.getByRole('button', { name: '말하기' });
    const stop = overlay.getByRole('button', { name: '멈춰' });
    const sleeping = () => figure.getAttribute('data-sleeping').then((value) => value === 'true');
    await consentByOverlay(overlay);
    await until(async () => await liveTracks(controller) > 0, { what: 'first microphone session active' });
    await stop.click();
    await until(sleeping, { what: 'sleep after Stop' });
    await until(async () => await figure.getAttribute('data-pose') === 'sleeping', { what: '3D sleep pose' });
    assert.equal(await figure.getAttribute('data-clip'), 'sleeping');
    assert.equal(await liveTracks(controller), 0, 'microphone released while asleep');
    // Sample after a complete breathing cycle so a one-shot settling animation cannot pass.
    await new Promise((resolve) => setTimeout(resolve, 5400));
    const breath = await figure.screenshot();
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(await figure.getAttribute('data-clip'), 'sleeping');
    assert.ok(!breath.equals(await figure.screenshot()), 'sleep continues to change the rendered pixels');

    // A second Stop should interrupt the first wake even while the server still reports STOPPED.
    await figure.evaluate((el) => {
      window.__wakeClips = [];
      const observer = new MutationObserver(() => {
        const clip = el.dataset.clip;
        if (clip && clip !== 'sleeping' && window.__wakeClips.at(-1) !== clip) window.__wakeClips.push(clip);
      });
      observer.observe(el, { attributes: true, attributeFilter: ['data-clip'] });
    });
    await talk.click();
    await until(async () => !await sleeping(), { every: 25, what: 'first Talk wakes the character' });
    const firstClip = await until(() => overlay.evaluate(() => window.__wakeClips[0]), { what: 'transition out of sleep' });
    assert.ok(['ready', 'thinking', 'listening', 'speaking'].includes(firstClip), 'direct wake into the active state: ' + firstClip);
    await controller.locator('#stop-all').click();
    await until(sleeping, { what: 'Stop interrupts waking' });
    const request = '장애인연금 신청 도와줘';
    voice.said.push(request);
    await talk.click();
    await until(async () => !await sleeping() && await liveTracks(controller) > 0, { what: 'single Talk press restarts capture' });
    await until(async () => (await logLines(controller)).includes('나: ' + request), { timeout: 45000, what: 'first utterance after waking' });
    const opened = await until(() => {
      const result = lastResult();
      return result?.userUtterance === request && result;
    }, { what: 'server response to the first spoken request after Stop' });
    assert.equal(opened.state, 'APPLICATION_OPEN', opened.speech);
    assert.equal(voice.transcriptions, 1);
    assert.equal((await logLines(controller)).filter((line) => line === '나: ' + request).length, 1, 'first utterance handled once');
    assert.deepEqual(errors, []);
    return { sleepingPixelsChanged: true, firstClip, wakeInterrupted: true, utterances: voice.transcriptions, state: opened.state };
  },

  /** 트레이의 '움직이지 않는 아바타'(저장된 설정): 말하는 동안에도 정지 그림, 그리기 없음 */
  async 'still-pref'({ overlay }) {
    const figure = () => overlay.evaluate(() => ({ ...document.getElementById('figure').dataset }));
    await until(async () => (await overlayState(overlay)).mode === 'consent', { timeout: 60000, what: 'consent guidance' });
    await new Promise((r) => setTimeout(r, 1000));
    const before = await overlay.evaluate(() => window.__frames);
    await new Promise((r) => setTimeout(r, 600));
    const frames = (await overlay.evaluate(() => window.__frames)) - before;
    const f = await figure();
    assert.equal(f.renderer, 'image');
    assert.equal(f.pose, 'still');
    assert.ok(frames <= 1, `no drawing (${frames})`);
    return { renderer: f.renderer, frames };
  },
};

const OPTIONS = {
  soak: { mic: { burstAt: null } },
  approvals: { mic: { burstAt: null } },
  'login-handoff': { mic: { burstAt: null } },
  motion: { mic: { burstAt: null } },
  'still-pref': { avatarPrefs: { still: true } },
  'intro-still': { avatarPrefs: { still: true } },
};

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
  let failed = 0;
  for (const name of names) {
    const t = await launch(OPTIONS[name]);
    const started = Date.now();
    try {
      const out = await scenarios[name](t);
      console.log(`PASS ${name} ${Math.round((Date.now() - started) / 1000)}s ${JSON.stringify(out ?? {})}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}: ${error.stack}`);
      console.log('overlay:', JSON.stringify(await overlayState(t.overlay).catch(() => null)));
      console.log('log:', JSON.stringify(await logLines(t.controller).catch(() => null)));
    } finally {
      await t.close();
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
