'use strict';
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

// Finder-launched apps do not inherit a terminal's Homebrew/user PATH.
function commandEnv(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return { ...env };
  const dirs = [env.PATH || '', '/opt/homebrew/bin', '/usr/local/bin', path.posix.join(home, '.local/bin'), path.posix.join(home, 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return { ...env, PATH: [...new Set(dirs.join(':').split(':').filter(Boolean))].join(':') };
}
function reachCommand(args = [], settings = {}, platform = process.platform, env = process.env) {
  // Use the compiler directly. The upstream `reach` launcher probes Docker even
  // when REACH_DOCKER=0, so it cannot back a Docker-free Studio mode.
  const executable = String(settings.reachCli || env.REACH_STUDIO_REACHC || '').trim();
  if (platform === 'win32') return { command: 'wsl.exe', args: ['-d', 'Ubuntu', '--', executable || 'reachc', ...args] };
  return { command: executable || 'reachc', args: [...args] };
}
function spawnCommand(command, args = [], options = {}) {
  return spawn(command, args, { ...options, env: commandEnv(options.env), detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
// Each POSIX command owns a process group, including compiler/shell children.
function killProcessTree(proc, platform = process.platform) {
  if (!proc?.pid) return false;
  if (platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { proc.kill(); } catch {} });
  } else {
    try { process.kill(-proc.pid, 'SIGKILL'); }
    catch { try { proc.kill('SIGKILL'); } catch {} }
  }
  return true;
}
function runCommand(command, args = [], options = {}) {
  const { signal, timeoutMs = 600000, maxOutput = 60000, ...spawnOptions } = options;
  if (signal?.aborted) return Promise.resolve({ ok: false, error: 'Command cancelled.', cancelled: true });
  return new Promise(resolve => {
    let proc;
    try { proc = spawnCommand(command, args, spawnOptions); }
    catch (error) { resolve({ ok: false, error: error.message }); return; }
    let stdout = '', stderr = '', failure = '', settled = false;
    const stop = reason => { failure ||= reason; killProcessTree(proc); };
    const abort = () => stop('Command cancelled.');
    const timer = setTimeout(() => stop('Command timed out.'), timeoutMs);
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ ok: exitCode === 0 && !failure && !error, exitCode, stdout, stderr,
        ...(failure || error ? { error: failure || error } : {}), ...(signal?.aborted ? { cancelled: true } : {}) });
    };
    proc.stdout.on('data', data => { stdout += data; if (stdout.length + stderr.length > maxOutput) { stdout = stdout.slice(0, Math.max(0, maxOutput - stderr.length)); stop('Command output limit reached.'); } });
    proc.stderr.on('data', data => { stderr += data; if (stdout.length + stderr.length > maxOutput) { stderr = stderr.slice(0, Math.max(0, maxOutput - stdout.length)); stop('Command output limit reached.'); } });
    proc.on('error', error => finish(null, error.message));
    proc.on('close', code => finish(code));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
module.exports = { commandEnv, reachCommand, spawnCommand, killProcessTree, runCommand };
