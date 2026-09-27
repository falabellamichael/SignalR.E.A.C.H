'use strict';
// Run with Electron. Disposable renderer fixture; no VS Code profile, wallet,
// account credentials or network requests are used.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-vscode-account-ui-'));
app.setPath('userData', path.join(directory, 'profile'));
const media = path.resolve(__dirname, '../vscode/media');
const bootstrap = `
window.fixtureConfig = {provider:'endpoint',providerSelection:'endpoint',endpoint:'https://fixture.invalid/v1',freeEndpoint:'https://fixture.invalid/v1',additionalEndpoints:[],maxTokens:0,agentMaxRounds:0};
window.fixtureAccount = {status:'disconnected',baseUrl:'https://accounts.invalid',secureStorageAvailable:true,config:{enabled:true,redemptionEnabled:true,tokensPerRch:'1000000'}};
window.fixturePosts = [];
window.fixtureReceive = message => window.dispatchEvent(new MessageEvent('message', {data:message}));
window.acquireVsCodeApi = () => ({getState:()=>({}),setState:()=>{},postMessage:message=>{
 window.fixturePosts.push(message);
 queueMicrotask(()=>{
  if(message.type==='getConfig') fixtureReceive({type:'config',...fixtureConfig});
  if(message.type==='fetchModels') fixtureReceive({type:'models',provider:'endpoint',providerSelection:'endpoint',models:['fixture-model'],endpoint:fixtureConfig.endpoint});
  if(message.type==='setConfig') {fixtureConfig[message.key]=message.value;fixtureReceive({type:'configSaved',key:message.key,config:fixtureConfig});}
  if(message.type==='account') {
   if(message.action==='connect') fixtureAccount={...fixtureAccount,status:'connecting'};
   if(message.action==='cancel'||message.action==='disconnect') fixtureAccount={...fixtureAccount,status:'disconnected',account:null};
   if(message.action==='configure') fixtureAccount={...fixtureAccount,baseUrl:message.value};
   fixtureReceive({type:'accountState',state:fixtureAccount,completed:true,requestId:message.requestId});
  }
 });
}});
`;
let html = fs.readFileSync(path.join(media, 'chat.html'), 'utf8');
for (const [key, value] of Object.entries({ nonce: 'account-fixture', cspSource: 'file:',
  styleUri: pathToFileURL(path.join(media, 'style.css')).href,
  scriptUri: pathToFileURL(path.join(media, 'chat.js')).href,
  agentRunUri: pathToFileURL(path.join(media, 'agent-run.js')).href,
  accountViewUri: pathToFileURL(path.join(media, 'account-view.js')).href,
  toolNames: '[]' })) html = html.replaceAll('{{' + key + '}}', value);
html = html.replace('<body>', '<body><script nonce="account-fixture">' + bootstrap + '</script>');
const fixture = path.join(directory, 'fixture.html'); fs.writeFileSync(fixture, html);
const errors = [], network = [];
let win;
const pause = () => new Promise(resolve => setTimeout(resolve, 35));
const run = async source => { const result = await win.webContents.executeJavaScript(source, true); await pause(); return result; };
const click = id => run(`document.getElementById(${JSON.stringify(id)}).click()`);
const timeout = setTimeout(() => { console.error('VS Code account UI timed out'); app.exit(1); }, 45000);
(async () => {
  await app.whenReady();
  win = new BrowserWindow({ width: 360, height: 780, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(fixture); await pause();
  assert.equal(await run("document.querySelector('#settings-panel').hidden"), true);
  await click('settings-btn');
  assert.equal(await run("document.querySelector('#settings-btn').getAttribute('aria-expanded')"), 'true');
  assert.equal(await run('document.activeElement.id'), 'account-tab-account');
  assert.equal(await run("document.querySelector('#account-connect').disabled"), false);
  await click('account-connect');
  assert.match(await run("document.querySelector('#account-status').textContent"), /Waiting/);
  await click('account-cancel');
  assert.equal(await run("document.querySelector('#account-connect').disabled"), false);
  assert.equal(await run("fixturePosts.filter(p=>p.type==='account'&&p.action==='cancel').length"), 1);
  const connected = { status: 'connected', baseUrl: 'https://accounts.invalid', secureStorageAvailable: true,
    config: { enabled: true, redemptionEnabled: true, tokensPerRch: '1000000' },
    account: { walletAddress: '0x0000000000000000000000000000000000000001', plan: { name: 'Professional', status: 'active' },
      allowedModels: [{ id: 'fixture-model' }], allowance: { includedRemaining: '1200000', prepaidRemaining: '3000000', totalRemaining: '4200000', reserved: '10000', debt: '0' },
      rchBalance: { status: 'available', decimals: 18, balanceBaseUnits: '269565909309000000001' } } };
  await run(`fixtureAccount=${JSON.stringify(connected)};fixtureReceive({type:'accountState',state:fixtureAccount})`);
  assert.match(await run("document.querySelector('.account-summary').textContent"), /4,200,000/);
  assert.match(await run("document.querySelector('.account-summary').textContent"), /269.565909309000000001 RCH/);
  assert.equal(await run("document.querySelector('#account-redeem').disabled"), false);
  await run("fixtureAccount={...fixtureAccount,config:{...fixtureAccount.config,redemptionEnabled:false}};fixtureReceive({type:'accountState',state:fixtureAccount})");
  assert.equal(await run("document.querySelector('#account-redeem').disabled"), true);
  assert.match(await run("document.querySelector('.account-body').textContent"), /verified market quote/);
  assert.doesNotMatch(await run("document.querySelector('.account-body').textContent"), /1 RCH =/);
  await run(`fixtureAccount=${JSON.stringify(connected)};fixtureReceive({type:'accountState',state:fixtureAccount})`);
  await run("let a=document.querySelector('#account-amount');a.value='1.25';a.dispatchEvent(new Event('input'));let u=document.querySelector('#account-service');u.value='https://draft.invalid';u.dispatchEvent(new Event('input'))");
  await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await run('document.activeElement.id'), 'settings-btn');
  assert.equal(await run("document.querySelector('#settings-panel').hidden"), true);
  await run("document.querySelector('#settings-btn').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");
  assert.equal(await run("document.querySelector('#account-amount').value"), '1.25');
  assert.equal(await run("document.querySelector('#account-service').value"), 'https://draft.invalid');
  for (const width of [280, 360, 640]) {
    win.setContentSize(width, 780); await pause();
    const geometry = await run("(() => {const p=document.querySelector('#settings-panel'),r=p.getBoundingClientRect(),b=document.querySelector('#settings-btn').getBoundingClientRect();return {overflow:p.scrollWidth>p.clientWidth+1,clipped:r.left<0||r.right>innerWidth||r.bottom>innerHeight,bubble:b.right<=innerWidth&&b.left>=0};})()");
    assert.deepEqual(geometry, { overflow: false, clipped: false, bubble: true }, 'account geometry ' + width);
    fs.writeFileSync(path.join(directory, `account-${width}.png`), (await win.capturePage()).toPNG());
  }
  win.setContentSize(320, 780); await pause();
  await click('account-tab-budgets');
  await run("let label=[...document.querySelectorAll('.setting-row label')].find(e=>e.textContent==='Agent rounds');let i=label.parentElement.querySelector('input');i.value='137';i.dispatchEvent(new Event('change',{bubbles:true}))");
  await click('account-close'); await click('settings-btn');
  assert.equal(await run("document.querySelector('#settings-panel').hidden"), false, 'reopened budgets');
  assert.equal(await run("[...document.querySelectorAll('.setting-row label')].find(e=>e.textContent==='Agent rounds').parentElement.querySelector('input').value"), '137');
  await click('account-tab-connection');
  assert.equal(await run("document.querySelector('#settings-panel').hidden"), false, 'settings tab stays open');
  assert.equal(await run("document.querySelector('#settings-panel').scrollWidth<=document.querySelector('#settings-panel').clientWidth+1"), true);
  await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(directory, 'settings-320.png'), (await win.capturePage()).toPNG());
  await run("document.querySelector('#account-tab-connection').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  assert.equal(await run('document.activeElement.id'), 'account-tab-account');
  assert.equal(await run("document.querySelector('#account-amount').value"), '1.25');
  await click('account-redeem');
  assert.equal(await run("fixturePosts.filter(p=>p.type==='account'&&p.action==='redeem').at(-1).value"), '1.25');
  await run("fixtureAccount={...fixtureAccount,status:'expired',account:null};fixtureReceive({type:'accountState',state:fixtureAccount})");
  assert.match(await run("document.querySelector('#account-status').textContent"), /expired/);
  assert.equal(await run("document.querySelector('.account-summary')"), null);
  assert.equal(await run("document.querySelector('#account-connect').disabled"), false);
  await run("document.querySelector('#log').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  assert.equal(await run("document.querySelector('#settings-panel').hidden"), true);
  assert.equal(await run("document.querySelector('#settings-btn').getAttribute('aria-expanded')"), 'false');
  assert.deepEqual(network, []); assert.deepEqual(errors, []);
  console.log('VSCODE ACCOUNT UI PASS', directory);
  clearTimeout(timeout); app.exit(0);
})().catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
