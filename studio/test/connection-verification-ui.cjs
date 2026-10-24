'use strict';
// Real connection renderer and provider validation with a disposable profile.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = process.env.REACH_OAUTH_UI_ROOT || path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-oauth-ui-'));
app.setPath('userData', profile);
const originalFetch = global.fetch;
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
let settings = { credentialStorage: { encrypted: true }, plugins: { outlook: { enabled: true, password: 'previous-token' } } };
let authorization, saves = 0, candidateChecked = false, win;
global.fetch = async (url, options) => {
  if (String(url).includes('/oauth2/v2.0/token')) return reply({ access_token: 'oauth-candidate', refresh_token: 'oauth-renew', expires_in: 3600, scope: 'Mail.Read Mail.Send' });
  if (options.headers.Authorization === 'Bearer candidate-bad') return reply({ error: {} }, 403);
  if (options.headers.Authorization === 'Bearer oauth-candidate') { assert.notEqual(settings.plugins.outlook.accessToken, 'oauth-candidate'); candidateChecked = true; }
  return reply({ value: [] });
};
const { createAppConnections } = require(path.join(root, 'agent/app-connections.cjs'));
const connections = createAppConnections({ getSettings: () => settings, saveSettings: next => { settings = next; saves++; }, clients: { microsoft: { clientId: 'fixture-microsoft' } }, openExternal: async value => {
  authorization = new URL(value);
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('code', 'fixture-code');
  assert.equal((await originalFetch(callback)).status, 200);
} });
ipcMain.handle('fixture:connections', async (_event, action, value = {}) => {
  try {
    const items = action === 'save' ? await connections.save(value.id, value.patch)
      : action === 'oauth-connect' ? await connections.connectAuthorization(value) : connections.catalog();
    return { ok: true, items };
  } catch (error) { return { ok: false, err: error.message }; }
});
const run = script => win.webContents.executeJavaScript(script, true);
async function until(script) {
  for (let i = 0; i < 100; i++) { if (await run(script)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Connection UI did not reach the expected state.');
}
const timeout = setTimeout(() => { console.error('Connection verification UI timed out.'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><div id="connections"></div>'));
  await run(fs.readFileSync(path.join(root, 'renderer/app-connections.js'), 'utf8'));
  await run(`window.panel = ReachAppConnections.mount(document.querySelector('#connections'), (action, value) => require('electron').ipcRenderer.invoke('fixture:connections', action, value)); panel.refresh();`);
  await until(`document.querySelector('[data-connection="outlook"]') !== null`);
  await run(`document.querySelector('[data-connection="outlook"] summary').click();`);
  const changeToken = value => run(`{ const input = document.querySelector('[data-connection="outlook"] input[type="password"]'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input')); }`);
  const click = label => run(`[...document.querySelectorAll('[data-connection="outlook"] button')].find(button => button.textContent === ${JSON.stringify(label)}).click();`);
  await changeToken('candidate-bad'); await click('Save');
  await until(`document.querySelector('.app-connection-notice').textContent.includes('HTTP 403')`);
  assert.equal(saves, 0);
  assert.equal(settings.plugins.outlook.password, 'previous-token');
  assert.equal(await run(`document.querySelector('[data-connection="outlook"] input[type="password"]').value`), 'candidate-bad');
  await changeToken('candidate-good'); await click('Save');
  await until(`document.querySelector('[data-connection="outlook"] .app-connection-badge').textContent === 'Connected'`);
  assert.equal(settings.plugins.outlook.password, 'candidate-good');
  await run(`{ const label = [...document.querySelectorAll('[data-connection="outlook"] label')].find(label => label.textContent.includes('Also allow sending')); const input = label.querySelector('input'); input.checked = true; input.dispatchEvent(new Event('change')); }`);
  await click('Reconnect Microsoft');
  await until(`document.querySelector('[data-connection="outlook"] .app-connection-note').textContent.includes('Reading and sending permitted')`);
  assert.match(authorization.searchParams.get('scope'), /Mail\.Send/);
  assert.equal(candidateChecked, true);
  assert.equal(settings.plugins.outlook.accessToken, 'oauth-candidate');
  assert.equal(settings.plugins.outlook.password, '');
  console.log(JSON.stringify({ pass: true, failedSavePreservedCredential: true, failedSavePreservedDraft: true, verifiedSaveConnected: true, outlookSendConsent: true, grantCheckedBeforeSave: true, profile, root }));
  clearTimeout(timeout); connections.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
