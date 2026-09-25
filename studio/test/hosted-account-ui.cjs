'use strict';
// Run with Electron. Uses a disposable profile and synthetic public account
// state; never reads a real wallet, signs a message, or contacts a provider.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-account-ui-'));
app.setPath('userData', dir);
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [], connections: [] }));
let win; const errors = [];
app.on('browser-window-created', (_event, window) => {
  win = window; setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
const timeout = setTimeout(() => { console.error('Account UI timed out'); app.exit(1); }, 120000);
(async () => {
  console.log('Account UI: loading isolated Studio');
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  console.log('Account UI: waiting for Electron');
  await app.whenReady();
  console.log('Account UI: Electron ready');
  while (!win || win.webContents.isLoading()) await delay(50);
  await run("showTab('home')"); await delay(150);
  assert.equal(await run("document.querySelector('#home-account-connect').disabled"), true);
  assert.equal(await run("document.querySelector('#home-account-service').value"), 'https://unbent-semicolon-hermit.ngrok-free.dev');
  const account = { status: 'connected', baseUrl: 'https://fixture.invalid', connectionId: 'reach_hosted', secureStorageAvailable: true,
    account: { id: 'fixture', walletAddress: '0x0000000000000000000000000000000000000001', plan: { name: 'Professional', status: 'active' },
      allowedModels: [{ id: 'CodeGPT test model', name: 'CodeGPT test model' }, { id: 'Free endpoint test model', name: 'Free endpoint test model' }],
      allowance: { includedRemaining: '1200000', prepaidRemaining: '3000000', reserved: '10000', totalRemaining: '4190000', debt: '0' } },
    config: { redemptionEnabled: true, tokensPerRch: '1000000', chainId: 11155111 } };
  win.webContents.send('account:state', account); await delay(100);
  assert.equal(await run("document.querySelector('#home-account-plan').textContent"), 'Professional');
  assert.equal(await run("document.querySelector('#home-allowance-included').textContent"), '1,200,000');
  assert.equal(await run("document.querySelectorAll('#home-account-models span').length"), 2);
  assert.equal(await run("document.querySelector('#home-account-use').disabled"), false);
  await run("document.querySelector('#home-redemption-amount').value='2'; document.querySelector('#home-redemption-amount').dispatchEvent(new Event('input'))");
  assert.equal(await run("document.querySelector('#home-redemption-start').disabled"), false);
  win.setContentSize(1440, 1050);
  await run("document.querySelector('#home-subscription-title').scrollIntoView({block:'start'})"); await delay(100);
  fs.writeFileSync(path.join(dir, 'account-wide.png'), (await win.capturePage()).toPNG());
  win.setContentSize(900, 1000); await delay(100);
  assert.equal(await run("document.querySelector('.home-content').scrollWidth <= document.querySelector('.home-content').clientWidth + 1"), true);
  fs.writeFileSync(path.join(dir, 'account-narrow.png'), (await win.capturePage()).toPNG());
  win.webContents.send('account:state', { ...account, status: 'connecting', account: null }); await delay(80);
  assert.equal(await run("document.querySelector('#home-account-cancel').hidden"), false);
  assert.equal(await run("document.querySelector('#home-redemption-start').disabled"), true);
  win.webContents.send('account:state', { ...account, status: 'expired', account: null }); await delay(80);
  assert.equal(await run("document.querySelector('#home-account-connect').disabled"), false);
  assert.equal(await run("document.querySelector('#home-allowance-included').textContent"), '—');
  assert.deepEqual(errors, []);
  console.log('ACCOUNT UI PASS', dir); clearTimeout(timeout); app.exit(0);
})().catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
