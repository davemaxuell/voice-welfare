// Smoke test the installed executable from a new user profile outside the checkout.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { playwright, windowWhere, windows, until, wav, fakeVoice } = require('./harness.cjs');

async function waitForShutdown(origin) {
  await until(async () => {
    try {
      await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) });
      return false;
    } catch (error) {
      return error.cause?.code === 'ECONNREFUSED';
    }
  }, { what: 'local server to exit' });
}

async function verifyLiveSpeech(origin, voice) {
  const text = '청음의 음성 읽기를 확인합니다.';
  const start = voice.readings.length;
  const response = await fetch(origin + '/api/audio/speak', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, lang: 'ko' }), signal: AbortSignal.timeout(25_000),
  });
  assert.equal(voice.legacySpeechRequests, 0, 'all read-aloud requests use Live sessions');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  const audio = Buffer.from(await response.arrayBuffer());
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(audio.readUInt16LE(20), 1, 'PCM');
  assert.equal(audio.readUInt16LE(22), 1, 'mono');
  assert.equal(audio.readUInt32LE(24), 24000);
  assert.equal(audio.readUInt16LE(34), 16);
  assert.equal(audio.toString('ascii', 36, 40), 'data');
  assert.equal(audio.length, 44 + audio.readUInt32LE(40));
  assert.equal(audio.readUInt32LE(4), audio.length - 8);
  const samples = new Int16Array(audio.buffer, audio.byteOffset + 44, audio.readUInt32LE(40) / 2);
  assert.ok(samples.includes(4096), 'returned WAV contains the provider tone');
  assert.ok(voice.readings.slice(start).includes(text), 'provider received the requested Korean text');
  const health = await (await fetch(origin + '/api/health')).json();
  assert.deepEqual(health.tts, { provider: 'gpt-live-1.1(coral)', supported: true });
}

async function main() {
  assert.ok(process.argv[2], 'Pass the path to the installed Cheongeum executable.');
  const exe = fs.realpathSync(process.argv[2]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheongeum-install-'));
  const profile = path.join(dir, 'profile');
  const args = [`--user-data-dir=${profile}`, '--proxy-server=http://127.0.0.1:9'];
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'TMP', 'TEMP', 'TMPDIR', 'LANG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const missing = path.join(dir, 'missing');
  Object.assign(env, {
    PATH: process.platform === 'win32' ? path.join(env.SystemRoot, 'System32') : '/usr/bin:/bin',
    CHEONGEUM_PYTHON: missing, PYTHONHOME: missing, PYTHONPATH: missing, PLAYWRIGHT_BROWSERS_PATH: missing,
    HF_HUB_OFFLINE: '1', HF_HOME: path.join(dir, 'hf'),
    NODE_ENV: 'test', CHEONGEUM_SETTINGS_DIR: profile,
  });
  const silence = wav(new Array(16000).fill(0), 16000);
  const fakeMic = path.join(dir, 'silent.wav');
  fs.writeFileSync(fakeMic, silence);
  const launch = (hardware = false) => playwright()._electron.launch({
    executablePath: exe, cwd: dir, env, timeout: 90_000,
    args: hardware ? args : [...args, '--mute-audio', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${fakeMic}`],
  });
  const busy = net.createServer((socket) => socket.destroy());
  let app;
  let origin;
  const voice = await fakeVoice();
  const configureVoice = () => fs.writeFileSync(path.join(profile, 'settings.env'), `PRACTICE_MODE=true\nLLM_PROVIDER=mock\nVOICE_API_KEY=fake\nVOICE_BASE_URL=${voice.url}\n`);
  try {
    fs.mkdirSync(profile);
    if (process.argv.includes('--live-speech')) {
      configureVoice();
      app = await launch();
      assert.ok(await app.evaluate(({ app }) => app.isPackaged));
      const controller = await windowWhere(app, url => url.includes('desktop=1'));
      origin = new URL(controller.url()).origin;
      assert.equal(new URL(origin).hostname, '127.0.0.1');
      await verifyLiveSpeech(origin, voice);
      const version = await app.evaluate(({ app }) => app.getVersion());
      assert.equal(version, require('../package.json').version);
      console.log(`PASS installed ${version}: /api/audio/speak returned Korean gpt-live-1.1(coral) read-aloud audio as mono 24 kHz PCM WAV over a loopback Live session`);
      return;
    }
    busy.listen(0, '127.0.0.1');
    await once(busy, 'listening');
    fs.writeFileSync(path.join(profile, 'service-port'), String(busy.address().port));
    app = await launch();
    assert.ok(await app.evaluate(({ app }) => app.isPackaged));
    const controller = await windowWhere(app, (url) => url.includes('desktop=1'));
    const overlay = await windowWhere(app, (url) => url.includes('/avatar/'));
    origin = new URL(controller.url()).origin;
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    assert.notEqual(Number(new URL(origin).port), busy.address().port);
    const health = await (await fetch(origin + '/api/health')).json();
    assert.ok(health.ok && health.setupRequired && !health.stt.supported && !health.tts.supported);
    assert.ok(health.datasets.some((d) => d.row_count > 0));
    await controller.locator('#settings-dialog[open]').waitFor();
    await until(async () => (await windows(app)).some((w) => w.url === controller.url() && w.visible));
    await until(() => controller.locator('#setup-save').isEnabled());
    for (const [language, title] of [['en', 'Cheongeum settings'], ['zh', '青音设置'], ['ja', 'チョンウムの設定'], ['ko', '청음 이용 설정']]) {
      await controller.locator('#setup-language').selectOption(language);
      assert.equal(await controller.locator('#settings-title').innerText(), title);
    }
    await controller.locator('#setup-device').selectOption('personal');
    await controller.locator('#setup-remember-service').check();
    await controller.locator('#setup-device').selectOption('shared');
    assert.ok(await controller.locator('#setup-remember-service').isDisabled());
    assert.equal(await controller.locator('#setup-remember-service').isChecked(), false);
    await controller.locator('#setup-region').selectOption('부산광역시');
    await controller.locator('#setup-speed').selectOption('1.6');
    await controller.locator('#setup-save').click();
    // Re-open during startup, before waiting for the browser-backed session.
    const second = spawn(exe, args, { cwd: dir, env, windowsHide: true, stdio: 'ignore', signal: AbortSignal.timeout(20000) });
    assert.equal((await once(second, 'exit'))[0], 0);
    await until(async () => (await windows(app)).some((w) => w.url === controller.url() && w.visible));
    const consent = controller.locator('#consent-yes');
    try {
      await consent.waitFor({ timeout: 60_000 });
    } catch (error) {
      const state = await controller.locator('#error').textContent();
      throw new Error(`Desktop never reached consent: ${state}; avatar: ${await overlay.locator('#status').textContent()}`, { cause: error });
    }
    await consent.click();
    const command = controller.locator('#command');
    await until(() => command.isEnabled());
    const cancelled = controller.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/cancel'));
    await controller.locator('#stop-all').click();
    assert.equal((await (await cancelled).json()).state, 'STOPPED');
    const figure = overlay.locator('#figure');
    await overlay.locator('#figure[data-sleeping="true"]').waitFor();
    const poster = figure.locator('#sleeping-still');
    await poster.evaluate((img) => img.decode());
    const framing = await figure.evaluate(async (stage) => {
      const { HOLD, PORTRAIT_WIDTH, PORTRAIT_HEIGHT } = await import('/avatar/character.js');
      const sources = [...Object.keys(HOLD), 'speaking', 'complete'].map(pose => `/avatar/poses/${pose}.webp`);
      const images = await Promise.all(sources.map(async src => {
        const img = new Image();
        img.src = src;
        await img.decode();
        return img;
      }));
      images.push(stage.querySelector('#sleeping-still'));
      const { width, height } = stage.getBoundingClientRect();
      return width === PORTRAIT_WIDTH && height === PORTRAIT_HEIGHT
        && images.every(img => img.naturalWidth === width * 2 && img.naturalHeight === height * 2);
    });
    assert.ok(framing, 'every bundled pose decodes at the desktop stage proportions');
    if (await figure.getAttribute('data-renderer') === 'webgl') {
      await overlay.locator('#figure[data-clip="sleeping"][data-pose="sleeping"]').waitFor();
    } else {
      await poster.waitFor({ state: 'visible' });
    }
    const turn = controller.waitForResponse((r) => new URL(r.url()).pathname === '/api/turn');
    await command.fill('장애인연금 지원 대상이 누구야?');
    await command.press('Enter');
    await overlay.locator('#figure[data-sleeping="false"]').waitFor();
    const answer = await (await turn).json();
    assert.match(answer.speech, /18세|십팔\s*세|열여덟/);

    const dictation = await fetch(origin + '/api/audio/transcribe?sessionId=' + answer.sessionId, {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: silence,
    });
    assert.equal(dictation.status, 501);
    await app.close();
    app = null;
    await waitForShutdown(origin);
    configureVoice();
    const hardware = process.env.CHEONGEUM_TEST_HARDWARE === '1';
    app = await launch(hardware);
    const restarted = await windowWhere(app, (url) => url.includes('desktop=1'));
    assert.equal(new URL(restarted.url()).origin, origin, 'reuse the available port across restarts');
    const configured = await (await fetch(origin + '/api/health')).json();
    assert.equal(configured.practiceMode, true);
    assert.ok(!configured.setupRequired && configured.stt.supported && configured.tts.supported);
    assert.equal(configured.stt.liveModel, 'gpt-live-transcribe');
    assert.equal(configured.voiceEdge, null, 'the custom transcription provider uses its own keyed voice route');
    assert.equal(configured.voiceSpeed, 1.6);
    assert.equal((await (await fetch(origin + '/api/settings')).json()).region, '부산광역시');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('desktop=1')).show());
    await restarted.locator('#consent-yes').waitFor({ timeout: 60_000 });
    assert.equal(voice.readings.length, 0, 'a returning user is never read the startup guide automatically');
    await restarted.locator('#consent-panel summary').click();
    await restarted.locator('#consent-full').click();
    await until(() => voice.readings.length > 0, { what: 'explicit startup guide replay' });
    await verifyLiveSpeech(origin, voice);
    const consentReply = restarted.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/consent'));
    await restarted.locator('#consent-yes').click({ timeout: 60_000 });
    assert.ok((await (await consentReply).json()).sessionId);
    voice.said.push('정부24 열어줘');
    await restarted.locator('#recording-title').click();
    await restarted.locator('#recording-file').setInputFiles({ name: 'sample.wav', mimeType: 'audio/wav', buffer: silence });
    await restarted.locator('#recording-send').click();
    await until(async () => (await restarted.locator('#recording-result').inputValue()) === '정부24 열어줘',
      { what: 'redacted transcript available for review without submitting a command' });
    voice.said.push('주민등록 등봉 발급 방법 알려줘', '아니요');
    async function microphoneTurn() {
      const frames = voice.liveFrames, commits = voice.liveCommits;
      await restarted.locator('#mic-btn').click();
      await until(() => voice.liveFrames >= frames + 6, { what: 'live PCM sent before the microphone button is released' });
      assert.equal(voice.liveCommits, commits);
      const reply = restarted.waitForResponse(r => new URL(r.url()).pathname === '/api/audio/turn');
      await restarted.locator('#mic-btn').click();
      return (await reply).json();
    }
    const clarification = await microphoneTurn();
    assert.equal(clarification.semanticAction, 'clarify');
    assert.match(clarification.speech, /주민등록등본/);
    assert.deepEqual(clarification.actions, []);
    assert.deepEqual((await microphoneTurn()).actions, []);
    await restarted.locator('#mic-check').click();
    await restarted.waitForFunction(() => document.querySelector('#mic-check-result').textContent === '마이크를 사용할 수 있어요.');
    await restarted.locator('#sound-check').click();
    const outputReady = await restarted.evaluate(async () => {
      const { audioContext } = await import('/audio.js');
      const { earcon } = await import('/speaker.js');
      const context = audioContext();
      await context.resume();
      const before = context.currentTime;
      await earcon('done');
      return context.state === 'running' && context.currentTime > before;
    });
    assert.ok(outputReady, 'system output accepted the app sound');
    await restarted.locator('#open-settings').click();
    await restarted.locator('#setup-key').fill('sk-installed-storage-test');
    await restarted.locator('#setup-save').click();
    await restarted.locator('#settings-dialog').waitFor({ state: 'hidden', timeout: 30_000 });
    const saved = fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8');
    assert.ok(JSON.parse(saved).credential && !saved.includes('sk-installed-storage-test'));
    await restarted.locator('#open-settings').click();
    await until(async () => (await restarted.locator('#setup-key-hint').textContent()).includes('설정된 키'));
    assert.equal(await restarted.locator('#setup-key').inputValue(), '');
    console.log(`PASS installed setup, avatar sleep and wake, quiet restart, guide replay, welfare answer, dictation, speech clarification, and ${hardware ? 'physical' : 'test'} audio devices`);
  } finally {
    busy.close();
    if (app) await app.close();
    await voice.close();
    if (origin) await waitForShutdown(origin);
    if (path.dirname(dir) === path.resolve(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
