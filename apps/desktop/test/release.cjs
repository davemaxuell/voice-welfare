// Exercise the built release in Electron with a private update cache and a loopback feed.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function launchTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheongeum-release-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'update-test', version: '0.0.0', main: 'main.cjs' }));
    fs.writeFileSync(path.join(dir, 'main.cjs'), 'require(' + JSON.stringify(__filename) + ')');
    const child = spawnSync(require('electron'), [dir], {
      env: { ...process.env, LOCALAPPDATA: dir }, stdio: 'inherit', timeout: 180_000, windowsHide: true,
    });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, 'the built release must pass the updater test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function testRelease(app) {
  app.setPath('userData', app.getAppPath());
  app.disableHardwareAcceleration();
  await app.whenReady();
  const dist = path.resolve(process.env.CHEONGEUM_TEST_DIST || path.join(__dirname, '../dist'));
  const resources = path.join(dist, 'win-unpacked', 'resources');
  const asar = path.join(resources, 'app.asar');
  const { version } = require(path.join(asar, 'package.json'));
  const setup = `Cheongeum-Setup-${version}.exe`;
  const yaml = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
  const bytes = fs.statSync(path.join(dist, setup)).size;
  assert.ok(fs.statSync(path.join(dist, setup + '.blockmap')).size > 0);
  const config = fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8');
  assert.match(config, /^provider: github\s*$/m);
  assert.match(config, /^owner: davemaxuell\s*$/m);
  assert.match(config, /^repo: voice-welfare\s*$/m);
  let downloads = 0;
  const feed = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1').pathname;
    if (url === '/latest.yml') return res.end(yaml);
    if (url === '/' + setup) {
      downloads++;
      res.writeHead(200, { 'Content-Length': bytes, 'Content-Type': 'application/octet-stream' });
      return fs.createReadStream(path.join(dist, setup)).pipe(res);
    }
    res.writeHead(404).end();
  });
  feed.listen(0, '127.0.0.1');
  await once(feed, 'listening');
  try {
    const { NsisUpdater, createUpdates } = require(path.join(asar, 'updates.cjs'));
    const updater = new NsisUpdater();
    updater.forceDevUpdateConfig = true;
    updater.disableDifferentialDownload = true;
    updater.updateConfigPath = path.join(resources, 'app-update.yml');
    updater.setFeedURL({ provider: 'generic', url: 'http://127.0.0.1:' + feed.address().port });
    const choices = [0, 1, 0];
    const prompts = [];
    const dialog = { async showMessageBox(options) {
      prompts.push(options);
      return { response: choices.shift() };
    } };
    const updates = createUpdates(updater, dialog, () => {}, () => false);
    await updates.check(false);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].message.includes(version));
    assert.equal(downloads, 0, 'deferring an update must not fetch the installer');
    await updates.menuItem().click();
    assert.equal(downloads, 1);
    assert.equal(prompts.length, 3);
    assert.equal(prompts[2].type, 'question', 'the real installer must pass checksum verification');
    assert.ok(updates.menuItem().label.includes(version), 'a deferred install is available from the tray');
    assert.equal(updater.autoInstallOnAppQuit, false);
    console.log(`PASS update offer, consent and SHA-512 verified download of ${setup} (${bytes} bytes)`);
  } finally {
    feed.close();
    feed.closeAllConnections();
  }
}

if (process.versions.electron) {
  const { app } = require('electron');
  testRelease(app).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
} else {
  launchTest();
}
