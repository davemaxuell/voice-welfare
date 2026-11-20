const { _electron } = require('../.venv/Lib/site-packages/playwright/driver/package');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

async function freePort() {
  const socket = net.createServer();
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function main() {
  const port = await freePort();
  const env = { ...process.env, DESKTOP_PORT: String(port), CHEONGEUM_SHOW_WINDOW: '1',
    PILOT_PROFILE: 'shared', HEADLESS: 'true', PRACTICE_MODE: 'true', REQUIRE_CONSENT: 'true',
    READ_ONLY_CLICKS: 'safe', VISUAL_CURSOR: 'false', BROWSER_MODE: 'chromium',
    MOCK_SITE_URL: 'http://localhost:5174', WEB_SEARCH_URL: 'http://127.0.0.1:5174/external.html?q={q}',
    CHEONGEUM_DATA_DIR: '', STT_PROVIDER: 'mock', TTS_PROVIDER: 'browser', WELFARE_API_KEY: '',
    GUARDIAN_SENDER: 'preview', SOLAPI_API_KEY: '', SOLAPI_API_SECRET: '', PII_MODEL: '' };
  for (const role of ['', '_UNDERSTAND', '_GOAL', '_WEB', '_FILE', '_VISION']) env['LLM' + role + '_PROVIDER'] = 'mock';
  const app = await _electron.launch({
    executablePath: process.env.PILOT_ELECTRON_EXE || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'apps/desktop'), '--user-data-dir=' + path.join(__dirname, 'pilot-electron-profile')],
    cwd: root, env, timeout: 20000,
  });
  try {
    const page = await app.firstWindow({ timeout: 20000 });
    page.setDefaultTimeout(12000);
    await page.waitForURL('http://localhost:' + port + '/');
    const platform = await app.evaluate(() => ({ platform: process.platform, electron: process.versions.electron }));
    assert.equal(platform.platform, 'win32');
    await page.getByRole('button', { name: /동의하고 시작/ }).press('Enter');
    const box = page.getByRole('textbox', { name: /명령 입력/ });
    await box.fill('장애인연금 지원대상이 누구야?');
    await box.press('Enter');
    await page.getByRole('region', { name: '복지 제도 답변' }).getByRole('link').waitFor();
    assert.match(await page.locator('#answer-origin').innerText(), /저장된 자료/);
    await page.getByRole('button', { name: '이용 종료', exact: true }).press('Enter');
    await page.getByRole('button', { name: '새 작업 시작' }).waitFor();
    assert.equal(await page.locator('#log').innerText(), '');
    console.log(JSON.stringify({ ...platform, checks: 'Keyboard consent, stored-source card and explicit end', passed: 1 }));
  } finally {
    await app.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
