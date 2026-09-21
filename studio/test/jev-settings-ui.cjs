'use strict';
// Actual Settings DOM and IPC with a disposable profile and a dummy key.
// No conversations or model requests are created by this check.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

delete process.env.TYPESAFE_API_KEY;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-jev-settings-'));
const settingsFile = path.join(profile, 'settings.json');
app.setPath('userData', profile);
fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', telemetrySources: [], connections: [] }));
const fixtureKey = 'jev-dummy-ui-fixture';
const errors = [];
let win;
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i = 0; i < 150; i++) {
    if (await run(code)) return;
    await delay(30);
  }
  throw new Error(label);
}
const timeout = setTimeout(() => { console.error('Jev settings UI timed out:', profile); app.exit(1); }, 45000);

(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof openSettingsPanel === "function" && !!document.querySelector("#set-jev-key")', 'Settings did not initialize');
  await run('openSettingsPanel("connection")');
  assert.equal(await run('document.querySelector("#set-jev-enabled").checked'), false);
  assert.equal(await run('document.querySelector("#set-jev-auto-mode").checked'), false);
  assert.equal(await run('document.querySelector("#set-jev-key").type'), 'password');
  assert.equal((await run('reachApi.getSettings()')).connections.length, 0);

  // Saving Jev must work even before the user configures an answer provider.
  await run(`(async () => {
    document.querySelector('#set-jev-enabled').checked = true;
    document.querySelector('#set-jev-auto-mode').checked = true;
    document.querySelector('#set-jev-key').value = ${JSON.stringify(fixtureKey)};
    await document.querySelector('#btn-save-settings').onclick();
  })()`);
  let settings = await run('reachApi.getSettings()');
  assert.equal(settings.jevEnabled, true);
  assert.equal(settings.jevAutoMode, true);
  assert.equal(await run('jevAutoModeEnabled()'), true, 'The default applies to chats without an override');
  assert.equal(settings.jevKeyConfigured, true);
  assert.equal(settings.jevKeySource, 'saved');
  assert.equal(settings.jevApiKey, undefined, 'IPC must not return the saved secret');
  assert.equal(await run('document.querySelector("#set-jev-key").value'), '');
  const encrypted = safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  let disk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  if (encrypted) {
    assert.equal(disk.jevApiKey, undefined);
    assert.equal(safeStorage.decryptString(Buffer.from(disk.encryptedJevApiKey, 'base64')), fixtureKey);
  } else {
    assert.match(settings.credentialStorage.warning, /plaintext/);
  }

  // Unrelated and blank form saves preserve the existing Jev credential.
  await run(`(async () => {
    await reachApi.saveSettings({ budgets: { maxTokens: 2048 } });
    await reachApi.saveSettings({ theme: 'light' });
    await reachApi.saveSettings({ endpoint: 'http://127.0.0.1:9/v1', model: 'fixture' });
    await loadSettings();
    await document.querySelector('#btn-save-settings').onclick();
  })()`);
  settings = await run('reachApi.getSettings()');
  assert.equal(settings.jevKeyConfigured, true);
  assert.equal(settings.jevApiKey, undefined);
  assert.equal(settings.budgets.maxTokens, 2048);
  assert.equal(settings.model, 'fixture');
  assert.equal(settings.connections.length, 1);

  // The Clear button is a draft operation until the user saves.
  await run('document.querySelector("#btn-clear-jev-key").click()');
  assert.equal((await run('reachApi.getSettings()')).jevKeyConfigured, true);
  await run('document.querySelector("#btn-save-settings").onclick()');
  settings = await run('reachApi.getSettings()');
  assert.equal(settings.jevKeyConfigured, false);
  assert.equal(settings.jevKeySource, '');
  assert.equal(await run('document.querySelector("#btn-clear-jev-key").disabled'), true);
  disk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(disk.encryptedJevApiKey, undefined);
  assert.ok(!disk.jevApiKey);
  assert.deepEqual(errors, []);
  console.log('JEV SETTINGS UI PASS: empty-profile setup, password clearing, IPC redaction, key storage, unrelated saves, explicit removal.');
  console.log('Isolated profile:', profile);
  clearTimeout(timeout);
  app.exit(0);
})().catch(error => {
  console.error(error.stack || error, 'Isolated profile:', profile, errors);
  clearTimeout(timeout);
  app.exit(1);
});
