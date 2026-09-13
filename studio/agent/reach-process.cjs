'use strict';

/* Reach Studio — reach CLI subprocess spawner + per-run pub/sub.
 *
 * This is the single place that talks to wsl.exe. Everything else (the
 * Projects page command bar, agent reach.* tools) subscribes through
 * onRunEvent, which is a MAIN-PROCESS bus — renderer events are a separate
 * concern that main.mjs mirrors to the window.
 */

const { spawn } = require('child_process');

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
  const wslArgs = ['-d', WSL_DISTRO, '--', REACH_BIN, ...args];
  const proc = spawn('wsl.exe', wslArgs, {
    cwd: cwd || undefined,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  spawn('taskkill', ['/pid', String(r.proc.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  return true;
}

function killAllRuns() {
  for (const id of [...running.keys()]) killRun(id);
}

function reachVersion() {
  return new Promise((resolve) => {
    const p = spawn('wsl.exe', ['-d', WSL_DISTRO, '--', REACH_BIN, 'version'], { windowsHide: true });
    let s = '';
    p.stdout.on('data', (d) => (s += d));
    p.stderr.on('data', (d) => (s += d));
    p.on('close', (c) => resolve(c === 0 ? s.trim() : `error(${c}): ${s.trim()}`));
    p.on('error', (e) => resolve(`error: ${e.message}`));
  });
}

module.exports = { runReach, killRun, killAllRuns, onRunEvent, reachVersion, WSL_DISTRO, REACH_BIN };
