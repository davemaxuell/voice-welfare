const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdates } = require('../updates.cjs');

function fixture(choices) {
  const messages = [];
  const calls = [];
  const updater = Object.assign(new EventEmitter(), {
    async checkForUpdates() {
      calls.push('check');
      return { isUpdateAvailable: true, updateInfo: { version: '1.2.3', files: [{ size: 1024 }] } };
    },
    async downloadUpdate() { calls.push('download'); },
    quitAndInstall(silent, reopen) { assert.ok(silent && reopen); calls.push('install'); },
  });
  const dialog = {
    async showMessageBox(options) {
      messages.push(options);
      return { response: options.buttons ? choices.shift() : 0 };
    },
  };
  const updates = createUpdates(updater, dialog, () => {}, () => false);
  return { updates, updater, calls, messages };
}

test('decline, download later and explicitly install from the tray', async () => {
  const { updates, updater, calls, messages } = fixture([0, 1, 0, 1]);
  await updates.check(false);
  assert.deepEqual(calls, ['check']);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  await updates.check(false);
  assert.equal(messages.length, 1, 'one automatic prompt for a deferred version per session');
  await updates.menuItem().click();
  assert.deepEqual(calls, ['check', 'check', 'check', 'download']);
  assert.match(updates.menuItem().label, /1\.2\.3/);
  await updates.check(false);
  assert.equal(calls.includes('install'), false);
  await updates.menuItem().click();
  assert.deepEqual(calls.slice(-2), ['download', 'install']);
});

test('parallel checks share one decision and failed downloads can be retried', async () => {
  const { updates, updater, messages } = fixture([1, 1, 0]);
  let attempts = 0;
  updater.downloadUpdate = async () => { if (++attempts === 1) throw new Error('checksum failed'); };
  await Promise.all([updates.check(), updates.check()]);
  assert.equal(attempts, 1);
  assert.equal(messages.at(-1).type, 'error');
  assert.equal(updates.menuItem().enabled, true);
  await updates.check();
  assert.equal(attempts, 2);
  assert.match(updates.menuItem().label, /1\.2\.3/);
});

test('offline, empty feeds and current versions never disrupt automatic startup', async () => {
  const { updates, updater, messages, calls } = fixture([]);
  updater.checkForUpdates = async () => { throw Object.assign(new Error(), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }); };
  await updates.check(false);
  assert.equal(messages.length, 0);
  await updates.check();
  assert.match(messages.at(-1).message, /릴리스/);
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  await updates.check(false);
  assert.equal(messages.length, 1);
  updater.checkForUpdates = async () => ({ isUpdateAvailable: false });
  await updates.check();
  assert.equal(messages.at(-1).buttons, undefined);
  assert.deepEqual(calls, []);
});
