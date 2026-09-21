'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../main.mjs'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('projects:remove'");
  const end = source.indexOf("  ipcMain.handle('projects:save'", start);
  assert.ok(start >= 0 && end > start, 'Project-removal handler must exist');
  let handler, writes = 0, fail = false;
  let projects = [{ name: 'Same name', dir: '/first/folder' }, { name: 'Same name', dir: '/second/folder' }];
  // No fs, shell, chat store or runner is provided: only the saved shortcut list
  // is available to this handler. Trying to touch anything else fails the test.
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    loadProjects: () => projects,
    saveProjects: value => {
      if (fail) throw new Error('Read-only profile');
      projects = value; writes++;
    },
  });
  return { remove: dir => handler({}, dir), projects: () => projects, writes: () => writes, fail: () => { fail = true; } };
}
test('remove project forgets only the exact path, not a same-name folder', () => {
  const f = fixture();
  assert.equal(f.remove('/first/folder').ok, true);
  assert.deepEqual(f.projects(), [{ name: 'Same name', dir: '/second/folder' }]);
});
test('missing project and repeated removal are harmless', () => {
  const f = fixture();
  assert.equal(f.remove('/missing').ok, true);
  assert.equal(f.projects().length, 2);
  f.remove('/first/folder'); f.remove('/first/folder');
  assert.equal(f.projects().length, 1);
});
test('invalid removal requests never write the saved list', () => {
  const f = fixture();
  for (const dir of [null, undefined, '', '  ', 1, {}, ['/first/folder']]) assert.equal(f.remove(dir).ok, false);
  assert.equal(f.writes(), 0);
  assert.equal(f.projects().length, 2);
});
test('a persistence failure leaves the project remembered', () => {
  const f = fixture(); f.fail();
  assert.throws(() => f.remove('/first/folder'), /Read-only profile/);
  assert.equal(f.projects().length, 2);
  assert.equal(f.writes(), 0);
});
