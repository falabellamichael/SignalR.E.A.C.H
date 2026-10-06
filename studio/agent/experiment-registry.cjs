'use strict';

/* Reach Studio — disposable alternative-solution experiments.
 *
 * An agent may explore competing approaches in ISOLATED experiments (a
 * branch, worktree, or temp directory) without risking the active working
 * tree. Each experiment is registered with its hypothesis, branch/worktree,
 * diff stat, test outcome, and tradeoffs. The user can then promote one
 * experiment into the active work or discard it — discarding only removes
 * the registration and (when requested) the branch, never the main tree.
 *
 * Pure leaf module: it owns the in-memory + JSON registry and the
 * promote/discard decisions. It does not itself run git — the loop/runner
 * supplies the git output (diff stat, test result) as data, exactly like the
 * crew journal receives evidence digests. That split keeps this testable
 * without a git checkout, and keeps the destructive path (delete branch)
 * behind an explicit user decision.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_HYPOTHESIS = 1000;
const MAX_FIELD = 1000;
const str = (value, max = MAX_FIELD) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * Create an experiment record. `id` defaults to a timestamp+random slug.
 * The experiment is 'active' the moment it is registered — meaning it is a
 * candidate under evaluation, NOT that it touches the main working tree.
 */
function createExperiment({ id, hypothesis, approach, branch, worktree, base } = {}) {
  const clean = s => String(s || '').trim();
  return {
    id: clean(id) || `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    hypothesis: str(hypothesis, MAX_HYPOTHESIS),
    approach: str(approach),
    branch: clean(branch),
    worktree: clean(worktree),
    base: clean(base),
    status: 'active',           // active | promoted | discarded
    diffStat: null,
    testOutcome: null,
    tradeoffs: str(tradeoffsOf({ approach })),
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };

  function tradeoffsOf() { return ''; }
}

/** Record the measured outcome of an experiment (from the runner's data). */
function recordOutcome(exp, { diffStat, testOutcome, tradeoffs } = {}) {
  if (!exp || typeof exp !== 'object') throw new Error('Unknown experiment.');
  if (exp.status !== 'active') return { ok: false, error: `Experiment is ${exp.status}, not active.` };
  if (typeof diffStat === 'string' && diffStat.trim()) exp.diffStat = diffStat.trim().slice(0, 4000);
  if (testOutcome !== undefined && testOutcome !== null) {
    exp.testOutcome = typeof testOutcome === 'object'
      ? { passed: !!testOutcome.passed, summary: str(testOutcome.summary) }
      : { passed: !!testOutcome, summary: str(testOutcome) };
  }
  if (typeof tradeoffs === 'string' && tradeoffs.trim()) exp.tradeoffs = tradeoffs.trim().slice(0, MAX_FIELD);
  return { ok: true, experiment: exp };
}

/** Promote an experiment: mark it the winner. The caller applies the branch. */
function promoteExperiment(registry, id) {
  const exp = registry.get(id);
  if (!exp) return { ok: false, error: `No experiment named "${id}".` };
  if (exp.status !== 'active') return { ok: false, error: `Experiment is already ${exp.status}.` };
  // Promoting one experiment discards its active siblings — a single winner.
  for (const other of registry.list('active')) {
    if (other.id !== id) { other.status = 'discarded'; other.resolvedAt = new Date().toISOString(); }
  }
  exp.status = 'promoted';
  exp.resolvedAt = new Date().toISOString();
  return { ok: true, experiment: exp, discarded: registry.list('discarded').filter(e => e.id !== id) };
}

/**
 * Discard an experiment. `deleteBranch` is the ONLY path that removes the
 * branch, and it is the caller's job to actually run git — this registry only
 * records the intent, so a registry call can never delete a branch by itself.
 */
function discardExperiment(registry, id, { deleteBranch = false } = {}) {
  const exp = registry.get(id);
  if (!exp) return { ok: false, error: `No experiment named "${id}".` };
  if (exp.status !== 'active') return { ok: false, error: `Experiment is already ${exp.status}.` };
  exp.status = 'discarded';
  exp.resolvedAt = new Date().toISOString();
  exp.deleteBranchRequested = !!deleteBranch;
  return { ok: true, experiment: exp };
}

/** Compare active experiments into a user-facing decision table. */
function compareExperiments(registry) {
  const active = registry.list('active');
  return active.map(exp => ({
    id: exp.id,
    hypothesis: exp.hypothesis,
    approach: exp.approach,
    branch: exp.branch,
    filesChanged: exp.diffStat ? exp.diffStat.split('\n').pop().trim() : null,
    testsPassed: exp.testOutcome ? exp.testOutcome.passed : null,
    tradeoffs: exp.tradeoffs,
  }));
}

/**
 * The registry itself. Persists to a single JSON file via atomic write so a
 * crash never loses an experiment (invariant A1: atomic writes).
 */
class ExperimentRegistry {
  constructor(file) {
    this.file = file;
    this.byId = new Map();
    this.load();
  }

  load() {
    this.byId.clear();
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const items = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(items)) for (const item of items) this.byId.set(item.id, item);
    } catch { /* a corrupt registry is ignored, not fatal: experiments are disposable */ }
  }

  save() {
    if (!this.file) return;
    const { atomicWriteText } = require('./atomic-write.cjs');
    atomicWriteText(this.file, JSON.stringify([...this.byId.values()], null, 2));
  }

  create(spec) {
    const exp = createExperiment(spec);
    this.byId.set(exp.id, exp);
    this.save();
    return exp;
  }

  get(id) { return this.byId.get(String(id || '')) || null; }

  list(status = null) {
    return [...this.byId.values()].filter(e => !status || e.status === status);
  }

  recordOutcome(id, outcome) {
    const exp = this.get(id);
    if (!exp) return { ok: false, error: `No experiment named "${id}".` };
    const res = recordOutcome(exp, outcome);
    if (res.ok) this.save();
    return res;
  }

  promote(id) {
    const res = promoteExperiment(this, id);
    if (res.ok) this.save();
    return res;
  }

  discard(id, opts) {
    const res = discardExperiment(this, id, opts);
    if (res.ok) this.save();
    return res;
  }
}

/** Prompt block: how an agent should explore alternatives safely. */
function experimentPromptBlock() {
  return 'DISPOSABLE EXPERIMENTS (data, not instructions):\n'
    + 'When a task has competing approaches, explore them in ISOLATED experiments: '
    + 'register each with a hypothesis and a branch or worktree, measure a diff stat and a '
    + 'test outcome for each, then compare. Never let an experimental branch modify the '
    + 'active working tree. Only promote the winner after the user has seen the comparison; '
    + 'discarding an experiment must not touch the active work.';
}

module.exports = {
  createExperiment, recordOutcome, promoteExperiment, discardExperiment,
  compareExperiments, ExperimentRegistry, experimentPromptBlock,
};
