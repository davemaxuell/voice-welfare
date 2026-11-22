/**
 * 청음 데스크톱 앱(Electron 메인 프로세스).
 * - 서버·모의 사이트는 Electron 유틸리티 프로세스(service.ts)로 띄운다. 설치본은 함께 묶은 서비스를,
 *   개발 실행은 저장소의 TypeScript 원본을 그대로 쓴다. 어느 쪽도 Python·uv·시스템 Node가 필요 없다.
 * - 마이크 권한과 소리 자동재생을 미리 허용해, 앱을 켜면 클릭 없이 바로 안내를 듣고 Enter로 동의할 수 있다.
 * - 전역 단축키 Cmd/Ctrl+Shift+Space = '지금 말하기'(크롬 창을 보고 있어도 동작). 동의 안내 중에는 '동의'.
 * - 기본은 백그라운드 실행: 창 없이 메뉴 막대(트레이)에만 '청음'이 있고 음성으로만 쓴다. CHEONGEUM_SHOW_WINDOW=1이면 창을 띄운다.
 * - 아바타(CHEONGEUM_AVATAR=0이면 끔): 화면 구석의 작은 창. 대화 창이 세션·마이크·재생을 계속 맡고,
 *   아바타 창은 대화 창이 보낸 표시 상태만 그리며 누른 버튼을 대화 창으로 돌려보낸다(이 프로세스가 중계).
 */
import { randomUUID } from "node:crypto";
import { existsSync, promises as fsp, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  utilityProcess,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
  type UtilityProcess,
  type WebContents,
} from "electron";
import type { Lang } from "../../../src/core/turn.ts";
import { desktopText } from "./text.ts";
import { isDesktopLanguage, isRecord, readyUrl, SHUTDOWN, trayTaskText } from "./protocol.ts";
import { appUpdater, createUpdates, type Updates } from "./updates.ts";

// The development bundle runs from apps/desktop/out/app, four levels below the checkout.
const CHECKOUT = resolve(app.getAppPath(), "..", "..", "..", "..");
const ICON = app.isPackaged ? join(process.resourcesPath, "icon.png") : join(CHECKOUT, "graphics", "mascot-original-refined.png");
const TALK_KEY = "CommandOrControl+Shift+Space";
const CHOICES_KEY = "CommandOrControl+Shift+K";

// 소리 재생에 사용자 클릭이 필요 없게(화면에서 버튼을 찾지 않아도 되도록)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const BACKGROUND = process.env.CHEONGEUM_SHOW_WINDOW !== "1";
const AVATAR = process.env.CHEONGEUM_AVATAR !== "0";
type Corner = keyof typeof desktopText.ko.corners;
const isCorner = (value: unknown): value is Corner => typeof value === "string" && Object.hasOwn(desktopText.ko.corners, value);
const OVERLAY_MARGIN = 12;
const FOCUS_TARGETS = ["confirm", "consent", "command"];

let service: UtilityProcess | undefined;
let serviceExited: Promise<void> = Promise.resolve();
let serviceAlive = false;
let stopping: Promise<void> | undefined;
let quitting = false;
let updates: Updates | undefined;
let base: string | undefined;
let win: BrowserWindow | undefined;
let openRequested = false;
let tray: Tray | undefined;
let overlay: BrowserWindow | undefined;
let overlayReady = false;
let overlayPaintReady = false;
let visibilitySequence = 0;
let pendingVisibility: number | undefined;
let visibilityTimeout: NodeJS.Timeout | undefined;
let focusRequested = false;
let lastSnapshot: Record<string, unknown> | null = null;
let overlaySize = { width: 200, height: 220 };
let overlayRegions: Rectangle[] = [];
let appliedShape: string | undefined;
let overlayInteractive: boolean | undefined;
const shortcuts = { talk: false, choices: false };
let prefs: { corner: Corner; still: boolean; hidden: boolean; lang?: Lang } = { corner: "bottom-right", still: false, hidden: false };

const copy = () => desktopText[prefs.lang ?? "ko"];

let lastTooltip: string | undefined;
function updateTooltip() {
  if (!tray) return;
  const labels = copy();
  const task = trayTaskText(lastSnapshot);
  const next = task === undefined ? labels.tip : `${labels.brand} · ${task}`;
  if (next === lastTooltip) return;
  tray.setToolTip(next);
  lastTooltip = next;
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ height: 20 }));
  if (process.platform === "win32") tray.on("click", showConversation);
  updateTray();
}

/** 단축키를 잡지 못했으면(다른 프로그램이 쓰는 중) 메뉴에서 알리고 메뉴로만 쓰게 한다. */
function updateTray() {
  if (!tray) return;
  const labels = copy();
  if (process.platform === "darwin") tray.setTitle(labels.brand);
  updateTooltip();
  const keyLabel = (ok: boolean, keys: string) => (ok ? ` (${keys})` : labels.shortcutUnavailable);
  const avatarItems: MenuItemConstructorOptions[] = overlay
    ? [
        { label: labels.showAvatar, type: "checkbox", checked: !prefs.hidden, click: (item) => setOverlayHidden(!item.checked) },
        { label: `${labels.choices}${keyLabel(shortcuts.choices, "Cmd/Ctrl+Shift+K")}`, click: focusChoices },
        {
          label: labels.position,
          submenu: Object.entries(labels.corners).map(([corner, label]): MenuItemConstructorOptions => ({
            label,
            type: "radio",
            checked: prefs.corner === corner,
            click: () => {
              if (isCorner(corner)) savePrefs({ corner });
            },
          })),
        },
        { label: labels.still, type: "checkbox", checked: prefs.still, click: (item) => savePrefs({ still: item.checked }) },
      ]
    : [];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${labels.talk}${keyLabel(shortcuts.talk, "Cmd/Ctrl+Shift+Space")}`, click: () => win?.webContents.send("cheongeum:talk") },
      { label: labels.open, click: showConversation },
      {
        label: labels.settings,
        click: () => {
          showConversation();
          controllerAction({ type: "settings" });
        },
      },
      { label: labels.stop, click: () => controllerAction({ type: "stop" }) },
      ...avatarItems,
      { type: "separator" },
      ...(updates ? [updates.menuItem()] : []),
      ...(app.isPackaged
        ? [
            { label: labels.importSettings, click: () => void importSettings() },
            { label: labels.settingsFolder, click: () => void shell.openPath(app.getPath("userData")) },
          ]
        : []),
      ...(process.platform === "win32"
        ? [
            { label: labels.micSettings, click: () => void shell.openExternal("ms-settings:privacy-microphone") },
            { label: labels.soundSettings, click: () => void shell.openExternal("ms-settings:sound") },
          ]
        : []),
      { label: labels.quit, click: () => app.quit() },
    ]),
  );
}

const settingsFile = () => join(app.getPath("userData"), "settings.env");

async function importSettings() {
  const picker = await dialog.showOpenDialog({
    title: copy().selectSettings,
    properties: ["openFile", "showHiddenFiles"],
  });
  const source = picker.filePaths[0];
  if (picker.canceled || source === undefined) return;
  const target = settingsFile();
  if (existsSync(target)) {
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: copy().replaceQuestion,
      buttons: [copy().cancel, copy().replace],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return;
  }
  // Keep the previous configuration intact if a copy is interrupted.
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fsp.copyFile(source, tmp);
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, target);
    await dialog.showMessageBox({ message: copy().saved });
  } catch {
    await dialog.showMessageBox({ type: "error", message: copy().saveFailed });
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

function showConversation() {
  openRequested = true;
  if (win?.isMinimized() === true) win.restore();
  win?.show();
  win?.focus();
}

/** 대화 창(세션 주인)에 아바타·트레이에서 온 동작을 넘긴다. */
function controllerAction(action: Record<string, unknown>) {
  win?.webContents.send("cheongeum:action", action);
}

// ---------------------------------------------------------------- 아바타 창

const PREFS_FILE = () => join(app.getPath("userData"), "avatar.json");

function loadPrefs() {
  try {
    const saved: unknown = JSON.parse(readFileSync(PREFS_FILE(), "utf8"));
    if (!isRecord(saved)) return;
    prefs = {
      ...prefs,
      corner: isCorner(saved.corner) ? saved.corner : prefs.corner,
      still: saved.still === true,
      ...(isDesktopLanguage(saved.lang) ? { lang: saved.lang } : {}),
    };
  } catch {
    /* 처음 실행 */
  }
}

/** 구석·움직임·언어 설정을 저장한다. 숨기기는 이번 실행에만(다음에 켜면 다시 보인다). */
function savePrefs(patch: Partial<typeof prefs>) {
  prefs = { ...prefs, ...patch };
  try {
    writeFileSync(PREFS_FILE(), JSON.stringify({ corner: prefs.corner, still: prefs.still, lang: prefs.lang }));
  } catch {
    /* 저장하지 못하면 이번 실행에만 */
  }
  if (patch.corner !== undefined || patch.still !== undefined) {
    placeOverlay();
    sendOverlayPrefs();
  }
  if (patch.lang !== undefined) overlay?.setTitle(copy().assistant);
  updateTray();
}

function overlayLimits(area: Rectangle = screen.getPrimaryDisplay().workArea) {
  return {
    maxWidth: Math.max(1, Math.min(560, area.width - 2 * OVERLAY_MARGIN)),
    maxHeight: Math.max(1, Math.min(720, area.height - 2 * OVERLAY_MARGIN)),
  };
}

function sendOverlayPrefs() {
  sendOverlay("overlay:prefs", { corner: prefs.corner, still: prefs.still, ...overlayLimits() });
}

/** 고른 구석에 붙인다. 작업 영역(작업 표시줄 제외) 안쪽, 주 모니터 기준. */
function overlayBounds(): Rectangle {
  const area = screen.getPrimaryDisplay().workArea;
  const { maxWidth, maxHeight } = overlayLimits(area);
  const width = Math.min(overlaySize.width, maxWidth);
  const height = Math.min(overlaySize.height, maxHeight);
  const right = prefs.corner.endsWith("right");
  const bottom = prefs.corner.startsWith("bottom");
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
  if (bounds.x !== current.x || bounds.y !== current.y || bounds.width !== current.width || bounds.height !== current.height) {
    overlay.setBounds(bounds);
  }
  if (process.platform === "darwin") {
    // Bubble geometry can change under a stationary pointer.
    const point = screen.getCursorScreenPoint();
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    const interactive =
      overlayRegions.length === 0 || overlayRegions.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
    setOverlayInteractive(interactive);
  } else {
    const shape = JSON.stringify(overlayRegions);
    if (shape !== appliedShape) {
      overlay.setShape(overlayRegions);
      appliedShape = shape;
    }
  }
}

function setOverlayInteractive(active: boolean) {
  if (!overlay || active === overlayInteractive) return;
  overlay.setIgnoreMouseEvents(!active, { forward: true });
  overlayInteractive = active;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// Native hit regions use whole device-independent pixels relative to the overlay.
function hitRegions(regions: unknown, width: number, height: number): Rectangle[] {
  if (!Array.isArray(regions) || regions.length > 32) return [];
  const list: unknown[] = regions;
  const clipped: Rectangle[] = [];
  for (const r of list) {
    if (!isRecord(r) || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)) continue;
    if (r.width <= 0 || r.height <= 0) continue;
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const right = Math.min(width, Math.ceil(r.x + r.width));
    const bottom = Math.min(height, Math.ceil(r.y + r.height));
    if (right > x && bottom > y) clipped.push({ x, y, width: right - x, height: bottom - y });
  }
  return clipped;
}

function sendOverlay(channel: string, payload?: unknown) {
  if (overlay && !overlay.isDestroyed() && overlayReady) overlay.webContents.send(channel, payload);
}

function presentOverlay() {
  if (!overlay || !overlayReady || !overlayPaintReady || pendingVisibility !== undefined || prefs.hidden || quitting) return;
  placeOverlay();
  if (focusRequested) {
    focusRequested = false;
    overlay.setFocusable(true);
    overlay.show();
    overlay.focus();
    sendOverlay("overlay:focus");
  } else if (!overlay.isVisible()) {
    overlay.showInactive();
  }
}

function finishVisibility(id: unknown) {
  if (!Number.isSafeInteger(id) || id !== pendingVisibility) return;
  clearTimeout(visibilityTimeout);
  pendingVisibility = undefined;
  if (!overlay || overlay.isDestroyed() || quitting) return;
  if (prefs.hidden) overlay.hide();
  else presentOverlay();
}

// The renderer acknowledges an exit after its last frame, and an entrance as soon as
// its layout is ready to paint. A newer request always supersedes an older reply.
function requestVisibility(animate: boolean) {
  if (!overlayReady || quitting) return;
  const id = ++visibilitySequence;
  clearTimeout(visibilityTimeout);
  pendingVisibility = id;
  visibilityTimeout = setTimeout(() => finishVisibility(id), 800);
  visibilityTimeout.unref();
  sendOverlay("overlay:visibility", { id, visible: !prefs.hidden, animate: animate && !prefs.still });
}

function setOverlayHidden(hidden: boolean) {
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
function overlayAsset(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol === "blob:") return u.origin === base;
    return u.origin === base && u.pathname.startsWith("/avatar/");
  } catch {
    return false;
  }
}

function createOverlay() {
  const ses = session.fromPartition("cheongeum-avatar");
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !overlayAsset(details.url) }));
  const window = new BrowserWindow({
    ...overlayBounds(),
    title: copy().assistant,
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
      preload: join(app.getAppPath(), "overlay-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: ses,
    },
  });
  overlay = window;
  // 윈도에서 'floating'~'status'는 작업 표시줄 뒤 수준이라 최대화한 창(크롬)에 가려진다. 그보다 위 수준으로 둔다.
  window.setAlwaysOnTop(true, "pop-up-menu");
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  const resetRenderer = () => {
    clearTimeout(visibilityTimeout);
    pendingVisibility = undefined;
    overlayReady = false;
    if (window.isVisible()) window.hide();
  };
  window.webContents.on("did-start-loading", resetRenderer);
  window.webContents.on("render-process-gone", () => {
    resetRenderer();
    if (!quitting) window.webContents.reload();
  });
  window.on("blur", () => window.setFocusable(false));
  window.once("ready-to-show", () => {
    overlayPaintReady = true;
    presentOverlay();
  });
  void window.loadURL(`${base}/avatar/`);
}

const fromOverlay = (e: IpcMainEvent) => !!overlay && !overlay.isDestroyed() && e.sender === overlay.webContents;
const fromController = (e: IpcMainEvent | IpcMainInvokeEvent) => !!win && !win.isDestroyed() && e.sender === win.webContents;
const isText = (v: unknown, max = 80): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

function bindBridge() {
  ipcMain.on("cheongeum:show-setup", (e) => {
    if (fromController(e)) showConversation();
  });
  // 첫 실행 설정·이용 설정: 컴퓨터를 켤 때 청음도 켤지(대화 창만, 참/거짓만)
  ipcMain.on("cheongeum:set-auto-start", (e, on: unknown) => {
    if (fromController(e) && typeof on === "boolean") app.setLoginItemSettings({ openAtLogin: on });
  });
  ipcMain.handle("cheongeum:get-auto-start", (e) => (fromController(e) ? app.getLoginItemSettings().openAtLogin : false));
  // 대화 창 → 아바타: 표시 상태(마지막 것만 기억해 아바타가 새로 뜨면 다시 보낸다)
  ipcMain.on("cheongeum:snapshot", (e, snapshot: unknown) => {
    if (!fromController(e) || !isRecord(snapshot)) return;
    lastSnapshot = snapshot;
    if (isDesktopLanguage(snapshot.lang) && snapshot.lang !== prefs.lang) savePrefs({ lang: snapshot.lang });
    updateTooltip();
    sendOverlay("cheongeum:snapshot", snapshot);
  });
  ipcMain.on("overlay:ready", (e) => {
    if (!fromOverlay(e)) return;
    overlayReady = true;
    sendOverlayPrefs();
    sendOverlay("cheongeum:snapshot", lastSnapshot ?? { connected: false });
    requestVisibility(visibilitySequence === 0 && !prefs.hidden);
  });
  ipcMain.on("overlay:visibility-done", (e, id: unknown) => {
    if (fromOverlay(e)) finishVisibility(id);
  });
  ipcMain.on("overlay:resize", (e, size: unknown) => {
    if (!fromOverlay(e) || !isRecord(size)) return;
    const width = Math.round(Number(size.width));
    const height = Math.round(Number(size.height));
    if (!(width >= 120 && width <= 560 && height >= 120 && height <= 720)) return;
    overlaySize = { width, height };
    overlayRegions = hitRegions(size.regions, width, height);
    placeOverlay();
  });
  ipcMain.on("overlay:interactive", (e, active: unknown) => {
    if (process.platform === "darwin" && fromOverlay(e) && typeof active === "boolean") {
      setOverlayInteractive(active);
    }
  });
  // 아바타 → 대화 창: 정해진 동작만, 모양을 확인한 뒤 넘긴다
  ipcMain.on("overlay:action", (e, action: unknown) => {
    if (!fromOverlay(e) || !isRecord(action)) return;
    switch (action.type) {
      case "talk":
        win?.webContents.send("cheongeum:talk");
        return;
      case "stop":
        controllerAction({ type: "stop" });
        return;
      case "open": {
        showConversation();
        const focus = typeof action.focus === "string" && FOCUS_TARGETS.includes(action.focus) ? action.focus : undefined;
        controllerAction({ type: "reveal", focus });
        return;
      }
      case "hide":
        setOverlayHidden(true);
        return;
      case "release":
        releaseOverlayFocus();
        return;
      case "choose":
        if (isText(action.choiceSetId) && isText(action.key, 40)) {
          controllerAction({ type: "choose", choiceSetId: action.choiceSetId, key: action.key });
        }
        return;
      default:
    }
  });
}

// ---------------------------------------------------------------- 로컬 서비스

interface ServiceLaunch {
  entry: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** 설치본은 사용자 컴퓨터의 Python·uv·Node·소스 체크아웃 없이 동작한다. */
function serviceLaunch(): ServiceLaunch {
  const args = ["--host", "127.0.0.1"];
  if (app.isPackaged) {
    const runtime = join(process.resourcesPath, "runtime");
    return {
      // start.mjs only imports the bundle, so the server module's own command-line entry never matches.
      entry: join(runtime, "src", "desktop", "start.mjs"),
      args: [...args, "--env-file", settingsFile()],
      cwd: app.getPath("userData"),
      env: { CHEONGEUM_DESKTOP_RUNTIME: runtime, PLAYWRIGHT_BROWSERS_PATH: join(runtime, "browsers") },
    };
  }
  const port = process.env.DESKTOP_PORT;
  args.push("--port", port !== undefined && port !== "" ? port : "8790");
  return { entry: join(CHECKOUT, "apps", "desktop", "src", "service.ts"), args, cwd: CHECKOUT, env: {} };
}

function startService(): Promise<string> {
  const launch = serviceLaunch();
  const child = utilityProcess.fork(launch.entry, launch.args, {
    cwd: launch.cwd,
    env: { ...process.env, ...launch.env, CHEONGEUM_SETTINGS_DIR: app.getPath("userData") },
    serviceName: copy().service,
    stdio: "inherit",
  });
  service = child;
  serviceAlive = true;
  serviceExited = new Promise((done) => {
    child.once("exit", () => {
      serviceAlive = false;
      done();
    });
  });
  return new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(() => reject(new Error(copy().startTimeout)), 90_000);
    // Only trust a bound address reported over our own child's channel.
    child.on("message", (data: unknown) => {
      const url = readyUrl(data);
      if (url === undefined) return;
      clearTimeout(timeout);
      resolveUrl(url);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (base === undefined) reject(new Error(copy().serviceExit(code)));
      else if (!quitting) startupFailed(new Error(copy().serviceExit(code)));
    });
  });
}

/** 서비스가 세션·브라우저를 정리하고 끝나게 하고, 3초 안에 끝나지 않으면 끝낸다. */
function stopService(): Promise<void> {
  stopping ??= new Promise<void>((done) => {
    if (!service || !serviceAlive) {
      done();
      return;
    }
    const child = service;
    child.postMessage(SHUTDOWN);
    const kill = setTimeout(() => child.kill(), 3000);
    void serviceExited.then(() => {
      clearTimeout(kill);
      done();
    });
  });
  return stopping;
}

function startupFailed(error: unknown) {
  if (quitting) return;
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox(copy().startFailed, `${message}\n${copy().retryStart}`);
  app.quit();
}

async function createWindow() {
  // 이 앱 화면(자기 주소)에만 마이크를 허용한다.
  const ours = (url: string) => {
    try {
      return new URL(url).origin === base;
    } catch {
      return false;
    }
  };
  // 마이크는 세션을 가진 대화 창에만(아바타 창은 따로 묶인 세션이라 여기에 오지 않는다)
  const controller = (wc: WebContents) => !!win && wc === win.webContents;
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const requesting = details.requestingUrl === "" ? wc.getURL() : details.requestingUrl;
    const trusted = controller(wc) && details.isMainFrame && ours(requesting);
    const media = "mediaTypes" in details ? details.mediaTypes : undefined;
    const micOnly = permission === "media" && media?.length === 1 && media[0] === "audio";
    cb(trusted && (micOnly || permission === "speaker-selection"));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    const embedding = details.embeddingOrigin;
    const trusted = (!wc || controller(wc)) && ours(origin) && (embedding === undefined || embedding === "" || ours(embedding));
    return trusted && (permission === "speaker-selection" || (permission === "media" && details.mediaType === "audio"));
  });
  if (process.platform === "darwin") {
    await systemPreferences.askForMediaAccess("microphone").catch(() => false);
  }

  const window = new BrowserWindow({
    width: 960,
    height: 860,
    title: copy().brand,
    icon: ICON,
    autoHideMenuBar: true,
    // 백그라운드 실행이면 창을 띄우지 않는다(음성·전역 단축키로만 사용, 메뉴 막대에서 '창 보기' 가능)
    show: !BACKGROUND || openRequested,
    // 화면을 그리기 전에도 웹 UI 배경색과 같게(어두운 모드에서 흰 화면이 번쩍이지 않게)
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111018" : "#f5f4f9",
    webPreferences: {
      preload: join(app.getAppPath(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 다른 창(크롬)을 보고 있어도 음성 듣기·말하기가 멈추지 않게
      backgroundThrottling: false,
    },
  });
  win = window;
  // 앱 안에서 외부 링크를 열지 않는다(출처 링크는 기본 브라우저로).
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (e) => {
    if (!ours(e.url)) e.preventDefault();
  });
  // 백그라운드·아바타 실행에서는 창을 닫아도 앱은 계속(숨기기). 끝내려면 메뉴 막대의 '청음 종료'.
  window.on("close", (e) => {
    if ((BACKGROUND || AVATAR) && !quitting) {
      e.preventDefault();
      window.hide();
    }
  });
  // 대화 창이 새로 고쳐지거나 죽으면 아바타는 그 세션의 버튼을 더 보여 주지 않는다
  const lost = () => {
    lastSnapshot = null;
    updateTooltip();
    sendOverlay("cheongeum:snapshot", { connected: false });
  };
  window.webContents.on("did-start-loading", lost);
  const windowUrl = () => {
    const url = new URL("/", base);
    url.searchParams.set("desktop", "1");
    if (BACKGROUND) url.searchParams.set("background", "1");
    if (prefs.lang !== undefined) url.searchParams.set("desktopLang", prefs.lang);
    return url.href;
  };
  // 대화 창 화면이 죽으면 다시 불러온다(새 세션, 동의 안내부터). 그대로 두면 말하기·아바타가 아무것도 하지 않는다.
  window.webContents.on("render-process-gone", () => {
    lost();
    if (!quitting) void window.loadURL(windowUrl());
  });
  await window.loadURL(windowUrl());
}

async function startApp() {
  if (process.platform === "win32") app.setAppUserModelId("kr.cheongeum.app");
  if (BACKGROUND && process.platform === "darwin") app.dock?.hide();
  loadPrefs();
  base = await startService();
  bindBridge();
  await createWindow();
  if (AVATAR) {
    createOverlay();
    const replace = () => {
      appliedShape = undefined;
      placeOverlay();
      sendOverlayPrefs();
    };
    screen.on("display-added", replace);
    screen.on("display-removed", replace);
    screen.on("display-metrics-changed", replace);
  }
  shortcuts.talk = globalShortcut.register(TALK_KEY, () => win?.webContents.send("cheongeum:talk"));
  if (AVATAR) shortcuts.choices = globalShortcut.register(CHOICES_KEY, focusChoices);
  if (app.isPackaged && process.platform === "win32") {
    const checker = createUpdates(appUpdater(), dialog, updateTray, () => quitting, () => prefs.lang ?? "ko");
    updates = checker;
    setTimeout(() => void checker.check(false), 15_000).unref();
    setInterval(() => void checker.check(false), 24 * 60 * 60 * 1000).unref();
  }
  if (BACKGROUND || AVATAR || updates) createTray();
}

if (app.requestSingleInstanceLock()) {
  app.on("second-instance", showConversation);
  app.whenReady().then(startApp).catch(startupFailed);
} else {
  app.quit();
}

app.on("before-quit", (event) => {
  quitting = true;
  globalShortcut.unregisterAll();
  // The service runs inside this app's process tree, so let it close its browser and sessions before the app exits.
  if (serviceAlive) {
    event.preventDefault();
    void stopService().then(() => app.quit());
  }
});
app.on("window-all-closed", () => {
  if (!BACKGROUND) app.quit();
});
