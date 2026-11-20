// 윈도 네이티브 접근성 확인: node apps/desktop/test/native-a11y.cjs
// UI Automation 트리(화면낭독기가 읽는 것), 카드가 떠도 크롬 입력 초점 유지, 실제 마우스 클릭, 실제 전역 단축키.
// 마우스와 키보드를 실제로 움직인다. 누르기 전에 그 좌표·앞 창이 시험 창인지 확인하고, 아니면 멈춘다.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { launch, until, windows } = require('./harness.cjs');

const PS = path.join(__dirname, 'native.ps1');
const WORK_TITLE = '청음 포커스 시험';

function native(...args) {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS, ...args.map(String)], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`native ${args[0]} failed: ${out.stderr}`);
  const text = out.stdout.trim();
  return text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text;
}

async function physicalPoint(app, page, selector) {
  const box = await page.locator(selector).boundingBox();
  return physicalScreenPoint(app, page, box.x + box.width / 2, box.y + box.height / 2);
}

async function physicalScreenPoint(app, page, x, y) {
  return app.evaluate(({ BrowserWindow, screen }, point) => {
    const w = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL() === point.url);
    const bounds = w.getContentBounds();
    return screen.dipToScreenPoint({ x: Math.round(bounds.x + point.x), y: Math.round(bounds.y + point.y) });
  }, { url: page.url(), x, y });
}

/** 그 좌표 맨 위 창이 기대한 창일 때만 실제로 누른다. */
function safeClick(point, expectTitle) {
  const under = native('at', point.x, point.y);
  assert.ok(under.title.includes(expectTitle), `refusing to click: "${under.title}" is under the pointer, not "${expectTitle}"`);
  native('click', point.x, point.y);
}

async function main() {
  assert.equal(process.platform, 'win32', 'Windows only');
  const { chromium } = require(path.join(__dirname, '..', '..', '..', '.venv', 'Lib', 'site-packages', 'playwright', 'driver', 'package'));
  const t = await launch({ mic: { burstAt: null } });
  const browser = await chromium.launch({ headless: false, args: ['--window-position=40,40', '--window-size=900,600'] });
  const results = {};
  try {
    const work = await browser.newPage();
    await work.setContent(`<title>${WORK_TITLE}</title><label>이름 <input id="field"></label>`);
    const { overlay, controller, app } = t;

    // 1. 화면낭독기가 읽는 트리: 버튼 이름, 상태 알림 역할
    await overlay.getByRole('button', { name: '동의하고 음성 대화 시작' }).waitFor({ timeout: 60000 });
    const tree = await until(() => {
      const rows = native('uia', '청음 도우미');
      return Array.isArray(rows) && rows.some((r) => r.name === '동의하고 음성 대화 시작') ? rows : null;
    }, { timeout: 15000, what: 'UIA tree of the overlay' });
    const buttons = tree.filter((r) => r.type === 'ControlType.Button').map((r) => r.name);
    for (const name of ['동의하고 음성 대화 시작', '동의하지 않음', '안내 보기', '말하기', '숨기기', '청음 대화 열기']) {
      assert.ok(buttons.includes(name), `UIA button "${name}" (${buttons.join(', ')})`);
    }
    const status = tree.find((r) => r.id === 'status');
    assert.ok(status, 'status line in the UIA tree');
    assert.ok(['status', '상태'].includes(status.localized), `status line announced as a status (${status.localized})`);
    const mic = tree.find((r) => r.name === '마이크 꺼짐');
    assert.ok(mic, 'microphone state readable as text');
    results.uiaButtons = buttons;
    results.statusType = `${status.type} / ${status.localized}`;
    results.unfocusable = tree.filter((r) => r.type === 'ControlType.Button' && !r.focusable).map((r) => r.name);
    await overlay.getByRole('button', { name: '동의하고 음성 대화 시작' }).click();
    await overlay.locator('#choices button').first().waitFor({ state: 'hidden' });

    // 2. 크롬 입력란에 초점을 두고, 카드가 떠도 초점·키 입력이 크롬에 남는지
    await work.bringToFront();
    native('activate', WORK_TITLE);
    await until(() => native('fg').title.includes(WORK_TITLE), { what: 'test browser activated' });
    await work.focus('#field');
    await until(() => native('fg').title.includes(WORK_TITLE), { what: 'Chrome in front' });
    const avatarPoint = await physicalPoint(app, overlay, '#avatar');
    assert.ok(native('at', avatarPoint.x, avatarPoint.y).title.includes('청음 도우미'), 'avatar stays above the browser in front');
    const box = controller.locator('#command');
    await box.fill('로그인하고 싶어');
    await box.press('Enter');
    await overlay.getByRole('button', { name: '로그인했어요' }).waitFor({ timeout: 30000 });
    await new Promise((r) => setTimeout(r, 500));
    const fgAfterCard = native('fg');
    assert.ok(fgAfterCard.title.includes(WORK_TITLE), `Chrome keeps the foreground when a card appears (got "${fgAfterCard.title}")`);
    assert.equal(await work.evaluate(() => document.hasFocus() && document.activeElement.id), 'field', 'the Chrome field keeps focus');
    native('keys', 'x', WORK_TITLE);
    await until(async () => (await work.inputValue('#field')) === 'x', { what: 'typing still reaches Chrome' });
    results.focusKeptInChrome = true;

    // 3. 실제 마우스로 카드 버튼을 눌러도 크롬이 앞 창으로 남는다(아바타 창은 초점을 가져가지 않음)
    const cancelAt = await physicalPoint(app, overlay, '#choices button:nth-child(2)');
    const figure = await overlay.locator('#figure').boundingBox();
    const bubble = await overlay.locator('#card').boundingBox();
    const gapX = figure.x - bubble.x > 32 ? bubble.x + 12 : bubble.x + bubble.width - 12;
    assert.ok(gapX < figure.x || gapX > figure.x + figure.width, 'unused desktop space beside the character');
    const gap = await physicalScreenPoint(app, overlay, gapX, figure.y + figure.height / 2);
    assert.notEqual(native('at', gap.x, gap.y).hwnd, native('at', cancelAt.x, cancelAt.y).hwnd, 'the empty area beside the avatar belongs to the underlying window');
    results.passesThroughTransparentSpace = true;
    safeClick(cancelAt, '청음 도우미');
    await overlay.locator('#choices button').first().waitFor({ state: 'hidden' });
    const fgAfterClick = native('fg');
    assert.ok(fgAfterClick.title.includes(WORK_TITLE), `real click leaves Chrome in front (got "${fgAfterClick.title}")`);
    results.realClickKeepsFocus = true;

    // 4. 전역 단축키로 선택지에 들어가 키보드로 고르고, 초점이 크롬으로 돌아온다
    await box.fill('로그인하고 싶어');
    await box.press('Enter');
    await overlay.getByRole('button', { name: '로그인했어요' }).waitFor({ timeout: 30000 });
    const registered = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+K'));
    await until(async () => overlay.getByRole('button', { name: '로그인했어요' }).isEnabled(), { what: 'handoff choice available before shortcut' });
    assert.ok(registered, 'choices shortcut registered');
    native('keys', 'ctrl+shift+k', WORK_TITLE);
    await until(async () => (await windows(app)).find((w) => w.url.includes('/avatar/')).focused, { what: 'overlay focused by the shortcut' });
    const firstFocus = await until(() => {
      const focused = native('focused');
      return focused.name === '로그인했어요' && focused;
    }, { timeout: 5000, what: 'shortcut lands on the first choice' });
    native('keys', 'tab', '청음 도우미');
    await until(() => native('focused').name === '인증 취소', { what: 'Tab moves to the next choice' });
    assert.ok((await windows(app)).find((w) => w.url.includes('/avatar/')).focused, 'still in the overlay before Enter');
    native('keys', 'enter', '청음 도우미');
    await overlay.locator('#choices button').first().waitFor({ state: 'hidden' });
    await until(() => native('fg').title.includes(WORK_TITLE), { timeout: 5000, what: 'focus returns to Chrome after the choice' });
    results.shortcutPath = [firstFocus.name, '인증 취소', 'Enter', 'back to Chrome'];

    // 5. 실제 마우스로 아바타를 누르면 대화 창이 앞에 열린다
    const avatarAt = await physicalPoint(app, overlay, '#avatar');
    safeClick(avatarAt, '청음 도우미');
    await until(async () => (await windows(app)).find((w) => w.url.includes('desktop=1')).visible, { what: 'conversation opened' });
    const conversationTitle = await controller.title();
    const fgConversation = await until(() => {
      const fg = native('fg');
      return fg.title === conversationTitle ? fg : null;
    }, { timeout: 5000, what: 'conversation in front' });
    results.avatarOpens = fgConversation.title;
    assert.deepEqual(t.errors, []);
    console.log(`PASS native-a11y ${JSON.stringify(results)}`);
  } catch (error) {
    console.log(`FAIL native-a11y: ${error.stack}`);
    console.log(JSON.stringify(results));
    process.exitCode = 1;
  } finally {
    await browser.close();
    await t.close();
  }
}

main();
