'use strict';
// Real Electron layout for the Translate popover. A short user prompt makes a
// narrow tile: expanding the tray overflows icons into the outer wing and the
// bubble slides aside to reveal it. That slide must not use transform — a
// transformed bubble becomes the containing block for the fixed-position
// popover inside it and the popover lands nowhere near the action row.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-translate-pop-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [] }));
fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'Translate fixture', dir: project }]));
const store = new AgentStore(path.join(profile, 'agents.json'));
const fixture = store.create({ name: 'Translate popover fixture', dir: project });
store.setMessages(fixture.id, [
  { role: 'user', content: 'hey' },
  { role: 'assistant', content: Array.from({ length: 30 }, (_, i) => `Detail ${i + 1} of a long answer.`).join('\n') },
]);
let win;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
app.on('browser-window-created', (_event, window) => { win = window; });
async function until(code, label) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await run(code)) return; await delay(30); }
  throw new Error(label);
}
const timeout = setTimeout(() => { console.error('Translate popover UI timed out'); app.exit(1); }, 60000);
(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof selectAgent === "function" && document.querySelector("#agent-project-select option")', 'Renderer did not initialize');
  win.show();
  win.setSize(1440, 900);
  await run(`(async () => { await showTab('agents'); await selectAgent({id:${JSON.stringify(fixture.id)}}); })()`);
  await until(`document.querySelector('.chat-msg.user .msg-more') && document.querySelector('.chat-msg.assistant .msg-more')`, 'Message actions did not render');
  // A remembered drag position would pin the popover; the bug under test is
  // about automatic placement, so start clean.
  await run(`localStorage.removeItem('reach:translate-pos')`);

  async function openPopoverOn(selector) {
    const cls = selector === 'user' ? 'user' : 'assistant';
    await run(`document.querySelector('.chat-msg.${cls} .msg-more').click()`);
    await until(`document.querySelector('.chat-msg.${cls} .msg-actions').classList.contains('expanded')`, `${cls} tray did not expand`);
    await delay(120);
    const style = await run(`(() => { const b = document.querySelector('.chat-msg.${cls}'); return { transform: b.style.transform, left: b.style.left, wing: b.querySelector('.msg-wing-right').children.length + b.querySelector('.msg-wing-left').children.length }; })()`);
    assert.equal(style.transform, '', `${cls} bubble must not be transformed — it would capture the fixed popover`);
    await run(`document.querySelector('.chat-msg.${cls} .msg-translate').click()`);
    await until(`document.querySelector('.msg-translate-pop')`, `${cls} translate popover did not open`);
    await delay(100);
    return style;
  }

  async function assertHugsRow(cls) {
    const geo = await run(`(() => {
      const pop = document.querySelector('.msg-translate-pop').getBoundingClientRect();
      const row = document.querySelector('.chat-msg.${cls} .msg-translate').getBoundingClientRect();
      return { pop: pop.toJSON(), row: row.toJSON(), vw: innerWidth, vh: innerHeight };
    })()`);
    const above = Math.abs(geo.pop.bottom - (geo.row.top - 6)) <= 2;
    const below = Math.abs(geo.pop.top - (geo.row.bottom + 6)) <= 2;
    assert.ok(above || below, `${cls} popover must hug the action row: ${JSON.stringify(geo)}`);
    assert.ok(geo.pop.left >= -0.5 && geo.pop.right <= geo.vw + 0.5 && geo.pop.top >= -0.5 && geo.pop.bottom <= geo.vh + 0.5,
      `${cls} popover must stay inside the viewport: ${JSON.stringify(geo)}`);
    return geo;
  }

  // Short user prompt: narrow tile forces overflow into the outer wing and the
  // bubble slides toward centre to reveal it — the transform regression case.
  const userStyle = await openPopoverOn('user');
  assert.ok(userStyle.wing > 0, 'User fixture must overflow into a wing to exercise the slide');
  assert.notEqual(userStyle.left, '', 'Slid bubble should use a left offset, not transform');
  await assertHugsRow('user');
  fs.writeFileSync(path.join(root, 'translate-user.png'), (await win.capturePage()).toPNG());

  // A jittery click on the drag grip must not pin a position.
  async function headCenter() {
    return run(`(() => { const r = document.querySelector('.msg-translate-head').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  }
  const jitter = await headCenter();
  win.focus(); win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', ...jitter });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...jitter, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: jitter.x + 2, y: jitter.y + 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: jitter.x + 2, y: jitter.y + 1, button: 'left', clickCount: 1 });
  await delay(60);
  assert.equal(await run(`localStorage.getItem('reach:translate-pos')`), null, 'Sub-threshold wiggle must not save a parked spot');

  // A real drag stores a row-relative offset, not an absolute screen point.
  const drag = await headCenter();
  win.webContents.sendInputEvent({ type: 'mouseMove', ...drag });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...drag, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x - 30, y: drag.y + 15 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x - 60, y: drag.y + 30 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: drag.x - 60, y: drag.y + 30, button: 'left', clickCount: 1 });
  await delay(60);
  const saved = JSON.parse(await run(`localStorage.getItem('reach:translate-pos')`) || 'null');
  assert.ok(saved && Number.isFinite(saved.dx) && Number.isFinite(saved.dy), `Drag should save a row-relative offset: ${JSON.stringify(saved)}`);
  await run(`document.querySelector('.msg-translate-close:not(.msg-translate-home)').click()`);
  await until(`!document.querySelector('.msg-translate-pop')`, 'User popover did not close');

  // Reopening on a different message applies that offset to ITS row — the spot
  // tracks the message instead of pinning to a stale screen coordinate.
  await openPopoverOn('assistant');
  const followed = await run(`(() => {
    const pop = document.querySelector('.msg-translate-pop').getBoundingClientRect();
    const row = document.querySelector('.chat-msg.assistant .msg-translate').getBoundingClientRect();
    return { dx: pop.left - row.left, dy: pop.top - row.top, vw: innerWidth, vh: innerHeight, right: pop.right, bottom: pop.bottom };
  })()`);
  assert.ok(Math.abs(followed.dx - saved.dx) <= 3 && Math.abs(followed.dy - saved.dy) <= 3
      || followed.right <= followed.vw + 0.5 && followed.bottom <= followed.vh + 0.5,
    `Dragged spot should follow the message row (or clamp on-screen): ${JSON.stringify({ followed, saved })}`);
  fs.writeFileSync(path.join(root, 'translate-assistant.png'), (await win.capturePage()).toPNG());

  // The snap-back button clears the memory and re-anchors to the message.
  await run(`document.querySelector('.msg-translate-home').click()`);
  await delay(80);
  assert.equal(await run(`localStorage.getItem('reach:translate-pos')`), null, 'Snap-back should clear the saved spot');
  await assertHugsRow('assistant');

  console.log('Translate popover stays attached to the action row for user and assistant messages.');
  clearTimeout(timeout);
  app.exit(0);
})().catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
