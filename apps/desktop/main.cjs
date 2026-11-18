/**
 * 청음 데스크톱 앱(Electron 메인 프로세스).
 * - Node.js 24 이상으로 로컬 서버를 실행한다. 앱을 끄면 stdin을 닫아 서버가 세션과 브라우저를 정리한다.
 * - 마이크 권한과 소리 자동재생을 미리 허용해, 앱을 켜면 클릭 없이 바로 안내를 듣고 Enter로 동의할 수 있다.
 * - 전역 단축키 Cmd/Ctrl+Shift+Space = '지금 말하기'(크롬 창을 보고 있어도 동작). 동의 안내 중에는 '동의'.
 * - 기본은 백그라운드 실행: 창 없이 메뉴 막대(트레이)에만 '청음'이 있고 음성으로만 쓴다. CHEONGEUM_SHOW_WINDOW=1이면 창을 띄운다.
 */
const { app, BrowserWindow, globalShortcut, session, systemPreferences, dialog, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.DESKTOP_PORT || 8790);
const BASE = `http://localhost:${PORT}`;
const TALK_KEY = 'CommandOrControl+Shift+Space';

// 소리 재생에 사용자 클릭이 필요 없게(시각장애인이 화면에서 버튼을 찾지 않아도 되도록)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const BACKGROUND = process.env.CHEONGEUM_SHOW_WINDOW !== '1';

let services;
let win;
let tray;

/** 트레이 아이콘: 이미지 파일 없이 16×16 동그라미를 직접 그린다(macOS는 글자 '청음'도 함께). */
function trayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      const i = (y * size + x) * 4;
      const on = d <= 6.5;
      buf[i] = 0; // B
      buf[i + 1] = 0; // G
      buf[i + 2] = 0; // R
      buf[i + 3] = on ? 255 : 0; // A
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function createTray() {
  tray = new Tray(trayIcon());
  if (process.platform === 'darwin') tray.setTitle('청음');
  tray.setToolTip('청음 — 음성 도우미 (Cmd/Ctrl+Shift+Space: 지금 말하기)');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '지금 말하기 (Cmd/Ctrl+Shift+Space)', click: () => win?.webContents.send('cheongeum:talk') },
      { label: '창 보기', click: () => (win?.show(), win?.focus()) },
      { type: 'separator' },
      { label: '청음 종료', click: () => app.quit() },
    ]),
  );
}

function startServices() {
  const cmd = process.env.CHEONGEUM_NODE || 'node';
  const args = ['--env-file-if-exists=.env', 'src/server/main.ts', '--desktop', '--port', String(PORT)];
  services = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, DESKTOP_PORT: String(PORT), CHEONGEUM_PARENT_PIPE: '1' },
    windowsHide: true,
    // stdin은 파이프로 열어 둔다: 이 앱이 꺼지면(비정상 종료 포함) 파이프가 닫히고 서버가 스스로 정리한다.
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  services.on('error', () => {
    if (app.isQuitting) return;
    dialog.showErrorBox('청음', '서버를 시작하지 못했습니다. Node.js 설치와 CHEONGEUM_NODE 경로를 확인하세요.');
    app.quit();
  });
  services.on('exit', (code) => {
    if (!app.isQuitting) {
      dialog.showErrorBox('청음', `서버가 종료되었습니다(코드 ${code}). 터미널 로그를 확인하세요.`);
      app.quit();
    }
  });
}

async function waitReady(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 아직 준비 중 */
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

async function createWindow() {
  // 이 앱 화면(자기 주소)에만 마이크를 허용한다.
  const ours = (url) => typeof url === 'string' && URL.canParse(url) && new URL(url).origin === BASE;
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(permission === 'media' && ours(details.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => permission === 'media' && ours(origin));
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone').catch(() => false);
  }

  win = new BrowserWindow({
    width: 960,
    height: 860,
    title: '청음',
    // 백그라운드 실행이면 창을 띄우지 않는다(음성·전역 단축키로만 사용, 메뉴 막대에서 '창 보기' 가능)
    show: !BACKGROUND,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 다른 창(크롬)을 보고 있어도 음성 듣기·말하기가 멈추지 않게
      backgroundThrottling: false,
    },
  });
  // 앱 안에서 외부 링크를 열지 않는다(출처 링크는 기본 브라우저로).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!ours(url)) e.preventDefault();
  });
  // 백그라운드 실행에서는 창을 닫아도 앱은 계속(숨기기). 끝내려면 메뉴 막대의 '청음 종료'.
  win.on('close', (e) => {
    if (BACKGROUND && !app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  await win.loadURL(`${BASE}/?desktop=1${BACKGROUND ? '&background=1' : ''}`);
}

app.whenReady().then(async () => {
  if (BACKGROUND && process.platform === 'darwin') app.dock?.hide();
  startServices();
  if (!(await waitReady())) {
    dialog.showErrorBox('청음', '서버를 시작하지 못했습니다. .env와 터미널 로그를 확인하세요.');
    app.quit();
    return;
  }
  await createWindow();
  if (BACKGROUND) createTray();
  globalShortcut.register(TALK_KEY, () => win?.webContents.send('cheongeum:talk'));
});

app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  if (services && services.exitCode === null) {
    // 먼저 stdin을 닫아 서버가 브라우저·세션을 정리하고 끝나게 하고, 그래도 남아 있으면 끝낸다.
    services.stdin?.end();
    setTimeout(() => {
      if (services.exitCode === null) services.kill('SIGTERM');
    }, 3000).unref();
  }
});
app.on('window-all-closed', () => {
  if (!BACKGROUND) app.quit();
});
