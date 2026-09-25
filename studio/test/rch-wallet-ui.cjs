'use strict';
// Run with Electron. Serves the actual RCH wallet assets on loopback, with a
// synthetic EIP-1193 provider and a deterministic account-service stub. No keys,
// RPC provider, real signing, transactions, or personal browser profile involved.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rch-wallet-ui-'));
const assets = path.resolve(__dirname, '../../RCH/service/public');
app.setPath('userData', dir);
const address = '0x0000000000000000000000000000000000000001';
const hash = '0x' + 'a'.repeat(64);
const replacementHash = '0x' + 'b'.repeat(64);
const requests = [], errors = [];
let submitMode = 'unavailable', recorded = false;
const publicConfig = { enabled: true, chainId: 11155111, redemptionEnabled: true, tokensPerRch: 1000000 };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const mapping = { '/wallet/connect': ['wallet.html', 'text/html'], '/wallet/redeem': ['wallet.html', 'text/html'], '/wallet/app.js': ['wallet.js', 'text/javascript'], '/wallet/style.css': ['wallet.css', 'text/css'] };
  res.setHeader('cache-control', 'no-store');
  if (mapping[url.pathname]) {
    const [file, type] = mapping[url.pathname];
    res.setHeader('content-type', type);
    res.end(fs.readFileSync(path.join(assets, file))); return;
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  requests.push({ path: url.pathname, body, tunnelHeader: req.headers['ngrok-skip-browser-warning'] });
  let value, status = 200;
  if (url.pathname === '/v1/account/config') value = publicConfig;
  else if (url.pathname === '/v1/auth/challenge') value = { challengeId: 'fixture-challenge', message: 'Fixture REACH wallet sign-in\nNo token transaction or payment.', address };
  else if (url.pathname === '/v1/auth/verify') value = { status: 'verified' };
  else if (url.pathname === '/v1/redemptions/details') value = { redemptionId: 'fixture-redemption', walletAddress: address, chainId: 11155111, amountRch: '2.5', usageTokens: 2500000,
    status: recorded ? 'pending' : 'ready', ...(recorded ? { txHash: hash, signingUnavailableReason: 'already_submitted' } : {}),
    transaction: recorded ? null : { to: '0x0000000000000000000000000000000000000002', data: '0x1234', value: '0x0' } };
  else if (url.pathname === '/v1/redemptions/submit') {
    if (submitMode === 'unavailable') { status = 503; value = { error: { message: 'Fixture service unavailable; keep the transaction hash.' } }; }
    else if (submitMode === 'failed') value = { status: 'pending', reason: 'transaction_failed' };
    else if (submitMode === 'pending') { recorded = true; value = { status: 'pending', reason: 'awaiting_finality' }; }
    else { recorded = true; value = { status: 'credited' }; }
  } else { status = 404; value = { error: { message: 'Unknown fixture route.' } }; }
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
});
let win;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, message) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await run(code)) return; await sleep(20); }
  throw new Error(message);
}
const walletFixture = `(() => {
  const state = window.walletFixture = { calls: [], holdAccounts: false, holdSign: false, holdSend: false };
  window.ethereum = { request: async ({method, params}) => {
    state.calls.push({method, params});
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_requestAccounts') {
      if (state.holdAccounts) return new Promise(resolve => { state.accountsGate = resolve; });
      return [${JSON.stringify(address)}];
    }
    if (method === 'personal_sign') {
      if (state.holdSign) return new Promise((resolve, reject) => { state.signGate = {resolve, reject}; });
      return '0xfixture-signature';
    }
    if (method === 'eth_sendTransaction') {
      if (state.holdSend) return new Promise(resolve => { state.sendGate = resolve; });
      return ${JSON.stringify(hash)};
    }
    throw new Error('Unexpected fixture wallet method: ' + method);
  } };
})()`;
let navigation = 0;
async function load(route) {
  const target = new URL(route, origin);
  target.searchParams.set('fixture', String(++navigation));
  await win.loadURL(target.href);
  await until("document.querySelector('#primary') !== null && typeof config !== 'undefined' && config !== null", 'Wallet page did not load its config');
  await run(walletFixture);
}
let origin;
const timeout = setTimeout(() => { console.error('RCH wallet UI timed out'); server.close(); app.exit(1); }, 120000);
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1080, height: 1100, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  win.webContents.on('console-message', event => {
    if (event.level === 'error' && !/Failed to load resource.*503/.test(event.message)) errors.push(event.message);
  });

  await load('/wallet/connect#flow=fixture-flow');
  assert.equal(await run("document.querySelector('#message').hidden"), true);
  await run("walletFixture.holdAccounts = true; document.querySelector('#primary').click(); document.querySelector('#primary').dispatchEvent(new MouseEvent('click'))");
  await until('!!walletFixture.accountsGate', 'Account request not pending');
  assert.equal(await run("walletFixture.calls.filter(call => call.method === 'eth_requestAccounts').length"), 1);
  assert.equal(requests.filter(request => request.path === '/v1/auth/challenge').length, 0);
  await run(`walletFixture.holdAccounts = false; walletFixture.accountsGate([${JSON.stringify(address)}])`);
  await until("!document.querySelector('#message').hidden && !document.querySelector('#primary').disabled", 'Sign-in challenge was not shown');
  assert.equal(await run("document.querySelector('#primary').textContent"), 'Sign in with wallet');
  assert.equal(requests.filter(request => request.path === '/v1/auth/verify').length, 0);
  assert.equal(await run("walletFixture.calls.some(call => call.method === 'personal_sign' || call.method === 'eth_sendTransaction')"), false);
  console.log('PASS two-step sign-in and concurrent wallet-request guard');

  await run("walletFixture.holdSign = true; document.querySelector('#primary').click(); document.querySelector('#primary').dispatchEvent(new MouseEvent('click'))");
  await until('!!walletFixture.signGate', 'Signature request not pending');
  assert.equal(await run("walletFixture.calls.filter(call => call.method === 'personal_sign').length"), 1);
  await run("walletFixture.holdSign = false; walletFixture.signGate.reject(Object.assign(new Error('Declined'), {code:4001}))");
  await until("document.querySelector('#status').textContent.includes('cancelled') && !document.querySelector('#primary').disabled", 'Declined signature did not leave a usable retry');
  assert.equal(requests.filter(request => request.path === '/v1/auth/verify').length, 0);
  assert.equal(await run("getComputedStyle(document.querySelector('#primary')).backgroundColor"), 'rgb(199, 169, 72)');
  assert.match(await run("getComputedStyle(document.querySelector('h1')).fontFamily"), /Georgia/);
  fs.writeFileSync(path.join(dir, 'wallet-sign-in.png'), (await win.capturePage()).toPNG());
  await run("document.querySelector('#primary').click()");
  await until("document.querySelector('#primary').hidden", 'Successful sign-in did not complete');
  assert.equal(requests.filter(request => request.path === '/v1/auth/verify').length, 1);
  assert(requests.every(request => request.tunnelHeader === '1'), 'Wallet API calls must reach the account service through ngrok');
  assert.equal(await run("walletFixture.calls.some(call => call.method === 'eth_sendTransaction')"), false);
  console.log('PASS declined signature recovery and verified sign-in without transaction');

  submitMode = 'unavailable'; recorded = false;
  await load('/wallet/redeem#id=fixture-redemption&ticket=fixture-ticket');
  await until("!document.querySelector('#details').hidden && !document.querySelector('#primary').disabled", 'Redemption did not become ready');
  await run("walletFixture.holdSend = true; document.querySelector('#primary').click(); document.querySelector('#primary').dispatchEvent(new MouseEvent('click'))");
  await until('!!walletFixture.sendGate', 'Transaction request not pending');
  assert.equal(await run("walletFixture.calls.filter(call => call.method === 'eth_sendTransaction').length"), 1);
  assert.equal(await run("document.querySelector('#recover').disabled"), true);
  await run(`walletFixture.holdSend = false; walletFixture.sendGate(${JSON.stringify(hash)})`);
  await until("document.querySelector('#status').textContent.includes('Fixture service unavailable')", 'Post-broadcast service failure not reported');
  assert.equal(await run("document.querySelector('#txHash').value"), hash);
  assert.equal(await run("document.querySelector('#primary').disabled"), true);
  assert.equal(await run("document.querySelector('#recovery').hidden"), false);
  await run("document.querySelector('#primary').click()");
  assert.equal(await run("walletFixture.calls.filter(call => call.method === 'eth_sendTransaction').length"), 1);
  fs.writeFileSync(path.join(dir, 'wallet-broadcast-recovery.png'), (await win.capturePage()).toPNG());
  console.log('PASS one broadcast while pending and preserved hash after service failure');

  submitMode = 'failed';
  await run("document.querySelector('#recover').click()");
  await until("document.querySelector('#status').textContent.includes('transaction failed')", 'Failed transaction does not have actionable recovery text');
  assert.match(await run("document.querySelector('#status').textContent"), /successful replacement|new redemption/);
  assert.equal(await run("document.querySelector('#primary').disabled"), true);
  submitMode = 'pending';
  await run(`document.querySelector('#txHash').value=${JSON.stringify(replacementHash)}; document.querySelector('#recover').click()`);
  await until("document.querySelector('#status').textContent.includes('after finality')", 'Replacement transaction recovery not acknowledged');
  assert.equal(requests.filter(request => request.path === '/v1/redemptions/submit').at(-1).body.txHash, replacementHash);
  submitMode = 'credited';
  await run("document.querySelector('#recover').click()");
  await until("document.querySelector('#status').textContent.includes('Usage credit confirmed')", 'Confirmed credit was not displayed');
  assert.equal(await run("walletFixture.calls.filter(call => call.method === 'eth_sendTransaction').length"), 1);
  assert.equal(await run("document.querySelector('#primary').disabled"), true);
  console.log('PASS failed transaction explanation, replacement-hash recovery and credit confirmation');

  // A pasted hash means a broadcast may already exist. Failed receipt delivery
  // must not invite a second burn from the same page.
  submitMode = 'unavailable'; recorded = false;
  await load('/wallet/redeem#id=fixture-redemption&ticket=fixture-ticket');
  await until("!document.querySelector('#details').hidden && !document.querySelector('#primary').disabled", 'Fresh recovery page did not load');
  await run(`document.querySelector('#txHash').value=${JSON.stringify(hash)}; document.querySelector('#recover').click()`);
  await until("document.querySelector('#status').textContent.includes('Fixture service unavailable')", 'Manual recovery service error was not shown');
  assert.equal(await run("document.querySelector('#primary').disabled"), true, 'Manual recovery after a broadcast must not re-enable another burn');
  assert.equal(await run("walletFixture.calls.some(call => call.method === 'eth_sendTransaction')"), false);
  win.setContentSize(390, 900); await sleep(80);
  assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
  fs.writeFileSync(path.join(dir, 'wallet-recovery-mobile.png'), (await win.capturePage()).toPNG());
  console.log('PASS manual hash recovery keeps signing disabled and mobile has no overflow');
  assert.deepEqual(errors, []);
  console.log('RCH WALLET UI PASS', dir);
  clearTimeout(timeout); await new Promise(resolve => server.close(resolve)); app.exit(0);
})().catch(error => { console.error(error.stack); console.error('RCH WALLET UI EVIDENCE', dir); clearTimeout(timeout); server.close(); app.exit(1); });
