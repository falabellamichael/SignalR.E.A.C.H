'use strict';

/* Reach Studio — reach CLI subprocess spawner + per-run pub/sub.
 *
 * This is the single place that launches the platform-specific Reach CLI. Everything else (the
 * Projects page command bar, agent reach.* tools) subscribes through
 * onRunEvent, which is a MAIN-PROCESS bus — renderer events are a separate
 * concern that main.mjs mirrors to the window.
 */

const { reachCommand, spawnCommand, killProcessTree, runCommand } = require('./platform.cjs');
let settingsProvider = () => ({});
function configure(provider) { settingsProvider = provider; }

const WSL_DISTRO = 'Ubuntu';
const REACH_BIN = '/usr/local/bin/reach';

const running = new Map(); // runId -> { proc, killed }
const listeners = new Set();
let runSeq = 0;

function emit(payload) {
  for (const fn of listeners) {
    try { fn(payload); } catch { /* a bad listener must not break others */ }
  }
}

function onRunEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function runReach({ cwd, args = [] }) {
  const runId = ++runSeq;
  const spec = reachCommand(args, settingsProvider());
  const proc = spawnCommand(spec.command, spec.args, { cwd: cwd || undefined });
  running.set(runId, { proc, killed: false });
  proc.stdout.on('data', (d) => emit({ type: 'output', runId, channel: 'out', data: d.toString() }));
  proc.stderr.on('data', (d) => emit({ type: 'output', runId, channel: 'err', data: d.toString() }));
  proc.on('error', (e) => emit({ type: 'output', runId, channel: 'err', data: `Failed to launch reach: ${e.message}\n` }));
  proc.on('close', (code) => {
    running.delete(runId);
    emit({ type: 'exit', runId, code });
  });
  return runId;
}

function killRun(runId) {
  const r = running.get(runId);
  if (!r) return false;
  r.killed = true;
  killProcessTree(r.proc);
  return true;
}

function killAllRuns() {
  for (const id of [...running.keys()]) killRun(id);
}

async function reachVersion() {
  const spec = reachCommand(['version'], settingsProvider());
  const result = await runCommand(spec.command, spec.args, { timeoutMs: 10000, maxOutput: 4096 });
  if (result.ok) return result.stdout.trim();
  return `Optional Reach CLI unavailable. Configure its executable in Settings. ${result.error || result.stderr.trim() || `Exit ${result.exitCode}`}`;
}

module.exports = { configure, runReach, killRun, killAllRuns, onRunEvent, reachVersion, WSL_DISTRO, REACH_BIN };
