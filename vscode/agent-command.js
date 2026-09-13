'use strict';

const {spawn} = require('child_process');

// One approved command, one process tree, one output stream. Closing the
// terminal or pressing Stop cancels this same process, including its children.
function runAgentCommand(command, {cwd, signal, onOutput = () => {}, timeoutMs = 120000} = {}) {
  signal?.throwIfAborted();
  return new Promise(resolve => {
    let child, timer, done = false, collected = '', stopping = '', truncated = false;
    const append = chunk => {
      const text = String(chunk);
      onOutput(text);
      const remaining = 60000 - collected.length;
      if (text.length > remaining) truncated = true;
      if (remaining > 0) collected += text.slice(0, remaining);
    };
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const reason = error || stopping;
      const summary = reason || 'exit code ' + code;
      onOutput('\n' + summary + '\n');
      resolve({ok:!reason && code === 0, code, output:summary + '\n' + (collected || '(no output)')
        + (truncated ? '\n[Captured output truncated at 60,000 characters; the full stream was shown in the terminal.]' : '')});
    };
    const stop = reason => {
      if (done || stopping) return;
      stopping = reason;
      if (!child?.pid) { finish(null, reason); return; }
      if (process.platform === 'win32') {
        // PID is the process we just spawned; no broad name-based termination.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true, stdio:'ignore'});
        killer.on('error', () => { child.kill(); });
        killer.on('close', code => { if (code !== 0 && !done) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => stop('Stopped by you.');
    try {
      child = spawn(command, {shell:true, windowsHide:true, cwd,
        detached:process.platform !== 'win32', env:{...process.env, NO_COLOR:'1'}});
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', e => finish(null, 'Could not start command: ' + e.message));
      child.on('close', code => finish(code));
      signal?.addEventListener('abort', abort, {once:true});
      if (signal?.aborted) abort();
      if (timeoutMs > 0) timer = setTimeout(() => stop('Timed out after ' + Math.round(timeoutMs / 1000) + 's.'), timeoutMs);
    } catch (e) { finish(null, 'Could not start command: ' + e.message); }
  });
}

module.exports = {runAgentCommand};
