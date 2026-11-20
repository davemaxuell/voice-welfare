/**
 * 청음 데스크톱 앱(Electron 메인 프로세스).
 * - 서버·모의 사이트는 자식 프로세스(Python: python -m cheongeum.server --desktop)로 띄운다.
 *   설치본은 함께 설치한 런타임을 사용한다. 개발 실행은 CHEONGEUM_PYTHON → 저장소의 .venv → uv run 순서다.
 * - 마이크 권한과 소리 자동재생을 미리 허용해, 앱을 켜면 클릭 없이 바로 안내를 듣고 Enter로 동의할 수 있다.
 * - 전역 단축키 Cmd/Ctrl+Shift+Space = '지금 말하기'(크롬 창을 보고 있어도 동작). 동의 안내 중에는 '동의'.
 * - 기본은 백그라운드 실행: 창 없이 메뉴 막대(트레이)에만 '청음'이 있고 음성으로만 쓴다. CHEONGEUM_SHOW_WINDOW=1이면 창을 띄운다.
 * - 아바타(CHEONGEUM_AVATAR=0이면 끔): 화면 구석의 작은 창. 대화 창이 세션·마이크·재생을 계속 맡고,
 *   아바타 창은 대화 창이 보낸 표시 상태만 그리며 누른 버튼을 대화 창으로 돌려보낸다(이 프로세스가 중계).
 */
const { app, BrowserWindow, globalShortcut, ipcMain, screen, session, systemPreferences, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..', '..');
const ICON = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(ROOT, 'src/cheongeum/web/static/avatar/still.png');
const TALK_KEY = 'CommandOrControl+Shift+Space';
const CHOICES_KEY = 'CommandOrControl+Shift+K';

// 소리 재생에 사용자 클릭이 필요 없게(화면에서 버튼을 찾지 않아도 되도록)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const BACKGROUND = process.env.CHEONGEUM_SHOW_WINDOW !== '1';
const AVATAR = process.env.CHEONGEUM_AVATAR !== '0';
const CORNERS = { 'bottom-right': '오른쪽 아래', 'bottom-left': '왼쪽 아래', 'top-right': '오른쪽 위', 'top-left': '왼쪽 위' };
const OVERLAY_MARGIN = 12;

let services;
let updates;
let base;
let win;
let openRequested = false;
let tray;
let overlay;
let overlayReady = false;
let overlayPaintReady = false;
let visibilitySequence = 0;
let pendingVisibility;
let visibilityTimeout;
let focusRequested = false;
let lastSnapshot = null;
let overlaySize = { width: 200, height: 220 };
let overlayRegions = [];
let appliedShape;
let overlayInteractive;
const shortcuts = { talk: false, choices: false };
let prefs = { corner: 'bottom-right', still: false, hidden: false };

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 20, height: 20 }));
  if (process.platform === 'darwin') tray.setTitle('청음');
  if (process.platform === 'win32') tray.on('click', showConversation);
  tray.setToolTip('청음 — 음성 도우미 (Cmd/Ctrl+Shift+Space: 지금 말하기)');
  updateTray();
}

/** 단축키를 잡지 못했으면(다른 프로그램이 쓰는 중) 메뉴에서 알리고 메뉴로만 쓰게 한다. */
function updateTray() {
  if (!tray) return;
  const keyLabel = (ok, keys) => (ok ? ` (${keys})` : ' (단축키 사용 불가)');
  const avatarItems = overlay
    ? [
        { label: '아바타 보이기', type: 'checkbox', checked: !prefs.hidden, click: (item) => setOverlayHidden(!item.checked) },
        { label: `선택지 보기${keyLabel(shortcuts.choices, 'Cmd/Ctrl+Shift+K')}`, click: focusChoices },
        {
          label: '아바타 위치',
          submenu: Object.entries(CORNERS).map(([corner, label]) => ({
            label, type: 'radio', checked: prefs.corner === corner, click: () => savePrefs({ corner }),
          })),
        },
        { label: '움직이지 않는 아바타', type: 'checkbox', checked: prefs.still, click: (item) => savePrefs({ still: item.checked }) },
      ]
    : [];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `지금 말하기${keyLabel(shortcuts.talk, 'Cmd/Ctrl+Shift+Space')}`, click: () => win?.webContents.send('cheongeum:talk') },
      { label: '대화 열기', click: showConversation },
      { label: '이용 설정…', click: () => { showConversation(); controllerAction({ type: 'settings' }); } },
      { label: '멈춰', click: () => controllerAction({ type: 'stop' }) },
      ...avatarItems,
      { type: 'separator' },
      ...(updates ? [updates.menuItem()] : []),
      ...(app.isPackaged ? [
        { label: '기존 서비스 설정 가져오기…', click: importSettings },
        { label: '서비스 설정 폴더 열기', click: () => shell.openPath(app.getPath('userData')) },
      ] : []),
      ...(process.platform === 'win32' ? [
        { label: 'Windows 마이크 권한 설정', click: () => shell.openExternal('ms-settings:privacy-microphone') },
        { label: 'Windows 스피커 설정', click: () => shell.openExternal('ms-settings:sound') },
      ] : []),
      { label: '청음 종료', click: () => app.quit() },
    ]),
  );
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.env');

async function importSettings() {
  const picker = await dialog.showOpenDialog({
    title: '이 PC에서 사용할 청음 설정 파일 선택 (.env)',
    properties: ['openFile', 'showHiddenFiles'],
  });
  if (picker.canceled) return;
  const target = settingsFile();
  if (fs.existsSync(target)) {
    const { response } = await dialog.showMessageBox({
      type: 'question', message: '이 PC의 기존 서비스 설정을 교체할까요?',
      buttons: ['취소', '교체'], defaultId: 0, cancelId: 0,
    });
    if (response !== 1) return;
  }
  // Keep the previous configuration intact if a copy is interrupted.
  const tmp = `${target}.${require('node:crypto').randomUUID()}.tmp`;
  try {
    await fs.promises.copyFile(picker.filePaths[0], tmp);
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, target);
    await dialog.showMessageBox({ message: '설정을 저장했어요. 청음을 종료하고 다시 열면 적용돼요.' });
  } catch {
    await dialog.showMessageBox({ type: 'error', message: '설정 파일을 저장할 수 없어요. 파일 위치와 권한을 확인해 주세요.' });
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

function showConversation() {
  openRequested = true;
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
}

/** 대화 창(세션 주인)에 아바타·트레이에서 온 동작을 넘긴다. */
function controllerAction(action) {
  win?.webContents.send('cheongeum:action', action);
}

// ---------------------------------------------------------------- 아바타 창

const PREFS_FILE = () => path.join(app.getPath('userData'), 'avatar.json');

function loadPrefs() {
  try {
    const saved = JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8'));
    prefs = { ...prefs, corner: CORNERS[saved.corner] ? saved.corner : prefs.corner, still: saved.still === true };
  } catch {
    /* 처음 실행 */
  }
}

/** 구석·움직임 설정만 저장한다. 숨기기는 이번 실행에만(다음에 켜면 다시 보인다). */
function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  try {
    fs.writeFileSync(PREFS_FILE(), JSON.stringify({ corner: prefs.corner, still: prefs.still }));
  } catch {
    /* 저장하지 못하면 이번 실행에만 */
  }
  placeOverlay();
  sendOverlayPrefs();
  updateTray();
}

function overlayLimits(area = screen.getPrimaryDisplay().workArea) {
  return {
    maxWidth: Math.max(1, Math.min(560, area.width - 2 * OVERLAY_MARGIN)),
    maxHeight: Math.max(1, Math.min(720, area.height - 2 * OVERLAY_MARGIN)),
  };
}

function sendOverlayPrefs() {
  sendOverlay('overlay:prefs', { corner: prefs.corner, still: prefs.still, ...overlayLimits() });
}

/** 고른 구석에 붙인다. 작업 영역(작업 표시줄 제외) 안쪽, 주 모니터 기준. */
function overlayBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const { maxWidth, maxHeight } = overlayLimits(area);
  const width = Math.min(overlaySize.width, maxWidth);
  const height = Math.min(overlaySize.height, maxHeight);
  const right = prefs.corner.endsWith('right');
  const bottom = prefs.corner.startsWith('bottom');
  return {
    width,
    height,
    x: Math.round(right ? area.x + area.width - width - OVERLAY_MARGIN : area.x + OVERLAY_MARGIN),
    y: Math.round(bottom ? area.y + area.height - height - OVERLAY_MARGIN : area.y + OVERLAY_MARGIN),
  };
}

function placeOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  const bounds = overlayBounds();
  const current = overlay.getBounds();
  if (Object.keys(bounds).some((key) => bounds[key] !== current[key])) overlay.setBounds(bounds);
  if (process.platform === 'darwin') {
    // Bubble geometry can change under a stationary pointer.
    const point = screen.getCursorScreenPoint();
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    const interactive = !overlayRegions.length || overlayRegions.some((r) =>
      x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
    setOverlayInteractive(interactive);
  } else {
    const shape = JSON.stringify(overlayRegions);
    if (shape !== appliedShape) {
      overlay.setShape(overlayRegions);
      appliedShape = shape;
    }
  }
}

function setOverlayInteractive(active) {
  if (active === overlayInteractive) return;
  overlay.setIgnoreMouseEvents(!active, { forward: true });
  overlayInteractive = active;
}

// Native hit regions use whole device-independent pixels relative to the overlay.
function hitRegions(regions, width, height) {
  if (!Array.isArray(regions) || regions.length > 32) return [];
  const clipped = [];
  for (const r of regions) {
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) continue;
    if (r.width <= 0 || r.height <= 0) continue;
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const right = Math.min(width, Math.ceil(r.x + r.width));
    const bottom = Math.min(height, Math.ceil(r.y + r.height));
    if (right > x && bottom > y) clipped.push({ x, y, width: right - x, height: bottom - y });
  }
  return clipped;
}

function sendOverlay(channel, payload) {
  if (overlay && !overlay.isDestroyed() && overlayReady) overlay.webContents.send(channel, payload);
}

function presentOverlay() {
  if (!overlayReady || !overlayPaintReady || pendingVisibility !== undefined || prefs.hidden || app.isQuitting) return;
  placeOverlay();
  if (focusRequested) {
    focusRequested = false;
    overlay.setFocusable(true);
    overlay.show();
    overlay.focus();
    sendOverlay('overlay:focus');
  } else if (!overlay.isVisible()) {
    overlay.showInactive();
  }
}

function finishVisibility(id) {
  if (!Number.isSafeInteger(id) || id !== pendingVisibility) return;
  clearTimeout(visibilityTimeout);
  pendingVisibility = undefined;
  if (!overlay || overlay.isDestroyed() || app.isQuitting) return;
  if (prefs.hidden) overlay.hide();
  else presentOverlay();
}

// The renderer acknowledges an exit after its last frame, and an entrance as soon as
// its layout is ready to paint. A newer request always supersedes an older reply.
function requestVisibility(animate) {
  if (!overlayReady || app.isQuitting) return;
  const id = ++visibilitySequence;
  clearTimeout(visibilityTimeout);
  pendingVisibility = id;
  visibilityTimeout = setTimeout(() => finishVisibility(id), 800);
  visibilityTimeout.unref();
  sendOverlay('overlay:visibility', { id, visible: !prefs.hidden, animate: animate && !prefs.still });
}

function setOverlayHidden(hidden) {
  if (!overlay || overlay.isDestroyed() || prefs.hidden === hidden) return;
  prefs.hidden = hidden;
  updateTray();
  if (hidden) {
    focusRequested = false;
    overlay.setFocusable(false);
    if (!overlayReady) overlay.hide();
  }
  requestVisibility(true);
}

/** '선택지 보기': 일부러 누른 단축키·메뉴일 때만 아바타 창이 키보드 초점을 받는다. */
function focusChoices() {
  if (!overlay || overlay.isDestroyed()) return;
  focusRequested = true;
  if (prefs.hidden) setOverlayHidden(false);
  else presentOverlay();
}

/** 초점을 돌려준다(Esc·선택 뒤). 다시 초점을 받지 않는 창이 되면 운영체제가 앞 창(크롬)으로 돌려준다. */
function releaseOverlayFocus() {
  focusRequested = false;
  if (!overlay || overlay.isDestroyed() || !overlay.isFocusable()) return;
  overlay.blur();
  overlay.setFocusable(false);
}

/** 아바타 창은 자기 화면 파일(/avatar/…)과 그 안에서 만든 blob(모델 속 그림)만 불러온다. API·다른 출처 요청은 막는다. */
function overlayAsset(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'blob:') return u.origin === base;
    return u.origin === base && u.pathname.startsWith('/avatar/');
  } catch {
    return false;
  }
}

function createOverlay() {
  const ses = session.fromPartition('cheongeum-avatar');
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !overlayAsset(details.url) }));
  overlay = new BrowserWindow({
    ...overlayBounds(),
    title: '청음 도우미',
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // 저절로 나타난 선택지가 크롬의 키보드 초점을 빼앗지 않게. 클릭은 그대로 받는다.
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: ses,
    },
  });
  // 윈도에서 'floating'~'status'는 작업 표시줄 뒤 수준이라 최대화한 창(크롬)에 가려진다. 그보다 위 수준으로 둔다.
  overlay.setAlwaysOnTop(true, 'pop-up-menu');
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', (e) => e.preventDefault());
  const resetRenderer = () => {
    clearTimeout(visibilityTimeout);
    pendingVisibility = undefined;
    overlayReady = false;
    if (overlay.isVisible()) overlay.hide();
  };
  overlay.webContents.on('did-start-loading', resetRenderer);
  overlay.webContents.on('render-process-gone', () => {
    resetRenderer();
    if (!app.isQuitting) overlay.webContents.reload();
  });
  overlay.on('blur', () => overlay.setFocusable(false));
  overlay.once('ready-to-show', () => {
    overlayPaintReady = true;
    presentOverlay();
  });
  void overlay.loadURL(`${base}/avatar/`);
}

const fromOverlay = (e) => !!overlay && !overlay.isDestroyed() && e.sender === overlay.webContents;
const fromController = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;
const isText = (v, max = 80) => typeof v === 'string' && v.length > 0 && v.length <= max;

function bindBridge() {
  ipcMain.on('cheongeum:show-setup', (e) => {
    if (fromController(e)) showConversation();
  });
  // 첫 실행 설정·이용 설정: 컴퓨터를 켤 때 청음도 켤지(대화 창만, 참/거짓만)
  ipcMain.on('cheongeum:set-auto-start', (e, on) => {
    if (fromController(e) && typeof on === 'boolean') app.setLoginItemSettings({ openAtLogin: on });
  });
  ipcMain.handle('cheongeum:get-auto-start', (e) => (fromController(e) ? app.getLoginItemSettings().openAtLogin === true : false));
  // 대화 창 → 아바타: 표시 상태(마지막 것만 기억해 아바타가 새로 뜨면 다시 보낸다)
  ipcMain.on('cheongeum:snapshot', (e, snapshot) => {
    if (!fromController(e) || !snapshot || typeof snapshot !== 'object') return;
    lastSnapshot = snapshot;
    sendOverlay('cheongeum:snapshot', snapshot);
  });
  ipcMain.on('overlay:ready', (e) => {
    if (!fromOverlay(e)) return;
    overlayReady = true;
    sendOverlayPrefs();
    sendOverlay('cheongeum:snapshot', lastSnapshot ?? { connected: false });
    requestVisibility(visibilitySequence === 0 && !prefs.hidden);
  });
  ipcMain.on('overlay:visibility-done', (e, id) => {
    if (fromOverlay(e)) finishVisibility(id);
  });
  ipcMain.on('overlay:resize', (e, size) => {
    if (!fromOverlay(e) || !size) return;
    const width = Math.round(Number(size.width));
    const height = Math.round(Number(size.height));
    if (!(width >= 120 && width <= 560 && height >= 120 && height <= 720)) return;
    overlaySize = { width, height };
    overlayRegions = hitRegions(size.regions, width, height);
    placeOverlay();
  });
  ipcMain.on('overlay:interactive', (e, active) => {
    if (process.platform === 'darwin' && fromOverlay(e) && typeof active === 'boolean') {
      setOverlayInteractive(active);
    }
  });
  // 아바타 → 대화 창: 정해진 동작만, 모양을 확인한 뒤 넘긴다
  ipcMain.on('overlay:action', (e, action) => {
    if (!fromOverlay(e) || !action) return;
    switch (action.type) {
      case 'talk':
        win?.webContents.send('cheongeum:talk');
        return;
      case 'stop':
        controllerAction({ type: 'stop' });
        return;
      case 'open':
        showConversation();
        controllerAction({ type: 'reveal', focus: ['confirm', 'consent', 'command'].includes(action.focus) ? action.focus : undefined });
        return;
      case 'hide':
        setOverlayHidden(true);
        return;
      case 'release':
        releaseOverlayFocus();
        return;
      case 'choose':
        if (isText(action.choiceSetId) && isText(action.key, 40)) {
          controllerAction({ type: 'choose', choiceSetId: action.choiceSetId, key: action.key });
        }
        return;
      default:
    }
  });
}

/** 설치본은 사용자 컴퓨터의 Python·uv·소스 체크아웃 없이 동작한다. */
function pythonCommand() {
  const args = ['-m', 'cheongeum.server', '--desktop', '--host', '127.0.0.1'];
  if (app.isPackaged) {
    const runtime = path.join(process.resourcesPath, 'runtime');
    return {
      cmd: path.join(runtime, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
      args: ['-I', '-B', '-X', 'utf8', ...args, '--env-file', settingsFile()],
      cwd: app.getPath('userData'),
      env: { CHEONGEUM_DESKTOP_RUNTIME: runtime, PLAYWRIGHT_BROWSERS_PATH: path.join(runtime, 'browsers') },
    };
  }
  args.push('--port', process.env.DESKTOP_PORT || '8790');
  if (process.env.CHEONGEUM_PYTHON) return { cmd: process.env.CHEONGEUM_PYTHON, args };
  const venv = process.platform === 'win32' ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return { cmd: venv, args };
  return { cmd: 'uv', args: ['run', 'python', ...args] };
}

function startServices() {
  const { cmd, args, cwd = ROOT, env } = pythonCommand();
  services = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env, CHEONGEUM_SETTINGS_DIR: app.getPath('userData'), PYTHONIOENCODING: 'utf-8', CHEONGEUM_PARENT_PIPE: '1' },
    windowsHide: true,
    // stdin은 파이프로 열어 둔다: 이 앱이 꺼지면(비정상 종료 포함) 파이프가 닫히고 서버가 스스로 정리한다.
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('시작 시간이 초과됐어요.')), 90_000);
    // Only trust a bound address reported over our own child's pipe.
    const lines = readline.createInterface({ input: services.stdout });
    lines.on('line', (line) => {
      if (!app.isPackaged) console.log(line);
      const ready = /^\[desktop\] ready (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
      if (ready) {
        clearTimeout(timeout);
        resolve(ready[1]);
      }
    });
    services.once('error', (err) => { clearTimeout(timeout); reject(err); });
    services.once('exit', (code) => {
      clearTimeout(timeout);
      if (!base) reject(new Error(`서비스 종료 코드 ${code}`));
      else if (!app.isQuitting) startupFailed(new Error(`서비스 종료 코드 ${code}`));
    });
  });
}

function startupFailed(error) {
  if (app.isQuitting) return;
  dialog.showErrorBox('청음을 열 수 없어요', `${error.message}\n청음을 다시 열어 주세요. 문제가 계속되면 설치 파일을 다시 실행해 주세요.`);
  app.quit();
}

async function createWindow() {
  // 이 앱 화면(자기 주소)에만 마이크를 허용한다.
  const ours = (url) => {
    try {
      return new URL(url).origin === base;
    } catch {
      return false;
    }
  };
  // 마이크는 세션을 가진 대화 창에만(아바타 창은 따로 묶인 세션이라 여기에 오지 않는다)
  const controller = (wc) => !!win && wc === win.webContents;
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const trusted = controller(wc) && details.isMainFrame && ours(details.requestingUrl || wc.getURL());
    const micOnly = permission === 'media' && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio';
    cb(trusted && (micOnly || permission === 'speaker-selection'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    const trusted = (!wc || controller(wc)) && ours(origin) && (!details.embeddingOrigin || ours(details.embeddingOrigin));
    return trusted && (permission === 'speaker-selection' || (permission === 'media' && details.mediaType === 'audio'));
  });
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone').catch(() => false);
  }

  win = new BrowserWindow({
    width: 960,
    height: 860,
    title: '청음',
    icon: ICON,
    autoHideMenuBar: true,
    // 백그라운드 실행이면 창을 띄우지 않는다(음성·전역 단축키로만 사용, 메뉴 막대에서 '창 보기' 가능)
    show: !BACKGROUND || openRequested,
    // 화면을 그리기 전에도 웹 UI 배경색과 같게(어두운 모드에서 흰 화면이 번쩍이지 않게)
    backgroundColor: require('electron').nativeTheme.shouldUseDarkColors ? '#111018' : '#f5f4f9',
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
  // 백그라운드·아바타 실행에서는 창을 닫아도 앱은 계속(숨기기). 끝내려면 메뉴 막대의 '청음 종료'.
  win.on('close', (e) => {
    if ((BACKGROUND || AVATAR) && !app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  // 대화 창이 새로 고쳐지거나 죽으면 아바타는 그 세션의 버튼을 더 보여 주지 않는다
  const lost = () => {
    lastSnapshot = null;
    sendOverlay('cheongeum:snapshot', { connected: false });
  };
  win.webContents.on('did-start-loading', lost);
  // 대화 창 화면이 죽으면 다시 불러온다(새 세션, 동의 안내부터). 그대로 두면 말하기·아바타가 아무것도 하지 않는다.
  win.webContents.on('render-process-gone', () => {
    lost();
    if (!app.isQuitting) win.webContents.reload();
  });
  await win.loadURL(`${base}/?desktop=1${BACKGROUND ? '&background=1' : ''}`);
}

async function startApp() {
  if (process.platform === 'win32') app.setAppUserModelId('kr.cheongeum.app');
  if (BACKGROUND && process.platform === 'darwin') app.dock?.hide();
  base = await startServices();
  bindBridge();
  await createWindow();
  if (AVATAR) {
    loadPrefs();
    createOverlay();
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(event, () => {
        appliedShape = undefined;
        placeOverlay();
        sendOverlayPrefs();
      });
    }
  }
  shortcuts.talk = globalShortcut.register(TALK_KEY, () => win?.webContents.send('cheongeum:talk'));
  if (AVATAR) shortcuts.choices = globalShortcut.register(CHOICES_KEY, focusChoices);
  if (app.isPackaged && process.platform === 'win32') {
    const { autoUpdater } = require('electron-updater');
    updates = require('./updates.cjs').createUpdates(autoUpdater, dialog, updateTray, () => app.isQuitting);
    setTimeout(() => void updates.check(false), 15_000).unref();
    setInterval(() => void updates.check(false), 24 * 60 * 60 * 1000).unref();
  }
  if (BACKGROUND || AVATAR || updates) createTray();
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', showConversation);
  app.whenReady().then(startApp).catch(startupFailed);
} else {
  app.quit();
}

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
