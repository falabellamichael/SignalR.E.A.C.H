'use strict';

/* Persistent interactive shell sessions — the `write_stdin` half of the Codex
 * port (docs/CODEX_AGENT_DESIGN.md). The one-shot `shell` tool cannot answer
 * prompts, drive a REPL, or keep a dev server alive between calls.
 *
 * Sessions are spawned through the platform layer with piped stdio — no PTY,
 * matching the zero-dependency design. Output (stdout+stderr interleaved) is
 * kept in a bounded tail buffer; reads drain only what is new since the
 * caller's last read. Sessions belong to the agent that opened them, are
 * killed when its run aborts, and idle sessions are reaped on access. */

const { spawn } = require('node:child_process');
const { commandEnv, killProcessTree } = require('./platform.cjs');

const MAX_SESSIONS_PER_AGENT = 4;
const MAX_SESSIONS = 32;
const BUFFER_LIMIT = 256 * 1024;
const IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_YIELD_MS = 10000;

const sessions = new Map();
let counter = 0;
let reaper = null;

function reap() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.closed || now - session.touched <= IDLE_TTL_MS) continue;
    killSession(session, 'Idle session expired.');
  }
  if (!sessions.size && reaper) { clearInterval(reaper); reaper = null; }
}

function ensureReaper() {
  if (!reaper) reaper = setInterval(reap, 60000);
  if (reaper.unref) reaper.unref();
}

function killSession(session, reason) {
  if (session.closed) return;
  session.closed = true;
  killProcessTree(session.proc);
  if (reason) session.buffer += `\n[session] ${reason}\n`;
}

function drop(session) {
  sessions.delete(session.id);
}

function append(session, text) {
  session.buffer += text;
  if (session.buffer.length > BUFFER_LIMIT) {
    session.buffer = '[session] earlier output dropped\n' + session.buffer.slice(-BUFFER_LIMIT);
    session.readOffset = Math.min(session.readOffset, '[session] earlier output dropped\n'.length);
  }
}

function own(agentId, sessionId) {
  const session = sessions.get(String(sessionId || ''));
  if (!session) return { error: `Unknown or closed session '${sessionId}'.` };
  if (session.agentId !== agentId) return { error: 'That session belongs to a different agent.' };
  return { session };
}

function drain(session) {
  const output = session.buffer.slice(session.readOffset);
  session.readOffset = session.buffer.length;
  return output;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function open(agentId, command, cwd) {
  reap();
  const mine = [...sessions.values()].filter(s => s.agentId === agentId).length;
  if (mine >= MAX_SESSIONS_PER_AGENT) return { ok: false, error: `Session limit reached (${MAX_SESSIONS_PER_AGENT}). Close a session or use the one-shot shell tool.` };
  if (sessions.size >= MAX_SESSIONS) return { ok: false, error: 'Too many sessions are open across agents.' };
  let proc;
  try {
    proc = spawn(command, [], {
      cwd, env: commandEnv(), shell: true,
      detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) { return { ok: false, error: error.message }; }
  const id = 'sh-' + (++counter).toString(36) + '-' + Date.now().toString(36);
  const session = { id, agentId, command, proc, buffer: '', readOffset: 0, touched: Date.now(), openedAt: Date.now(), closed: false, exitCode: null };
  sessions.set(id, session);
  ensureReaper();
  proc.stdout.on('data', data => append(session, String(data)));
  proc.stderr.on('data', data => append(session, String(data)));
  proc.on('error', error => { session.exitError = error.message; session.closed = true; append(session, `\n[session] spawn error: ${error.message}\n`); });
  proc.on('close', code => { session.closed = true; session.exitCode = code; append(session, `\n[session] exited with code ${code}\n`); });
  return { ok: true, sessionId: id, command };
}

async function write(agentId, sessionId, chars, yieldMs = 1000) {
  const { session, error } = own(agentId, sessionId);
  if (error) return { ok: false, error };
  session.touched = Date.now();
  if (session.closed) return { ok: false, error: 'The session process already exited. Read drains its remaining output.', output: drain(session), exitCode: session.exitCode };
  const text = String(chars ?? '');
  try { if (text) proc_write(session, text); }
  catch (error) { return { ok: false, error: 'stdin write failed: ' + error.message, output: drain(session) }; }
  await wait(Math.max(0, Math.min(MAX_YIELD_MS, Number(yieldMs) || 0)));
  return { ok: true, output: drain(session), running: !session.closed, exitCode: session.exitCode };
}

function proc_write(session, text) { session.proc.stdin.write(text); }

async function read(agentId, sessionId, yieldMs = 0) {
  const { session, error } = own(agentId, sessionId);
  if (error) return { ok: false, error };
  session.touched = Date.now();
  await wait(Math.max(0, Math.min(MAX_YIELD_MS, Number(yieldMs) || 0)));
  return { ok: true, output: drain(session), running: !session.closed, exitCode: session.exitCode };
}

function close(agentId, sessionId) {
  const { session, error } = own(agentId, sessionId);
  if (error) return { ok: false, error };
  session.touched = Date.now();
  killSession(session);
  const output = drain(session);
  drop(session);
  return { ok: true, output };
}

function closeAll(agentId) {
  for (const session of [...sessions.values()]) {
    if (session.agentId !== agentId) continue;
    killSession(session, 'Run stopped.');
    drop(session);
  }
}

function watchSignal(agentId, signal) {
  if (signal && !signal.__shellSessionWatched) {
    try { Object.defineProperty(signal, '__shellSessionWatched', { value: true }); } catch { /* non-extensible signal */ }
    signal.addEventListener('abort', () => closeAll(agentId), { once: true });
  }
}

module.exports = { open, write, read, close, closeAll, watchSignal, sessions, MAX_SESSIONS_PER_AGENT, IDLE_TTL_MS };
