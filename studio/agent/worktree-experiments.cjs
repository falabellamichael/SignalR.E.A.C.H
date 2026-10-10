'use strict';

/* Reach Studio — the git isolation layer for disposable alternative-solution
 * experiments (agentic capability 8).
 *
 * A competing approach is explored in a git WORKTREE under <project>/.experiments/<name>:
 * a real checkout of the base ref on its own branch, so anything written there
 * cannot touch the active working tree. The registry (agent/experiment-registry.cjs)
 * tracks hypotheses, outcomes and promote/discard decisions; THIS module is the
 * only place that talks to git. Every call is array-argv spawnSync with shell
 * unset — never a command string — and every path stays inside the project.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function git(projectDir, args, { timeoutMs = 60000 } = {}) {
  const result = spawnSync('git', ['-C', String(projectDir), ...args], { encoding: 'utf8', timeout: timeoutMs, shell: false });
  if (result.error && result.error.code === 'ENOENT') throw new Error('git is not available on this system.');
  if (result.status !== 0) {
    throw new Error('git ' + args[0] + ' failed: ' + String(result.stderr || result.error?.message || '').trim().slice(0, 500));
  }
  return String(result.stdout || '').trim();
}

function assertRepo(projectDir) {
  if (!fs.existsSync(path.join(String(projectDir), '.git'))) throw new Error('Not a git repository: ' + String(projectDir));
}

function assertName(name) {
  const safe = String(name || '');
  if (!NAME.test(safe)) throw new Error('Invalid experiment name "' + safe + '" (lowercase letters/digits/hyphens, 1-64 chars).');
  return safe;
}

function experimentsDir(projectDir) {
  return path.join(String(projectDir), '.experiments');
}

function experimentDir(projectDir, name) {
  return path.join(experimentsDir(projectDir), String(name));
}

/** Create <project>/.experiments/<name> as a worktree of baseRef on experiment/<name>. */
function createExperiment({ projectDir, name, baseRef = 'HEAD' }) {
  assertRepo(projectDir);
  const safe = assertName(name);
  const dir = experimentDir(projectDir, safe);
  if (fs.existsSync(dir)) throw new Error('Experiment already exists: ' + safe);
  fs.mkdirSync(experimentsDir(projectDir), { recursive: true });
  git(projectDir, ['worktree', 'add', '-b', 'experiment/' + safe, dir, String(baseRef || 'HEAD')]);
  return { name: safe, dir, branch: 'experiment/' + safe };
}

/** What has changed inside the experiment (porcelain paths + diff stat). */
function experimentStatus({ projectDir, name }) {
  assertRepo(projectDir);
  const safe = assertName(name);
  const dir = experimentDir(projectDir, safe);
  if (!fs.existsSync(dir)) throw new Error('Unknown experiment: ' + safe);
  const porcelain = git(dir, ['status', '--porcelain']);
  const changedFiles = porcelain.split('\n').filter(Boolean).map(l => l.slice(3).trim().replace(/^"|"$/g, '')).filter(Boolean);
  const diffStat = porcelain.trim() ? git(dir, ['diff', '--stat', 'HEAD']) : '';
  return { name: safe, dir, changedFiles, diffStat };
}

/** The full patch the experiment has produced relative to its base (may be ''). */
function experimentPatch({ projectDir, name }) {
  assertRepo(projectDir);
  const safe = assertName(name);
  const dir = experimentDir(projectDir, safe);
  if (!fs.existsSync(dir)) throw new Error('Unknown experiment: ' + safe);
  return git(dir, ['diff', 'HEAD']);
}

/** Remove the worktree and its branch. The active tree is never touched. */
function discardExperiment({ projectDir, name }) {
  assertRepo(projectDir);
  const safe = assertName(name);
  const dir = experimentDir(projectDir, safe);
  if (!fs.existsSync(dir)) throw new Error('Unknown experiment: ' + safe);
  git(projectDir, ['worktree', 'remove', '--force', dir]);
  try { git(projectDir, ['branch', '-D', 'experiment/' + safe]); } catch { /* branch may already be gone */ }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return { name: safe, discarded: true };
}

/** Experiment names under .experiments (worktree list, filtered to this dir). */
function listExperiments(projectDir) {
  assertRepo(projectDir);
  const base = experimentsDir(projectDir);
  if (!fs.existsSync(base)) return [];
  const porcelain = git(projectDir, ['worktree', 'list', '--porcelain']);
  const names = [];
  for (const line of porcelain.split('\n').map(l => l.trim()).filter(l => l.startsWith('worktree '))) {
    const dir = line.slice('worktree '.length);
    try {
      const rel = path.relative(base, dir);
      if (!rel || rel.startsWith('..') || rel.includes(path.sep)) continue;
      if (NAME.test(rel) && fs.existsSync(dir)) names.push(rel);
    } catch { continue; }
  }
  return names;
}

module.exports = { createExperiment, experimentStatus, experimentPatch, discardExperiment, listExperiments, experimentsDir, NAME };
