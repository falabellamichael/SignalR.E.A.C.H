'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../agent/refactor.cjs');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  }
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

test('search/replace across files plans and applies atomically', () => {
  const dir = project({
    'a.js': "const b = require('./b.js');\nmodule.exports = { useB: () => b.val };\n",
    'b.js': "const c = require('./c.js');\nmodule.exports = { val: c.n };\n",
    'c.js': 'module.exports = { n: 1 };\n',
  });
  const plan = R.planFromEdits([
    { path: 'a.js', search: 'useB: () => b.val', replace: 'useB: () => b.value' },
    { path: 'b.js', search: 'val: c.n', replace: 'value: c.n' },
  ], { projectDir: dir });
  assert.equal(plan.errors.length, 0, plan.errors.join('; '));
  assert.equal(plan.files.length, 2);
  assert.ok(plan.files.every(f => typeof f.after === 'string'), 'after is text, not a descriptor object');
  const res = R.applyPlan(plan, { projectDir: dir });
  assert.equal(res.ok, true);
  assert.ok(read(dir, 'a.js').includes('b.value'));
  assert.ok(read(dir, 'b.js').includes('value: c.n'));
  assert.ok(!fs.readdirSync(dir).some(f => f.includes('.reach-tmp-')), 'no temp files left');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('path traversal, absolute paths and duplicates are rejected', () => {
  const dir = project({ 'a.js': 'x\n' });
  for (const bad of ['../outside.js', 'C:/Windows/evil.js', '~/secret.js', 'sub/../../esc.js']) {
    const p = R.planFromEdits([{ path: bad, content: 'y' }], { projectDir: dir });
    assert.ok(p.errors.length > 0, 'rejected ' + bad);
  }
  const dup = R.planFromEdits([{ path: 'a.js', content: 'x' }, { path: 'a.js', content: 'y' }], { projectDir: dir });
  assert.match(dup.errors.join(' '), /more than one edit/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('create:true is required for new files and refused over existing ones', () => {
  const dir = project({ 'a.js': 'x\n' });
  const missing = R.planFromEdits([{ path: 'new.js', content: 'y' }], { projectDir: dir });
  assert.match(missing.errors.join(' '), /does not exist/);
  const created = R.planFromEdits([{ path: 'new.js', create: true, content: 'y' }], { projectDir: dir });
  assert.equal(created.errors.length, 0);
  const over = R.planFromEdits([{ path: 'a.js', create: true, content: 'y' }], { projectDir: dir });
  assert.match(over.errors.join(' '), /already exists/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a no-op edit becomes a warning and is not staged', () => {
  const dir = project({ 'c.js': 'module.exports = { n: 1 };\n' });
  const plan = R.planFromEdits([{ path: 'c.js', content: 'module.exports = { n: 1 };\n' }], { projectDir: dir });
  assert.equal(plan.files.length, 0);
  assert.equal(plan.warnings.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a concurrent edit since planning is detected and nothing is written', () => {
  const dir = project({ 'a.js': 'original\n', 'b.js': 'b\n' });
  const plan = R.planFromEdits([{ path: 'a.js', content: 'new\n' }], { projectDir: dir });
  fs.writeFileSync(path.join(dir, 'a.js'), 'CHANGED BY SOMEONE ELSE\n');
  const res = R.applyPlan(plan, { projectDir: dir });
  assert.equal(res.ok, false);
  assert.match(res.error, /changed on disk/);
  assert.equal(read(dir, 'a.js'), 'CHANGED BY SOMEONE ELSE\n', 'the user edit survived');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failure on the second write rolls back the first and cleans temps', () => {
  const dir = project({ 'x1.js': 'original one\n', 'x2.js': 'original two\n' });
  const plan = R.planFromEdits([{ path: 'x1.js', content: 'NEW one\n' }, { path: 'x2.js', content: 'NEW two\n' }], { projectDir: dir });
  const realWrite = fs.writeFileSync;
  let exploded = false;
  const res = R.applyPlan(plan, {
    projectDir: dir,
    writeImpl: (p, data) => {
      if (String(p).includes('x2') && !exploded) { exploded = true; throw new Error('disk on fire'); }
      realWrite(p, data, 'utf8');
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true);
  assert.equal(read(dir, 'x1.js'), 'original one\n', 'x1 restored');
  assert.equal(read(dir, 'x2.js'), 'original two\n', 'x2 untouched');
  assert.ok(!fs.readdirSync(dir).some(f => f.includes('.reach-tmp-')), 'temps cleaned');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file created by a rolled-back plan is removed', () => {
  const dir = project({ 'x1.js': 'original one\n' });
  const plan = R.planFromEdits([
    { path: 'made.js', create: true, content: 'brand new\n' },
    { path: 'x1.js', content: 'also new\n' },
  ], { projectDir: dir });
  assert.equal(plan.errors.length, 0);
  const realWrite = fs.writeFileSync;
  const res = R.applyPlan(plan, {
    projectDir: dir,
    writeImpl: (p, data) => { if (String(p).includes('x1')) throw new Error('nope'); realWrite(p, data, 'utf8'); },
  });
  assert.equal(res.ok, false);
  assert.equal(exists(dir, 'made.js'), false, 'created file removed on rollback');
  assert.equal(read(dir, 'x1.js'), 'original one\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rollback that itself fails is reported, never silently ignored', () => {
  const dir = project({ 'x1.js': 'a\n', 'x2.js': 'b\n' });
  const plan = R.planFromEdits([{ path: 'x1.js', content: 'A\n' }, { path: 'x2.js', content: 'B\n' }], { projectDir: dir });
  const realWrite = fs.writeFileSync;
  let x2Staged = false, restoreBlocked = false;
  const res = R.applyPlan(plan, {
    projectDir: dir,
    writeImpl: (p, data) => {
      const s = String(p);
      if (s.includes('x2') && !x2Staged) { x2Staged = true; throw new Error('stage failed'); }
      // Block the restore write of x1 so rollback fails.
      if (s.includes('x1') && restoreBlocked === false && data === 'a\n') { restoreBlocked = true; throw new Error('restore failed'); }
      realWrite(p, data, 'utf8');
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.rollbackFailed, true, 'reports that rollback was incomplete');
  assert.ok(res.restoreErrors.length > 0);
  assert.match(res.error, /rollback could not restore/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dependency ordering writes a dependent before its dependency', () => {
  const { buildIndex } = require('../agent/code-index.cjs');
  const dir = project({
    'a.js': "const b = require('./b.js');\nmodule.exports = { useB: () => b.value };\n",
    'b.js': "const c = require('./c.js');\nmodule.exports = { value: c.n };\n",
    'c.js': 'module.exports = { n: 1 };\n',
  });
  const idx = buildIndex([
    { path: 'a.js', content: read(dir, 'a.js') },
    { path: 'b.js', content: read(dir, 'b.js') },
    { path: 'c.js', content: read(dir, 'c.js') },
  ]);
  assert.ok(idx.fileGraph.has('a.js'));
  const plan = R.planFromEdits([
    { path: 'b.js', search: 'value: c.n', replace: 'value: c.n2' },
    { path: 'a.js', search: 'useB: () => b.value', replace: 'useB: () => b.value2' },
  ], { projectDir: dir, dependencyIndex: idx });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.order.length, 2);
  assert.ok(plan.order.indexOf('a.js') < plan.order.indexOf('b.js'), 'a before b: ' + plan.order.join(','));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dependency cycle halts the plan and refuses to apply', () => {
  const { buildIndex } = require('../agent/code-index.cjs');
  const dir = project({
    'p.js': "const q = require('./q.js');\nfunction fP() { return q; }\nmodule.exports = { fP };\n",
    'q.js': "const p = require('./p.js');\nfunction fQ() { return p; }\nmodule.exports = { fQ };\n",
  });
  const idx = buildIndex([{ path: 'p.js', content: read(dir, 'p.js') }, { path: 'q.js', content: read(dir, 'q.js') }]);
  const plan = R.planFromEdits([
    { path: 'p.js', search: 'return q;', replace: 'return q.z;' },
    { path: 'q.js', search: 'return p;', replace: 'return p.z;' },
  ], { projectDir: dir, dependencyIndex: idx });
  assert.ok(plan.cycles.length > 0, 'cycle detected');
  assert.match(plan.errors.join(' '), /cycle/i);
  const res = R.applyPlan(plan, { projectDir: dir });
  assert.equal(res.ok, false, 'a cyclic plan will not apply');
  assert.ok(read(dir, 'p.js').includes('return q;'), 'p.js unchanged');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('summarizePlan is JSON-safe and reports aggregate stats', () => {
  const dir = project({ 'c.js': 'module.exports = { n: 1 };\n' });
  const plan = R.planFromEdits([{ path: 'c.js', search: 'n: 1', replace: 'n: 3' }], { projectDir: dir });
  const sum = R.summarizePlan(plan);
  assert.equal(sum.ok, true);
  assert.equal(sum.files, 1);
  assert.ok(sum.added >= 1 && sum.removed >= 1);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(sum)));
  fs.rmSync(dir, { recursive: true, force: true });
});
