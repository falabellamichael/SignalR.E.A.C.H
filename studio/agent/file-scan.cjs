'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

// A recursive scan (including user-supplied regexes) must never occupy the
// Electron main thread. Termination also interrupts a stuck regex or disk scan.
function runFileScan(action, args, { projectDir, signal, scanTimeoutMs = 15000 }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'file-scan-worker.cjs'), {
      workerData: { action, args, projectDir },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(signal.reason || new Error('Scan stopped.'));
    const timer = setTimeout(() => finish(new Error('File scan timed out. Narrow the path or pattern and try again.')), scanTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`File scan exited before returning a result (${code}).`)); });
    if (signal?.aborted) abort();
  });
}

module.exports = { runFileScan };
