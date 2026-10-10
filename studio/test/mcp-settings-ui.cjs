'use strict';
// Real Studio renderer + IPC, disposable profile, in-process MCP fixtures only.
// Drives the Settings → MCP servers panel end to end: card list, draft editor,
// live handshake status (a real stdio JSON-RPC fixture), validation, save.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-mcp-ui-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const errors = [];
let win;
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  /* The CSP meta tag ships frame-ancestors, which Chromium always ignores in
   * meta (header-only directive) — platform noise, not an app fault. */
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !/frame-ancestors.*ignored/.test(message)) errors.push(message);
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i = 0; i < 300; i++) { if (await run(code)) return; await delay(40); }
  throw new Error(label);
}
async function capture(name) {
  await delay(120);
  fs.writeFileSync(path.join(profile, name + '.png'), (await win.capturePage()).toPNG());
}
const timeout = setTimeout(() => { console.error('MCP settings UI timed out', profile); app.exit(1); }, 90000);
/* Streamable-HTTP fixture: real JSON-RPC answers on /mcp, an instant 404 on
 * /dead so the error path never depends on socket timing. */
const server = http.createServer((req, res) => {
  if (!req.url.endsWith('/mcp')) { res.statusCode = 404; return res.end('nope'); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let m = {};
    try { m = JSON.parse(body); } catch { /* replied below with empty result */ }
    const result = m.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture-http', version: '1.0' } }
      : m.method === 'tools/list'
        ? { tools: [{ name: 'ping', description: 'Pings.', inputSchema: { type: 'object', properties: {} } }] }
        : {};
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = path.resolve(__dirname, 'fixtures', 'fake-mcp-server.cjs');
  const settings = {
    theme: 'dark', telemetrySources: [],
    connections: [{ id: 'connection_0', name: 'Fixture', endpoint: 'http://127.0.0.1:9/v1', accessKey: 'x', model: 'm', enabled: true }],
    activeConnection: 'connection_0',
    mcpServers: [
      /* A real handshake: the test binary with ELECTRON_RUN_AS_NODE runs the
       * fixture as plain Node. env doubles as the env-field round-trip. */
      { name: 'Fixture-Tools', enabled: true, transport: 'stdio',
        command: process.execPath, args: [fixture], env: { ELECTRON_RUN_AS_NODE: '1' } },
      { name: 'Http-Api', enabled: true, transport: 'http', url: base + '/mcp' },
      { name: 'Dead-Http', enabled: true, transport: 'http', url: base + '/dead' },
      { name: 'Off-Server', enabled: false, transport: 'stdio', command: 'ignored' },
    ],
  };
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof openSettingsPanel === "function" && typeof renderMcp === "function"', 'Renderer startup');
  win.setMinimumSize(440, 640);
  win.setContentSize(1400, 960);
  await run('openSettingsPanel("mcp")');
  await run('document.querySelector("#btn-close-drawer")?.click()');
  await until('document.querySelectorAll("#mcp-list .conn-card").length === 4', 'Four server cards');
  assert.equal(await run('document.querySelector("#mcp-empty").hidden'), true);

  /* Live status: the panel's mcp:list kicks a handshake for enabled unknown
   * rows; the poll repaints when it lands. Both transports must reach ok —
   * a failure here means the whole client chain is broken. */
  await until(`document.querySelector('[data-mcp-key="fixture-tools"] .mcp-pill')?.textContent === 'OK'`, 'fixture-tools handshake');
  await until(`document.querySelector('[data-mcp-key="http-api"] .mcp-pill')?.textContent === 'OK'`, 'http-api handshake');
  await until(`document.querySelector('[data-mcp-key="dead-http"] .mcp-pill')?.textContent === 'Error'`, 'dead-http reports error');
  assert.equal(await run(`document.querySelector('[data-mcp-key="off-server"] .mcp-pill').textContent`), 'Disabled');
  assert.match(await run(`document.querySelector('[data-mcp-key="fixture-tools"] .conn-details dd:nth-of-type(3)').textContent`), /fixture-tools__echo/);
  assert.match(await run(`document.querySelector('[data-mcp-key="http-api"] .conn-details dd:nth-of-type(3)').textContent`), /http-api__ping/);
  assert.match(await run(`document.querySelector('[data-mcp-key="fixture-tools"] .conn-status').textContent`), /1 tool/);
  assert.match(await run('document.querySelector("#mcp-count").textContent'), /4 of 20 server\(s\) · 3 enabled/);
  await capture('mcp-cards');

  // Per-row Test re-handshakes the saved config (enabled, clean rows only).
  assert.equal(await run(`document.querySelector('[data-mcp-key="off-server"] .mcp-test').disabled`), true, 'Disabled row cannot test');
  await run(`document.querySelector('[data-mcp-key="fixture-tools"] .mcp-test').click()`);
  await until('mcpTestsRunning.size === 0', 'Row test finishes');
  assert.match(await run(`document.querySelector('[data-mcp-key="fixture-tools"] .conn-status').textContent`), /Connected · 1 tool/);

  // Editor opens per row; edits stay in draft until Save (like connections).
  await run(`document.querySelector('[data-mcp-key="fixture-tools"] .conn-edit').click()`);
  assert.equal(await run('document.querySelector("#mcp-editor").classList.contains("hidden")'), false);
  assert.equal(await run('document.querySelector("#mcp-editor-title").textContent'), 'Edit Fixture-Tools');
  await run(`(() => {
    const input = document.querySelector('#mcp-editor input');
    input.value = 'Fixture-Renamed'; input.dispatchEvent(new Event('input'));
  })()`);
  assert.equal(await run(`document.querySelector('[data-mcp-key="fixture-tools"] .conn-title').textContent`), 'Fixture-Renamed');
  assert.equal(await run(`document.querySelector('[data-mcp-key="fixture-tools"] .mcp-pill').textContent`), 'Unsaved', 'Edited row stops claiming stored status');
  assert.equal(await run('mcpDirty'), true);

  // Unsaved rows cannot be tested — the button says why.
  assert.equal(await run(`document.querySelector('[data-mcp-key="fixture-tools"] .mcp-test').disabled`), true);
  assert.equal(await run(`document.querySelector('[data-mcp-key="fixture-tools"] .mcp-test').title`), 'Save these changes before testing');
  assert.equal((await run('reachApi.getSettings()')).mcpServers[0].name, 'Fixture-Tools', 'Edit is draft-only until Save');

  // Validation: a malformed env line refuses to save, naming the bad line.
  await run(`(() => {
    const ta = [...document.querySelectorAll('#mcp-editor textarea')][1];
    ta.value = 'MISSING_EQUALS'; ta.dispatchEvent(new Event('input'));
  })()`);
  await run('document.querySelector("#btn-save-mcp").onclick()');
  assert.match(await run('document.querySelector("#mcp-status").textContent'), /KEY=value/);
  assert.equal((await run('reachApi.getSettings()')).mcpServers[0].name, 'Fixture-Tools', 'Refused save wrote nothing');

  // Fix the env line, save, and the draft re-derives ids from names.
  await run(`(() => {
    const ta = [...document.querySelectorAll('#mcp-editor textarea')][1];
    ta.value = 'ELECTRON_RUN_AS_NODE=1'; ta.dispatchEvent(new Event('input'));
  })()`);
  await run('document.querySelector("#btn-save-mcp").onclick()');
  await until(`document.querySelector("#mcp-status").textContent === 'Saved.'`, 'Save completes');
  const saved = (await run('reachApi.getSettings()')).mcpServers;
  assert.equal(saved.length, 4);
  assert.equal(saved[0].name, 'Fixture-Renamed');
  assert.equal(saved[0].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(await run('mcpDirty'), false);
  assert.equal(await run(`document.querySelector('[data-mcp-key="fixture-renamed"]') !== null`), true, 'Rename re-slugged the id');
  await until(`document.querySelector('[data-mcp-key="fixture-renamed"] .mcp-pill')?.textContent === 'OK'`, 'Renamed server reconnects');
  await capture('mcp-after-save');

  // Add a row: editor opens focused; a second save persists it.
  await run('document.querySelector("#btn-add-mcp").click()');
  assert.equal(await run('document.querySelectorAll("#mcp-list .conn-card").length'), 5);
  await run(`(() => {
    const input = document.querySelector('#mcp-editor input');
    input.value = 'Extra'; input.dispatchEvent(new Event('input'));
    const cmd = [...document.querySelectorAll('#mcp-editor .conn-field input')].find(el => el.placeholder && el.placeholder.includes('npx'));
    cmd.value = 'echo'; cmd.dispatchEvent(new Event('input'));
  })()`);
  await run('document.querySelector("#btn-save-mcp").onclick()');
  await until(`document.querySelector("#mcp-status").textContent === 'Saved.'`, 'Second save completes');
  assert.equal((await run('reachApi.getSettings()')).mcpServers.length, 5);

  // Reopening the panel reloads clean state (no unsaved residue).
  await run('openSettingsPanel("connection")');
  await run('openSettingsPanel("mcp")');
  await until('document.querySelectorAll("#mcp-list .conn-card").length === 5', 'Reload shows saved rows');
  assert.equal(await run('mcpDirty'), false);

  // Remove a row and save — the stored list shrinks to match.
  await run(`document.querySelector('[data-mcp-key="extra"] .conn-edit').click()`);
  await run('document.querySelector("#mcp-editor .conn-remove").click()');
  assert.equal(await run('document.querySelectorAll("#mcp-list .conn-card").length'), 4);
  await run('document.querySelector("#btn-save-mcp").onclick()');
  await until(`document.querySelector("#mcp-status").textContent === 'Saved.'`, 'Remove persists');
  assert.equal((await run('reachApi.getSettings()')).mcpServers.length, 4);

  assert.deepEqual(errors, []);
  console.log('MCP SETTINGS UI PASS: list, live handshake status (stdio + HTTP), edit/draft, validation, save round-trip, add/remove, reopen.');
  console.log('Evidence:', profile);
  clearTimeout(timeout);
  server.close();
  app.exit(0);
})().catch(error => { console.error(error.stack || error, 'Evidence:', profile, errors); clearTimeout(timeout); server.close(); app.exit(1); });
