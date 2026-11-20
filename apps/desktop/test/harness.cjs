// 데스크톱 앱 시험 도구: 실제 Electron 앱(메인·대화 창·아바타 창)과 파이썬 서버를 띄우고,
// 받아쓰기·음성 합성은 이 파일의 가짜 서버가 맡는다(외부로 아무것도 보내지 않음). 마이크는 합성 WAV 파일.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_DIR = path.join(ROOT, 'apps', 'desktop');

function playwright() {
  const win = path.join(ROOT, '.venv', 'Lib', 'site-packages', 'playwright', 'driver', 'package');
  if (fs.existsSync(win)) return require(win);
  const lib = path.join(ROOT, '.venv', 'lib');
  const py = fs.readdirSync(lib).find((d) => d.startsWith('python'));
  return require(path.join(lib, py, 'site-packages', 'playwright', 'driver', 'package'));
}

async function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function wav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** 마이크 대신 쓸 소리: 조용한 잡음 속에 burstAt초부터 1.2초 동안 말소리 크기의 소리가 한 번(파일은 반복 재생된다). */
function micFile(dir, { seconds = 40, burstAt = 9 } = {}) {
  // burstAt이 null이면 말소리 없이 잡음만(시험이 말을 직접 보낼 때)
  const rate = 16000;
  const x = new Float32Array(rate * seconds);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    const loud = burstAt != null && t >= burstAt && t < burstAt + 1.2;
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    x[i] = loud ? 0.4 * syllable * (0.6 * Math.sin(2 * Math.PI * 180 * t) + 0.4 * noise()) : 0.004 * noise();
  }
  const file = path.join(dir, 'mic.wav');
  fs.writeFileSync(file, wav(x, rate));
  return file;
}

/** 가짜 OpenAI 호환 음성 서버: 받아쓰기는 줄 세운 글을 차례로, 합성은 speechMs 길이의 조용한 소리. */
async function fakeVoice() {
  const state = { said: [], transcriptions: 0, liveFrames: 0, liveCommits: 0, speeches: 0, speechMs: 1200 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/audio/transcriptions') {
        state.transcriptions += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text: state.said.shift() ?? '' }));
        return;
      }
      if (req.url === '/v1/audio/speech') {
        state.speeches += 1;
        const rate = 16000;
        const x = new Float32Array(Math.round((rate * state.speechMs) / 1000));
        for (let i = 0; i < x.length; i++) x[i] = 0.02 * Math.sin((2 * Math.PI * 220 * i) / rate);
        res.setHeader('Content-Type', 'audio/wav');
        res.end(wav(x, rate));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  const live = new (require('ws').WebSocketServer)({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/v1/realtime?intent=transcription' || !req.headers.authorization?.startsWith('Bearer ')) return socket.destroy();
    live.handleUpgrade(req, socket, head, ws => live.emit('connection', ws));
  });
  live.on('connection', ws => {
    ws.on('message', data => {
      const event = JSON.parse(data);
      const send = (type, props = {}) => ws.send(JSON.stringify({ type, ...props }));
      if (event.type === 'session.update') {
        const input = event.session.audio.input;
        if (input.transcription.model !== 'gpt-live-transcribe' || input.format.rate !== 24000 || input.turn_detection !== null) {
          return send('error', { error: { code: 'invalid_session' } });
        }
        send('session.updated');
      } else if (event.type === 'input_audio_buffer.append') {
        state.liveFrames++;
      } else if (event.type === 'input_audio_buffer.commit') {
        state.liveCommits++;
        state.transcriptions++;
        const item_id = 'turn-' + state.liveCommits;
        send('input_audio_buffer.committed', { item_id });
        send('conversation.item.input_audio_transcription.delta', { item_id, delta: '아직 말하는 중' });
        send('conversation.item.input_audio_transcription.completed', { item_id, transcript: state.said.shift() ?? '' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  state.close = () => new Promise((resolve) => {
    for (const ws of live.clients) ws.terminate();
    live.close();
    server.close(resolve);
  });
  return state;
}

/**
 * 앱을 띄운다. 서버는 main.cjs가 늘 하던 대로 .venv 파이썬으로 띄우고, 의도 분석은 규칙(mock), 연습 사이트 모드.
 * 반환: { app, controller, overlay, requests, voice, close }
 */
async function launch({ env: extra = {}, avatarPrefs, mic = {} } = {}) {
  const { _electron } = playwright();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheongeum-avatar-'));
  const userData = path.join(dir, 'profile');
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'preferences.json'), JSON.stringify({ preferences: {}, credential: '' }));
  if (avatarPrefs) fs.writeFileSync(path.join(userData, 'avatar.json'), JSON.stringify(avatarPrefs));
  const voice = await fakeVoice();
  const port = await freePort();
  const env = {
    ...process.env,
    DESKTOP_PORT: String(port),
    PILOT_PROFILE: 'shared',
    HEADLESS: 'true',
    PRACTICE_MODE: 'true',
    REQUIRE_CONSENT: 'true',
    READ_ONLY_CLICKS: 'safe',
    VISUAL_CURSOR: 'false',
    BROWSER_MODE: 'chromium',
    BROWSER_SLOWMO_MS: '0',
    MOCK_SITE_URL: 'http://localhost:5174',
    WEB_SEARCH_URL: 'http://127.0.0.1:5174/external.html?q={q}',
    CHEONGEUM_DATA_DIR: '',
    LLM_API_KEY: '',
    STT_MODEL: 'fake-stt',
    TTS_MODEL: 'fake-tts',
    VOICE_API_KEY: 'fake',
    VOICE_BASE_URL: voice.url,
    WELFARE_DATA_MODE: '',
    WELFARE_API_KEY: '',
    GUARDIAN_SENDER: 'preview',
    SOLAPI_API_KEY: '',
    SOLAPI_API_SECRET: '',
    PII_MODEL: '',
    ...extra,
  };
  delete env.CHEONGEUM_SHOW_WINDOW;
  for (const role of ['', '_UNDERSTAND', '_GOAL', '_WEB', '_FILE', '_VISION']) env[`LLM${role}_PROVIDER`] = 'mock';
  // CHEONGEUM_DESKTOP_EXE: 설치본의 실행 파일과 내장 Python으로 같은 시나리오를 돌린다.
  const packaged = process.env.CHEONGEUM_DESKTOP_EXE;
  const app = await _electron.launch({
    executablePath: packaged || path.join(APP_DIR, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [
      ...(packaged ? [] : [APP_DIR]),
      `--user-data-dir=${userData}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${micFile(dir, mic)}`,
      '--mute-audio',
    ],
    cwd: ROOT,
    env,
    timeout: 30000,
  });
  // 그리기를 멈췄는지 보려고 화면 그리기 요청 수를 센다(동작은 그대로)
  await app.context().addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.__frames = 0;
    window.requestAnimationFrame = (cb) => raf((t) => {
      window.__frames += 1;
      cb(t);
    });
  });
  // 마이크 트랙을 실제로 놓았는지 보려고 getUserMedia가 준 트랙을 모아 둔다(동작은 그대로)
  await app.context().addInitScript(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.getUserMedia) return;
    const real = devices.getUserMedia.bind(devices);
    window.__tracks = [];
    devices.getUserMedia = async (constraints) => {
      const stream = await real(constraints);
      window.__tracks.push(...stream.getTracks());
      return stream;
    };
  });
  const requests = [];
  const errors = [];
  let closing = false;
  let sessionId;
  app.context().on('request', (r) => requests.push({ method: r.method(), path: new URL(r.url()).pathname, at: Date.now() }));
  let lastResult;
  app.context().on('response', async (r) => {
    const pathname = new URL(r.url()).pathname;
    if (r.request().method() !== 'POST' || !r.ok()) return;
    if (pathname === '/api/session') {
      try {
        sessionId = (await r.json()).sessionId;
      } catch (error) {
        // A visibility-only scenario can exit while session startup is still in flight.
        if (!closing) errors.push(`Reading the session response: ${error.message}`);
      }
    }
    if (/^\/api\/(turn|audio\/turn)$|\/(choice|confirm)$/.test(pathname)) lastResult = await r.json().catch(() => lastResult);
  });
  const base = `http://localhost:${port}`;
  const server = async (pathname, init) => (await fetch(base + pathname, init)).json();
  const controller = await windowWhere(app, (u) => u.includes('desktop=1'));
  const overlay = await windowWhere(app, (u) => u.includes('/avatar/'));
  for (const page of [controller, overlay]) page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  return {
    app,
    controller,
    overlay,
    requests,
    voice,
    errors,
    port,
    server,
    session: () => sessionId,
    lastResult: () => lastResult,
    async close() {
      closing = true;
      await app.close().catch(() => undefined);
      await voice.close();
    },
  };
}

async function windowWhere(app, match, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const page = app.windows().find((w) => match(w.url()));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('window not found');
}

/** 메인 프로세스에서 본 창 상태(보이는지·초점·초점 가능 여부·위치) */
async function windows(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      url: w.webContents.getURL(),
      visible: w.isVisible(),
      focused: w.isFocused(),
      focusable: w.isFocusable(),
      onTop: w.isAlwaysOnTop(),
      bounds: w.getBounds(),
    })),
  );
}

async function until(check, { timeout = 20000, every = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out waiting for ${what}`);
}

module.exports = { ROOT, launch, windows, until, fakeVoice, wav, playwright, windowWhere };
