'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createExperiment, recordOutcome, ExperimentRegistry, compareExperiments,
  promoteExperiment, discardExperiment, experimentPromptBlock,
} = require('../agent/experiment-registry.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reach-experiments-'));

test('createExperiment generates an id, a default, and stays active', () => {
  const exp = createExperiment({ hypothesis: 'the split is cheaper', branch: 'exp/split' });
  assert.ok(exp.id.startsWith('exp-'));
  assert.equal(exp.status, 'active');
  assert.equal(exp.branch, 'exp/split');
  assert.equal(exp.diffStat, null);
  const again = createExperiment({});
  assert.notEqual(again.id, exp.id, 'ids must not collide');
});

test('recordOutcome fills measurements only while active', () => {
  const exp = createExperiment({ hypothesis: 'h' });
  const res = recordOutcome(exp, { diffStat: '3 files changed, 42 insertions(+)', testOutcome: { passed: true, summary: '621 pass' }, tradeoffs: 'two more files' });
  assert.equal(res.ok, true);
  assert.match(exp.diffStat, /42 insertions/);
  assert.equal(exp.testOutcome.passed, true);
  assert.equal(exp.tradeoffs, 'two more files');

  // A resolved experiment rejects new outcomes.
  exp.status = 'discarded';
  assert.equal(recordOutcome(exp, { testOutcome: false }).ok, false);
});

test('the registry persists across instances and crash-safe reopens', () => {
  const dir = tmp();
  const file = path.join(dir, 'experiments.json');
  const a = new ExperimentRegistry(file);
  const created = a.create({ hypothesis: 'worktree beats branch', branch: 'exp/a' });
  a.recordOutcome(created.id, { diffStat: '1 file changed', testOutcome: true });

  const b = new ExperimentRegistry(file);
  assert.equal(b.list().length, 1);
  assert.equal(b.get(created.id).testOutcome.passed, true);
});

test('promoting one experiment discards its active siblings', () => {
  const dir = tmp();
  const registry = new ExperimentRegistry(path.join(dir, 'experiments.json'));
  const a = registry.create({ hypothesis: 'A', branch: 'exp/a' });
  const b = registry.create({ hypothesis: 'B', branch: 'exp/b' });
  const res = registry.promote(a.id);
  assert.equal(res.ok, true);
  assert.equal(registry.get(a.id).status, 'promoted');
  assert.equal(registry.get(b.id).status, 'discarded');
  assert.deepEqual(res.discarded.map(e => e.id), [b.id]);
  // Promoting again is refused, not double-resolved.
  assert.equal(registry.promote(a.id).ok, false);
});

test('discarding records intent; only an explicit flag requests branch deletion', () => {
  const dir = tmp();
  const registry = new ExperimentRegistry(path.join(dir, 'experiments.json'));
  const a = registry.create({ hypothesis: 'A', branch: 'exp/a' });
  const res = registry.discard(a.id);
  assert.equal(res.ok, true);
  assert.equal(res.experiment.deleteBranchRequested, false);
  assert.equal(registry.discard(a.id).ok, false, 'double discard is refused');

  const c = registry.create({ hypothesis: 'C', branch: 'exp/c' });
  const res2 = registry.discard(c.id, { deleteBranch: true });
  assert.equal(res2.experiment.deleteBranchRequested, true);
});

test('compareExperiments builds a decision table with test outcomes', () => {
  const dir = tmp();
  const registry = new ExperimentRegistry(path.join(dir, 'experiments.json'));
  const a = registry.create({ hypothesis: 'A', branch: 'exp/a', approach: 'branch' });
  const b = registry.create({ hypothesis: 'B', branch: 'exp/b', approach: 'worktree' });
  registry.recordOutcome(a.id, { diffStat: '2 files changed, 10 insertions(+), 2 deletions(-)', testOutcome: true, tradeoffs: 'fast' });
  const table = compareExperiments(registry);
  assert.equal(table.length, 2);
  const rowA = table.find(r => r.id === a.id);
  assert.equal(rowA.testsPassed, true);
  assert.match(rowA.filesChanged, /2 files changed/);
  assert.equal(rowA.tradeoffs, 'fast');
});

test('a corrupt registry file does not throw — experiments are disposable', () => {
  const dir = tmp();
  const file = path.join(dir, 'experiments.json');
  fs.writeFileSync(file, '{definitely not json');
  const registry = new ExperimentRegistry(file);
  assert.equal(registry.list().length, 0);
});

test('experimentPromptBlock forbids touching the active tree', () => {
  assert.match(experimentPromptBlock(), /ISOLATED experiments/);
  assert.match(experimentPromptBlock(), /Never let an experimental branch modify the active working tree/);
});

// The standalone (non-registry) helpers keep working on plain objects.
test('promote/discard helpers work on a hand-rolled registry object', () => {
  const map = new Map();
  const a = createExperiment({ hypothesis: 'A' });
  const b = createExperiment({ hypothesis: 'B' });
  map.set(a.id, a); map.set(b.id, b);
  const fake = { get: id => map.get(id), list: s => [...map.values()].filter(e => e.status === s) };
  assert.equal(promoteExperiment(fake, a.id).ok, true);
  assert.equal(fake.get(b.id).status, 'discarded');
  assert.equal(discardExperiment(fake, a.id).ok, false);
});
