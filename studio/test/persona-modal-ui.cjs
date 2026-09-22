'use strict';
// Real Electron layout test for the custom-agent (persona) modal — the surface
// that owns the SOUL.md and MEMORY.md editors.
//
// What it guards, as measured behaviour rather than class names:
//   * the dialog fits inside the window at several sizes and zoom factors;
//   * the agent options sit side by side, and so do the two file editors;
//   * the title and the Delete/Cancel/Save row stay PINNED — when the content
//     is taller than the dialog (a 560px-tall window, or 1.25 zoom), only the
//     body scrolls, so Save is reachable without scrolling the dialog;
//   * nothing scrolls horizontally, and Save still writes SOUL.md.
//
// Isolated profile and project: no provider requests, saved conversations or
// installed-app state are touched.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-persona-modal-'));
const profile = path.join(root, 'profile');
const project = path.join(root, 'project');
fs.mkdirSync(profile);
fs.mkdirSync(project);
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [] }));
fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'Persona fixture', dir: project }]));

let win;
const errors = [];
app.on('browser-window-created', (_event, window) => {
  win = window;
  window.webContents.on('console-message', (_event2, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await run(code)) return;
    await delay(40);
  }
  throw new Error(label);
}

// Real agent files, so the editors hold what a used agent actually holds.
const SOUL_TEXT = ['# SOUL — Modal fixture', '']
  .concat(Array.from({ length: 60 }, (_, i) => `## Rule ${i + 1}: read the source before editing it.`), [''])
  .join('\n');
const MEMORY_TEXT = ['# MEMORY — notes from earlier runs', '']
  .concat(Array.from({ length: 60 }, (_, i) => `- Note ${i + 1}: verified against the working tree.`), [''])
  .join('\n');

/* The element that actually scrolls the modal — the body after this change, the
 * whole box before it. Found by behaviour (overflow + real overflow), never by
 * a class name, so the assertions describe what the user feels. */
const SCROLLER = '(() => { const box = document.querySelector("#persona-modal .modal-box");'
  + ' if (!box) return null;'
  + ' return [box].concat([...box.querySelectorAll("*")]'
  + '   .filter((el) => !/^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName))).find((el) =>'
  + ' /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 2) || null; })()';

const GEOMETRY = `(() => {
  const box = document.querySelector('#persona-modal .modal-box');
  const j = (el) => { const b = el && el.getBoundingClientRect(); return b ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height } : null; };
  const q = (s) => document.querySelector(s);
  const scroller = ${SCROLLER};
  return {
    viewport: { width: innerWidth, height: innerHeight },
    box: j(box), title: j(q('#persona-modal-title')), save: j(q('#btn-persona-save')),
    name: j(q('#persona-name')), connection: j(q('#persona-connection')),
    model: j(q('#persona-model')), browse: j(q('#btn-persona-browse')),
    soul: j(q('#persona-soul')), memory: j(q('#persona-memory')),
    filesOpen: q('#persona-files') ? q('#persona-files').open : null,
    boxIsScroller: scroller === box,
    scroller: scroller ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth } : null,
    docScrollWidth: document.documentElement.scrollWidth,
  };
})()`;

function assertFits(tag, g) {
  const pad = 1;
  assert.ok(g.box, `${tag}: the persona modal box is missing`);
  assert.ok(g.box.left >= -pad && g.box.right <= g.viewport.width + pad,
    `${tag}: the dialog crosses the window horizontally — ${JSON.stringify({ box: g.box, viewport: g.viewport })}`);
  assert.ok(g.box.top >= -pad && g.box.bottom <= g.viewport.height + pad,
    `${tag}: the dialog does not fit the window vertically — ${JSON.stringify({ box: g.box, viewport: g.viewport })}`);
  assert.ok(g.docScrollWidth <= g.viewport.width + pad, `${tag}: the page scrolls horizontally`);
  assert.ok(g.title.top >= g.box.top - pad, `${tag}: the dialog title is clipped above the box`);
  assert.ok(Math.abs(g.name.top - g.connection.top) <= 2 && g.connection.left >= g.name.right - 1,
    `${tag}: Name and Connection must sit side by side — ${JSON.stringify({ name: g.name, connection: g.connection })}`);
  assert.ok(Math.abs(g.model.top - g.browse.top) <= 2 && g.browse.left >= g.model.right - 1,
    `${tag}: the model field and its Browse button must share one row — ${JSON.stringify({ model: g.model, browse: g.browse })}`);
  assert.ok(Math.abs(g.soul.top - g.memory.top) <= 2 && g.memory.left >= g.soul.right - 1,
    `${tag}: SOUL.md and MEMORY.md must sit side by side — ${JSON.stringify({ soul: g.soul, memory: g.memory })}`);
  assert.ok(g.soul.right <= g.box.right + pad && g.memory.right <= g.box.right + pad,
    `${tag}: the file editors overflow the dialog — ${JSON.stringify({ soul: g.soul, memory: g.memory, box: g.box })}`);
  assert.ok(g.soul.height >= 90 && g.memory.height >= 90,
    `${tag}: both editors need a usable height — ${JSON.stringify({ soul: g.soul?.height, memory: g.memory?.height })}`);
}

/** The frame must not move and Save must stay on screen at either scroll end. */
async function assertActionsPinned(tag, expectOverflow) {
  const at = async (where) => {
    await run(`(() => { const sc = ${SCROLLER}; if (sc) sc.scrollTop = ${where}; })()`);
    await delay(60);
    return await run(GEOMETRY);
  };
  const top = await at(0);
  assert.ok(top.save.top >= 0 && top.save.bottom <= top.viewport.height + 1,
    `${tag}: Delete/Cancel/Save must be reachable without scrolling the dialog — ${JSON.stringify({ save: top.save, viewport: top.viewport, scroller: top.scroller })}`);
  if (expectOverflow) {
    assert.ok(top.scroller, `${tag}: this size must overflow the dialog, but nothing scrolls — ${JSON.stringify({ box: top.box, soul: top.soul })}`);
  }
  if (top.scroller) {
    assert.equal(top.boxIsScroller, false,
      `${tag}: the dialog frame must stay put; the whole box is scrolling instead of the body`);
    assert.ok(top.scroller.scrollWidth <= top.scroller.clientWidth + 2,
      `${tag}: the scrolling region must not scroll horizontally — ${JSON.stringify(top.scroller)}`);
  }
  const bottom = await at(99999);
  assert.ok(bottom.save.top >= 0 && bottom.save.bottom <= bottom.viewport.height + 1,
    `${tag}: the actions must stay pinned while the body scrolls`);
  assert.ok(Math.abs(bottom.box.bottom - top.box.bottom) <= 1 && Math.abs(bottom.box.top - top.box.top) <= 1,
    `${tag}: scrolling the body moved the dialog frame — ${JSON.stringify({ before: top.box, after: bottom.box })}`);
  if (expectOverflow) {
    assert.ok(bottom.scroller.scrollTop > 0,
      `${tag}: expected the body to scroll (scrollTop stayed ${bottom.scroller.scrollTop})`);
  }
  await at(0);
  return top;
}

const SIZES = [
  { tag: '1440x900@1', width: 1440, height: 900, zoom: 1, overflow: false },
  { tag: '1000x640@1', width: 1000, height: 640, zoom: 1, overflow: true },
  { tag: '860x560@1', width: 860, height: 560, zoom: 1, overflow: true },
  { tag: '1280x800@1.25', width: 1280, height: 800, zoom: 1.25, overflow: true },
];

const timeout = setTimeout(() => {
  console.error('Persona modal UI timed out. Evidence: ' + root);
  app.exit(1);
}, 90000);

(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof openPersonaModal === "function" && typeof reachApi !== "undefined"', 'Renderer did not initialize');
  win.show();

  const created = await run('reachApi.personas.create({name:"Modal fixture", prompt:"Review contracts before declaring work done."})');
  assert.equal(created.ok, true, 'Fixture persona must be created: ' + JSON.stringify(created));
  const personaId = created.persona.id;
  const wrote = await run(`Promise.all([
    reachApi.soul.set(${JSON.stringify(personaId)}, 'soul', ${JSON.stringify(SOUL_TEXT)}),
    reachApi.soul.set(${JSON.stringify(personaId)}, 'memory', ${JSON.stringify(MEMORY_TEXT)}),
  ])`);
  assert.equal(wrote.every(r => r && r.ok), true, 'Fixture agent files must be written: ' + JSON.stringify(wrote));

  for (const size of SIZES) {
    win.setContentSize(size.width, size.height);
    win.webContents.setZoomFactor(size.zoom);
    await delay(150);
    await run(`(async () => { await openPersonaModal(${JSON.stringify(created.persona)}); document.querySelector('#persona-files').open = true; })()`);
    await until('document.querySelector("#persona-modal .modal-box").getBoundingClientRect().height > 0'
      + ' && document.querySelector("#persona-files").open', `${size.tag}: the persona modal did not open with its files section`);
    await delay(150);
    const g = await assertActionsPinned(size.tag, size.overflow);
    console.log(`${size.tag} ${JSON.stringify({ viewport: g.viewport, box: g.box, save: g.save, scroller: g.scroller, boxIsScroller: g.boxIsScroller })}`);
    assertFits(size.tag, g);
    fs.writeFileSync(path.join(root, `persona-modal-${size.width}x${size.height}-${size.zoom}.png`), (await win.capturePage()).toPNG());
  }

  // The re-laid-out modal must still SAVE — the point of the whole surface.
  win.webContents.setZoomFactor(1);
  win.setContentSize(1440, 900);
  await delay(150);
  await run(`(async () => { await openPersonaModal(${JSON.stringify(created.persona)}); })()`);
  await until('document.querySelector("#persona-modal .modal-box").getBoundingClientRect().height > 0', 'The modal did not reopen for the save check');
  await run(`(() => {
    const soul = document.querySelector('#persona-soul');
    soul.value = '# SOUL — typed in the re-laid-out editor';
    soul.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(`document.querySelector('#persona-files-status').textContent.includes('Unsaved')`, 'Editing SOUL.md did not mark the files dirty');
  await run('document.querySelector("#btn-persona-save").click()');
  await until('document.querySelector("#persona-modal").classList.contains("hidden")', 'Save did not close the modal');
  await delay(150);
  const soulFile = path.join(profile, 'agents', personaId, 'SOUL.md');
  assert.equal(fs.existsSync(soulFile), true, 'SOUL.md must exist at ' + soulFile);
  assert.match(fs.readFileSync(soulFile, 'utf8'), /typed in the re-laid-out editor/, 'Save must write SOUL.md from the re-laid-out editor');
  fs.writeFileSync(path.join(root, 'persona-modal-saved.png'), (await win.capturePage()).toPNG());

  assert.deepEqual(errors, [], 'Renderer console must stay error-free');
  assert.deepEqual(await run('window.__errors'), [], 'Renderer must record no unhandled errors');
  console.log('PERSONA MODAL UI PASS: dialog fits the window at 4 sizes/zooms, options and SOUL.md/MEMORY.md side by side, pinned actions, no horizontal overflow, Save still writes SOUL.md.');
  console.log('Evidence: ' + root);
  clearTimeout(timeout);
  app.exit(0);
})().catch(async error => {
  console.error(error.stack || error);
  if (win && !win.isDestroyed()) {
    try { fs.writeFileSync(path.join(root, 'failure.png'), (await win.capturePage()).toPNG()); } catch { /* window already gone */ }
  }
  console.error('Evidence: ' + root);
  clearTimeout(timeout);
  app.exit(1);
});
