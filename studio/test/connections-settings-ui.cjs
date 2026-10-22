'use strict';
// Exercise real Studio IPC and the legacy Settings save with disposable credentials.
const { app, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { createSettingsStore } = require('../agent/settings-store.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-connections-ui-'));
app.setPath('userData', profile);
let win;
let authorizationFocus = 0;
app.on('browser-window-created', (_event, window) => {
  if (!win) win = window;
  window.show = () => { authorizationFocus++; };
  window.focus = () => {};
  setImmediate(() => window.removeAllListeners('ready-to-show'));
});
const timeout = setTimeout(() => { console.error('Connections Settings test timed out'); app.exit(1); }, 60000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i = 0; i < 250; i++) { if (await run(code)) return; await delay(40); }
  throw new Error(label);
}
const requests = [];
const browserUrls = [];
const discordJobs = [], discordReplies = [];
shell.openExternal = async url => { browserUrls.push(url); };
require('../agent/oauth-clients.cjs').loadClients = () => ({ google: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-desktop' }, github: { clientId: 'fixture-client' }, discord: { clientId: 'fixture-discord', brokerOrigin: 'https://fixture-broker.example' } });
global.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), authorization: options.headers?.Authorization });
  if (String(url).startsWith('https://fixture-broker.example/')) {
    let result = { sent: true, accepted: true };
    if (String(url).endsWith('chat-poll')) {
      if (!discordJobs.length) await require('node:timers/promises').setTimeout(30, undefined, { signal: options.signal });
      result = { gateway: 'online', userId: '223456789012', ...(discordJobs.length ? { job: discordJobs.shift() } : { pending: true }) };
    } else if (String(url).endsWith('chat-reply')) { const body = JSON.parse(options.body); if (body.content) discordReplies.push(body.content); }
    return { ok: true, status: 200, json: async () => result };
  }
  if (String(url).includes('/chat/completions')) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ status: 'complete', message: 'Discord fixture response.', actions: [], options: [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }) };
  const data = String(url).endsWith('/device/code') ? { device_code: 'private-device-fixture', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
    : String(url).endsWith('/login/oauth/access_token') ? { access_token: 'fixture-oauth-github', refresh_token: 'fixture-refresh-github', expires_in: 28800, scope: 'repo read:user' }
    : String(url).endsWith('/models') ? { data: [{ id: 'fixture' }] } : String(url).includes('gmail.googleapis.com') ? { emailAddress: 'fixture@example.test' } : { value: [], files: [], items: [], login: 'fixture' };
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
};
(async () => {
  const plugins = {
    github: { enabled: true, token: 'fixture-github' },
    gmail: { enabled: true, password: 'fixture-gmail', email: 'fixture@example.test' },
    outlook: { enabled: true, password: 'fixture-outlook', email: 'fixture@example.test' },
    drive: { enabled: true, token: 'fixture-drive' },
    todo: { enabled: true, token: 'fixture-todo' },
    discord: { enabled: true, clientId: 'fixture-discord', accessToken: 'fixture-discord-access', refreshToken: 'fixture-discord-renew', expiresAt: Date.now() + 3600000 },
  };
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ plugins, theme: 'dark', telemetrySources: [], mcpServers: [], connections: [{ id: 'fixture', name: 'Fixture', endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', enabled: true }], activeConnection: 'fixture' }));
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof openSettingsPanel === "function" && typeof renderMcp === "function"', 'Renderer startup');
  await run('openSettingsPanel("mcp")');
  await until('typeof mcpSettingsRevision === "string" && mcpSettingsRevision.length > 0', 'MCP settings loaded');
  assert.equal(await run('Object.keys(pluginDraft).length'), 3, 'Hidden legacy draft is incomplete');
  await run('document.querySelector("#btn-save-mcp").onclick()');
  assert.equal(await run('document.querySelector("#mcp-status").textContent'), 'Saved.');
  const storage = createSettingsStore({ file: () => path.join(profile, 'settings.json'), safeStorage });
  for (const [id, original] of Object.entries(plugins)) for (const [key, value] of Object.entries(original)) assert.equal(storage.load().plugins[id][key], value, id + ' preserved');
  const longToken = 'opaque+/' + 'x'.repeat(2048) + '==';
  const saved = await run(`reachApi.appConnections.command('save', { id:'todo', patch:{ token:${JSON.stringify('Bearer ' + longToken)}, enabled:true } })`);
  assert.equal(saved.ok, true);
  assert.equal(storage.load().plugins.todo.token, longToken);
  for (const id of ['gmail', 'outlook', 'drive', 'todo']) {
    const result = await run(`reachApi.appConnections.command('check', {id:${JSON.stringify(id)}})`);
    assert.equal(result.items.find(item => item.id === id).status.state, 'connected', id + ' check');
  }
  assert.ok(requests.some(item => item.authorization === 'Bearer ' + longToken));
  assert.ok(!JSON.stringify(await run('reachApi.getSettings()')).includes('fixture-gmail'));
  assert.ok(!fs.readFileSync(path.join(profile, 'settings.json'), 'utf8').includes(longToken));
  win.webContents.reload();
  await until('typeof openSettingsPanel === "function" && !document.readyState.includes("loading")', 'Reloaded renderer');
  const reopened = await run('reachApi.appConnections.command("list")');
  assert.equal(reopened.items.find(item => item.id === 'todo').configured, true);
  assert.equal(reopened.items.find(item => item.id === 'drive').configured, true);
  const discordSettings = await run(`reachApi.appConnections.command('save', {id:'discord',patch:{chatEnabled:true,workspace:''}})`);
  assert.equal(discordSettings.ok, true);
  assert.equal(discordSettings.items.find(item => item.id === 'discord').chat.enabled, true);
  await run(`window.oauthTestHost = document.createElement('div'); document.body.append(oauthTestHost); window.oauthTestPanel = ReachAppConnections.mount(oauthTestHost, reachApi.appConnections.command); oauthTestPanel.refresh()`);
  await until(`!!oauthTestHost.querySelector('[data-connection="github"]')`, 'OAuth card rendered');
  assert.equal(await run(`oauthTestHost.querySelector('[data-connection="discord"]').textContent.includes('Talk to REACH in Discord while Studio is open')`), true);
  await run(`oauthTestHost.querySelector('[data-connection="github"]').open = true; [...oauthTestHost.querySelector('[data-connection="github"]').querySelectorAll('button')].find(button => button.textContent === 'Reconnect GitHub').click()`);
  await until(`oauthTestHost.textContent.includes('ABCD-EFGH')`, 'Device code appears while authorization is pending');
  assert.equal(await run(`oauthTestHost.textContent.includes('private-device-fixture')`), false);
  await until(`oauthTestHost.querySelector('[data-connection="github"] .app-connection-badge').textContent === 'Connected'`, 'GitHub authorization completed');
  assert.equal(storage.load().plugins.github.refreshToken, 'fixture-refresh-github');
  assert.ok(browserUrls.includes('https://github.com/login/device'));
  assert.ok(authorizationFocus > 0, 'Authorization returns focus to Studio');
  assert.equal(await run(`oauthTestHost.textContent.includes('Cancel sign-in')`), false);
  assert.ok(!fs.readFileSync(path.join(profile, 'settings.json'), 'utf8').includes('fixture-refresh-github'));
  discordJobs.push({ id: '523456789012', userId: '223456789012', channel: '423456789012', text: 'Hello from Discord fixture.' });
  await until('reachApi !== undefined', 'Studio still running');
  for (let attempt = 0; attempt < 300 && !discordReplies.includes('Discord fixture response.'); attempt++) await delay(40);
  assert.ok(discordReplies.includes('Discord fixture response.'), 'Discord message runs through the real AgentLoop and returns a reply');
  const discordAgent = JSON.parse(fs.readFileSync(path.join(profile, 'agents.json'), 'utf8')).agents.find(agent => agent.settings.discordChat);
  assert.ok(discordAgent.messages.some(message => message.role === 'user' && message.content === 'Hello from Discord fixture.'));
  clearTimeout(timeout);
  console.log('PASS: Settings preserves encrypted connections; OAuth completes through real renderer/IPC; Discord chat controls save and a Discord message completes through the real AgentLoop and returns its reply. No real account requests were sent.');
  app.exit(0);
})().catch(error => { console.error(error.message); app.exit(1); });
