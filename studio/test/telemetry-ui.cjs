'use strict';
// Native Electron integration checks. All conversations and settings are disposable.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-workspace-ui-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [] }));
fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'SignalREACH', dir: project }]));
const store = new AgentStore(path.join(profile, 'agents.json'));
const fixture = store.create({ name: 'Chat', dir: project });
store.appendMessage(fixture.id, { role: 'user', content: 'Disposable integration check' });
store.update(fixture.id, { settings: { features: { terminal: false }, budgetOverrides: { maxTokens: 2048 } } });
const branch = store.fork(fixture.id);
let win;
const errors = [];
app.on('browser-window-created', (_event, window) => {
  win = window;
  // Suppress only this fixture's ready-to-show handler, without modifying production code.
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, message) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await run(code)) return; await delay(100); }
  throw new Error(message);
}
const timeout = setTimeout(() => { console.error('Workspace UI timed out'); app.exit(1); }, 120000);
(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(50);
  await until('typeof ReachWorkspace !== "undefined" && document.querySelector("#agent-project-select option") !== null', 'Renderer did not initialize');
  await run(`(async () => { setDrawer(false); await showTab('agents'); await selectAgent({id:${JSON.stringify(fixture.id)}}); })()`);
  assert.equal(await run('document.querySelector("#telemetry-dashboard").hidden'), true);
  // Tool preferences cross the real context-isolated preload and IPC handlers.
  await run('document.querySelector("[role=switch][aria-label=Web]").click()');
  await until(`currentAgent.settings.features.web === false && !document.querySelector('[role=switch][aria-label=Web]').disabled`, 'Web switch did not save');
  assert.equal(await run(`(async () => (await reachApi.agents.get(${JSON.stringify(fixture.id)})).settings.features.terminal)()`), false);
  const invalid = await run(`(async () => { try { await reachApi.agents.update(${JSON.stringify(fixture.id)}, {settings:{features:{terminal:'yes'}}}); return false; } catch { return true; } })()`);
  assert.equal(invalid, true, 'Invalid tool policy must be rejected through IPC');
  // Clear via the actual confirmation dialog, preserving settings and the independent branch.
  await run('document.querySelector("#btn-clear-chat").click()');
  await until('document.querySelector("dialog[open]") !== null', 'Clear confirmation missing');
  await run(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Confirm').click()`);
  await until('currentAgent.messages.length === 0 && !document.querySelector("#telemetry-dashboard").hidden', 'Clear did not expose telemetry');
  const cleared = await run(`reachApi.agents.get(${JSON.stringify(fixture.id)})`);
  assert.equal(cleared.messages.length, 0); assert.equal(cleared.settings.features.web, false);
  assert.equal(cleared.settings.budgetOverrides.maxTokens, 2048);
  assert.equal((await run(`reachApi.agents.get(${JSON.stringify(branch.id)})`)).messages.length, 1);
  await run('document.querySelector("#telemetry-toggle").click()');
  assert.equal(await run('document.querySelector(".telemetry-content").hidden'), true);
  await run('document.querySelector("#telemetry-toggle").click()');
  assert.equal(await run('document.querySelector(".telemetry-content").hidden'), false);
  // Real collector and preload, no inference endpoints or user profile involved.
  const live = await run('reachApi.telemetry.sample()');
  assert.ok(live.ram.total > 0 && live.cpu.threads > 0);
  assert.equal(live.models.length, 0);
  console.log('LIVE TELEMETRY', JSON.stringify({ cpu: live.cpu.name, ram: live.ram.total, gpu: live.gpu, processes: live.processes.length }));
  // A visibly labeled fixture gives deterministic design QA for loaded/empty states.
  const gb = n => n * 1024 ** 3;
  const sample = () => ({ at: Date.now(), platform: process.platform, cpu: { percent: 24, name: 'AMD Ryzen 9 5900X', threads: 24 },
    ram: { used: gb(42), total: gb(64), available: gb(22) }, gpu: { utilization: 68, name: 'AMD Radeon RX 6750 XT', dedicated: gb(9.2), total: gb(12), shared: gb(1.1), source: 'Fixture' },
    models: [{ name: 'Qwen3.6', provider: 'Local provider', local: true, placement: 'GPU', bytes: gb(7.6), ram: 0, vram: gb(7.6) }, { name: 'nomic-embed-text', provider: 'Ollama', local: true, placement: 'CPU', bytes: gb(.3), ram: gb(.3), vram: 0 }],
    processes: [{ name: 'llama-server', pid: 412, ram: gb(14.2), cpu: 17 }, { name: 'REACH Studio', pid: 513, ram: gb(.6), cpu: 2 }],
    sources: [{ provider: 'Ollama', url: 'http://127.0.0.1:11434', state: 'connected', models: [{}] }], network: { receive: 1048576, send: 200000 }, disk: { read: 2000000, write: 1000000 }, uptime: 7200, notes: ['Preview data · isolated test conversation'] });
  ipcMain.removeHandler('telemetry:sample'); ipcMain.handle('telemetry:sample', sample);
  await until('document.querySelector(".telemetry-note")?.textContent.includes("Preview data")', 'Fixture sample not rendered');
  win.setMenuBarVisibility(false);
  const screenshots = [];
  for (const [width, height] of [[1440, 1024], [1000, 640]]) {
    win.setContentSize(width, height);
    for (const theme of ['dark', 'light']) {
      if (await run('document.documentElement.dataset.theme') !== theme) await run('document.querySelector("#theme-toggle").onclick()');
      for (const view of ['overview', 'activity', 'models']) {
        await run(`document.querySelector('#telemetry-view').value=${JSON.stringify(view)}; document.querySelector('#telemetry-view').dispatchEvent(new Event('change'))`);
        await delay(120);
        const geometry = await run(`(() => { const c=document.querySelector('.composer').getBoundingClientRect(), b=document.querySelector('#btn-send').getBoundingClientRect(); return { width:innerWidth,height:innerHeight,overflow:document.body.scrollWidth>innerWidth,composer:c.toJSON(),send:b.toJSON(),view:document.querySelector('#telemetry-dashboard').dataset.view }; })()`);
        assert.equal(geometry.overflow, false, 'Page must not overflow horizontally');
        assert.ok(geometry.send.bottom <= geometry.height, 'Send must remain inside viewport');
        assert.ok(geometry.composer.width <= 961, 'Conversation keeps document width');
        assert.equal(geometry.view, view);
        if (view !== 'models') assert.equal(await run(`document.querySelector('.telemetry-bar').nextElementSibling.className`), 'telemetry-metrics', 'Switching back restores the metric row above the tables');
        const name = `${view}-${theme}-${width}.png`;
        fs.writeFileSync(path.join(root, name), (await win.capturePage()).toPNG());
        screenshots.push({ name, geometry });
      }
    }
  }
  // Verify selectable models, sources, tools and focus restoration on native dialogs.
  await run(`[...document.querySelectorAll('#composer-tools button')].find(b=>b.textContent==='Tools…').click()`);
  await until('document.querySelector(".tool-option") !== null', 'Tool options did not load');
  await run(`document.querySelector('.workspace-dialog input[type=search]').value='shell'; document.querySelector('.workspace-dialog input[type=search]').dispatchEvent(new Event('input'));`);
  assert.equal(await run(`document.querySelectorAll('.tool-option:not([hidden])').length`), 1);
  await run(`document.querySelector('.tool-option input[value=shell]').checked=false; document.querySelector('.workspace-form').requestSubmit()`);
  await until('document.querySelector("dialog[open]") === null', 'Tools did not save and close');
  assert.ok((await run(`reachApi.agents.get(${JSON.stringify(fixture.id)})`)).settings.disabledTools.includes('shell'));
  await run(`(() => { const button=[...document.querySelectorAll('#composer-tools button')].find(b=>b.textContent==='Permissions…'); button.focus(); button.click(); })()`);
  assert.equal(await run('document.querySelector("dialog[open]").getAttribute("aria-label")'), 'Conversation permissions');
  await run('document.querySelector("dialog[open]").close()');
  await until('document.activeElement.textContent === "Permissions…"', 'Dialog did not restore focus');
  const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'agents.json'), 'utf8'));
  assert.equal(persisted.agents.find(a => a.id === fixture.id).messages.length, 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ screenshots, checks: ['real IPC', 'policy validation', 'clear and branch preservation', 'telemetry visibility', 'hardware sampling', 'three views', 'two themes', 'minimum window', 'tool search and persistence', 'modal focus'], errors }, null, 2));
  console.log('WORKSPACE UI PASS', root);
  clearTimeout(timeout); app.exit(0);
})().catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
