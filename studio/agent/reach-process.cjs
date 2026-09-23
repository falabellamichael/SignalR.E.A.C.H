'use strict';

/* Reach Studio — Projects subprocess spawner + per-run pub/sub.
 *
 * This launches project commands and the platform-specific Reach CLI. The
 * Projects page command bar and agent reach.* tools subscribe through
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

function runProcess({ cwd, command, args = [], label }) {
  const runId = ++runSeq;
  const proc = spawnCommand(command, args, { cwd: cwd || undefined });
  running.set(runId, { proc, killed: false });
  let launchError = false;
  proc.stdout.on('data', (d) => emit({ type: 'output', runId, channel: 'out', data: d.toString() }));
  proc.stderr.on('data', (d) => emit({ type: 'output', runId, channel: 'err', data: d.toString() }));
  proc.on('error', (e) => {
    launchError = true;
    const hint = label === 'Reach CLI' && e.code === 'ENOENT'
      ? 'Reach CLI is unavailable. Install it or set its executable in Settings → Connection.'
      : `${label} could not start: ${e.message}`;
    emit({ type: 'output', runId, channel: 'err', data: `${hint}\n` });
  });
  proc.on('close', (code) => {
    const stopped = running.get(runId)?.killed === true;
    running.delete(runId);
    emit({ type: 'exit', runId, code, launchError, stopped });
  });
  return runId;
}

function runReach({ cwd, args = [] }) {
  const spec = reachCommand(args, settingsProvider());
  return runProcess({ cwd, ...spec, label: 'Reach CLI' });
}

function runProject({ cwd, args = [] }) {
  if (!cwd || !Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0')))
    throw new Error('Choose a project and enter a command to run.');
  return runProcess({ cwd, command: args[0], args: args.slice(1), label: args[0] });
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

module.exports = { configure, runReach, runProject, killRun, killAllRuns, onRunEvent, reachVersion, WSL_DISTRO, REACH_BIN };
