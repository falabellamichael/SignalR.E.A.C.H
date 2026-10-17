'use strict';
// Real Studio main/renderer/preload with a disposable profile. Local catalogs
// are fixtures; no credentials, provider logins, or completions are used.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-login-providers-ui-'));
const endpoint = 'http://127.0.0.1:20777/_reach/login-providers';
app.setPath('userData', profile);
app.disableHardwareAcceleration();
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ telemetrySources: [], theme: 'dark',
  connections: [{ id: 'gpu-fixture', name: 'GPU fixture', endpoint: 'http://127.0.0.1:19098/v1', accessKey: 'gpu-fixture-key', model: 'gemma-4-12b-qat' }], activeConnection: 'gpu-fixture' }));
const originalFetch = global.fetch;
const calls = [], errors = [];
global.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target === endpoint + '/models' || target === 'http://127.0.0.1:19098/v1/models') {
    calls.push({ url: target, options });
    const login = target.startsWith(endpoint);
    const data = login ? ['deepseek-v4.1-flash', 'chatgpt-chat', 'copilot-chat', 'gemini-chat'] : ['gemma-4-12b-qat', 'ornith-1.5-9b'];
    return new Response(JSON.stringify({ object: 'list', ...(login ? { catalog: 'login-providers' } : {}), data: data.map(id => ({ id })) }), { headers: { 'Content-Type': 'application/json' } });
  }
  return originalFetch(url, options);
};
let win;
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => { window.removeAllListeners('ready-to-show'); window.hide(); });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !message.includes("'frame-ancestors' is ignored when delivered via a <meta>")) errors.push(message);
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i = 0; i < 200; i++) { if (await run(code)) return; await delay(30); }
  throw new Error(label);
}
const timeout = setTimeout(() => { console.error('Login Providers UI timed out', profile); app.exit(1); }, 60000);
(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof openSettingsPanel === "function"', 'Renderer startup');
  await run('openSettingsPanel("connection")');
  await until('connDraft.length === 1', 'Connection settings loaded');
  // Opening the GPU catalog must not request Login Providers or append them.
  await run('openModelPicker({target: "gpu-fixture"})');
  await until('document.querySelectorAll("#model-choices button").length === 2', 'GPU catalog');
  assert.equal(calls.some(call => call.url.startsWith(endpoint)), false);
  assert.equal(await run('document.querySelector("#model-choices").textContent.includes("chatgpt-chat")'), false);
  await run('closeModelPicker(); connDraft[0].name = "Unsaved GPU name"; markUnsaved(); document.querySelector("#btn-login-providers").click()');
  await until('document.querySelectorAll("#model-choices button").length === 4', 'Login Providers catalog');
  assert.equal(await run('document.querySelector("#model-modal h3").textContent'), 'Login Providers');
  assert.equal(await run('document.querySelector("#model-source").textContent'), 'From: Login Providers');
  const request = calls.find(call => call.url === endpoint + '/models');
  assert.equal(request.options.headers['X-Reach-Client'], 'studio');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.redirect, 'error');
  await run('[...document.querySelectorAll("#model-choices button")].find(button => button.textContent === "chatgpt-chat").click()');
  assert.equal(await run('connDraft[0].name'), 'Unsaved GPU name');
  assert.equal(await run('connDraft.length'), 2);
  assert.equal(await run('connDraft.find(c => c.id === connActiveId).name'), 'Login Providers');
  assert.equal(await run('connDraft.find(c => c.id === connActiveId).model'), 'chatgpt-chat');
  assert.equal(await run('document.querySelector("#conn-editor .conn-url").readOnly'), true);
  assert.equal(await run('document.querySelector("#conn-editor input[type=password]").disabled'), true);
  assert.equal((await run('reachApi.getSettings()')).connections.length, 1, 'Picking must remain an unsaved settings draft');
  await run('document.querySelector("#btn-save-settings").onclick()');
  const saved = await run('reachApi.getSettings()');
  assert.equal(saved.connections.find(c => c.id === 'gpu-fixture').name, 'Unsaved GPU name');
  assert.equal(saved.connections.find(c => c.id === 'gpu-fixture').accessKey, 'gpu-fixture-key');
  assert.equal(saved.endpoint, endpoint);
  assert.equal(saved.accessKey, '');
  assert.equal(saved.model, 'chatgpt-chat');
  assert.deepEqual(errors, []);
  const report = { ok: true, profile, catalogsSeparate: true, draftPreserved: true, managedConnectionSaved: true, keyIsolated: true };
  try { fs.writeFileSync(path.join(profile, 'login-providers.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); }
  catch (error) { report.captureError = error.message; }
  fs.writeFileSync(path.join(profile, 'ui-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  clearTimeout(timeout); global.fetch = originalFetch; app.exit(0);
})().catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
