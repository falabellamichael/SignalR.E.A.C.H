'use strict';
// Real Studio renderer + IPC, disposable profile, local /models fixture only.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-connections-ui-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const errors = [];
let win;
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i = 0; i < 150; i++) { if (await run(code)) return; await delay(30); }
  throw new Error(label);
}
async function capture(name) {
  await delay(120);
  fs.writeFileSync(path.join(profile, name + '.png'), (await win.capturePage()).toPNG());
}
const server = http.createServer((req, res) => {
  setTimeout(() => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }, { id: 'second-model' }] }));
  }, req.url.includes('slow') ? 350 : 10);
});
const timeout = setTimeout(() => { console.error('Connections UI timed out', profile); app.exit(1); }, 60000);
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const connections = ['Deepseek', 'Nexus-Projects', 'Alibaba (Coding)', 'CodeGPT'].map((name, i) => ({
    id: 'connection_' + i, name, endpoint: endpoint + '/provider-' + i + '/v1',
    accessKey: 'dummy-fixture', model: ['deepseek-flash', 'Qwen/Qwen3.8-27B-FP8', 'qwen3.8-flash', 'deepseek-v4.1-flash'][i], enabled: true,
  }));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [], connections, activeConnection: connections[3].id }));
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof openSettingsPanel === "function"', 'Renderer startup');
  win.setMinimumSize(440, 640);
  win.setContentSize(1660, 1000);
  await run('openSettingsPanel("connection")');
  await run('document.querySelector("#btn-close-drawer").click()');
  await until('connStatus.size === 4 && connTestsRunning.size === 0', 'Automatic test results');
  await until('document.querySelector("#conn-workspace").clientWidth >= 900', 'Wide panel ready');
  assert.equal(await run('document.querySelectorAll(".conn-card").length'), 4);
  assert.equal(await run('document.querySelector("#conn-editor").classList.contains("hidden")'), true);
  await run('document.querySelector(".conn-edit").click()');
  assert.equal(await run('connActiveId'), 'connection_3', 'Editing must not activate');
  console.log('Layout:', await run('({ width: innerWidth, panel: document.querySelector("#settings-connection").clientWidth, workspace: document.querySelector("#conn-workspace").clientWidth })'));
  await capture('initial');
  assert.equal(await run('document.querySelector("#conn-editor").parentElement.id'), 'conn-workspace');
  assert.equal(await run('document.querySelector("#conn-editor input[type=password]").value'), 'dummy-fixture');
  await capture('connections-wide');
  await run(`(() => {
    const input = document.querySelector('#conn-editor .conn-name');
    input.value = 'Deepseek edited'; input.dispatchEvent(new Event('input'));
    document.querySelector('#conn-editor .row button').click();
  })()`);
  win.setContentSize(1000, 900);
  await until('document.querySelector("#conn-workspace").classList.contains("inline-editor")', 'Narrow layout');
  assert.equal(await run('document.querySelector("#conn-editor").parentElement.dataset.connId'), 'connection_0');
  assert.equal(await run('document.querySelector("#conn-editor .conn-name").value'), 'Deepseek edited');
  assert.equal(await run('document.querySelector("#conn-editor .row input").type'), 'text', 'Resize preserves reveal state');
  assert.equal(await run('document.activeElement.closest("#conn-editor") !== null'), true, 'Resize preserves editor focus');
  await run('document.querySelector("#conn-editor .row button").click()');
  await capture('connections-rows');
  const saved = await run('reachApi.getSettings()');
  assert.equal(saved.connections[0].name, 'Deepseek', 'Editing stays in draft until Save');
  await run('document.querySelector("#conn-editor .conn-editor-head button").click()');
  assert.equal(await run('document.activeElement.classList.contains("conn-edit")'), true);
  await run('document.querySelector(".conn-edit").click()');
  assert.equal(await run('document.querySelector("#conn-editor .conn-name").value'), 'Deepseek edited');
  assert.equal(await run('document.querySelector("#conn-editor .row input").type'), 'password', 'Reopening masks key');
  await run('document.querySelector("#conn-editor .conn-model").nextElementSibling.click()');
  await until('document.querySelector("#model-choices")?.textContent.includes("fixture-model")', 'Browse uses edited connection');
  await run(`(() => { const button = [...document.querySelectorAll('#model-choices button')].find(el => el.textContent.includes('second-model')); button.click(); })()`);
  assert.equal(await run('document.querySelector("#conn-editor .conn-model").value'), 'second-model');
  assert.equal(await run('document.querySelector(".conn-details dd").textContent'), 'second-model');
  // In-flight tests must neither duplicate on re-render nor paint stale results.
  await run(`(() => { const input = document.querySelector('#conn-editor .conn-url'); input.value = ${JSON.stringify(endpoint + '/slow/v1')}; input.dispatchEvent(new Event('input')); document.querySelector('.conn-test').click(); })()`);
  await run('document.querySelectorAll(".conn-pool")[1].click()');
  assert.equal(await run('document.querySelector(".conn-test").disabled'), true);
  await run(`(() => { const input = document.querySelector('#conn-editor .conn-url'); input.value = ${JSON.stringify(connections[0].endpoint)}; input.dispatchEvent(new Event('input')); })()`);
  await until('connTestsRunning.size === 0', 'Test finishes after endpoint changed');
  assert.equal(await run('document.querySelector(".conn-status").textContent'), '', 'Stale result discarded');
  // Switching a disabled connection to active brings it back into the pool.
  await run('document.querySelectorAll(".conn-radio")[1].click()');
  assert.equal(await run('connDraft[1].enabled'), true);
  assert.equal(await run('document.querySelectorAll(".conn-pool")[1].disabled'), true);
  await run('document.querySelector("#btn-save-settings").onclick()');
  assert.equal((await run('reachApi.getSettings()')).connections[0].name, 'Deepseek edited');
  assert.equal((await run('reachApi.getSettings()')).connections[0].model, 'second-model');
  await run('document.querySelector("#btn-add-connection").click()');
  assert.equal(await run('document.querySelectorAll(".conn-card").length'), 5);
  assert.equal(await run('document.activeElement.classList.contains("conn-name")'), true);
  await run('document.querySelector("#btn-save-settings").onclick()');
  assert.match(await run('document.querySelector("#settings-status").textContent'), /Enter a Base URL/);
  await run('document.querySelector("#conn-editor .conn-remove").click()');
  assert.equal(await run('document.querySelectorAll(".conn-card").length'), 4);
  // Both directions, including a tiny panel: one editor and no horizontal overflow.
  for (const width of [1440, 1000, 700, 440, 1660]) {
    win.setContentSize(width, 900);
    await delay(150);
    await run('if (!connEditingId) document.querySelector(".conn-edit").click()');
    await delay(50);
    assert.equal(await run('document.querySelectorAll("#conn-editor").length'), 1);
    assert.equal(await run('document.querySelector(".settings-scroll").scrollWidth <= document.querySelector(".settings-scroll").clientWidth + 1'), true, 'No overflow at ' + width);
    await capture('connections-' + width);
  }
  await run('document.documentElement.dataset.theme = "light"');
  await capture('connections-light');
  assert.deepEqual(errors, []);
  console.log('CONNECTIONS UI PASS: draft/save, active vs editor, pool, Browse, key masking, add/remove, stale ping, responsive layouts, overflow, console.');
  console.log('Evidence:', profile);
  clearTimeout(timeout);
  server.close();
  app.exit(0);
})().catch(error => { console.error(error.stack || error, 'Evidence:', profile, errors); clearTimeout(timeout); server.close(); app.exit(1); });
