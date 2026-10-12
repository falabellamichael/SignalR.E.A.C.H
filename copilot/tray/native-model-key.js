'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const { credentialOrigin, validKey } = require('./model-credentials');

let pending = null;
function promptForModelKey(origin) {
    origin = credentialOrigin(origin);
    if (process.platform !== 'win32') return Promise.reject(new Error('Native Windows key entry is unavailable on this platform.'));
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
        const pipeName = 'signalreach-model-key-' + crypto.randomUUID();
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-STA', '-File',
            path.join(__dirname, 'native-model-key.ps1'), '-Origin', origin, '-PipeName', pipeName],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let socket = null;
        let readiness = '';
        let size = 0;
        let chunks = [];
        let finished = false;
        let streamEnded = false;
        let childClosed = false;
        let childCode = null;
        const fail = () => finish(new Error('Native secure key entry could not complete. No key was saved.'));
        const finish = (error, value = null) => {
            if (finished) return;
            finished = true;
            clearTimeout(startTimer);
            if (socket) socket.destroy();
            chunks.forEach(chunk => chunk.fill(0));
            chunks = [];
            if (error) { child.kill(); reject(error); } else resolve(value);
        };
        const complete = () => {
            if (!streamEnded || !childClosed) return;
            if (childCode !== 0) return fail();
            if (!size) return finish(null, null); // native Cancel, no credential change
            const bytes = Buffer.concat(chunks);
            const value = bytes.toString('utf8');
            bytes.fill(0);
            if (!validKey(value)) return fail();
            finish(null, value);
        };
        const startTimer = setTimeout(fail, 20000);
        child.stdout.on('data', bytes => {
            readiness += bytes.toString('utf8');
            if (readiness.length > 1000) return fail();
            if (!socket && readiness.includes('READY\n')) {
                clearTimeout(startTimer);
                socket = net.createConnection('\\\\.\\pipe\\' + pipeName);
                socket.on('data', chunk => {
                    size += chunk.length;
                    if (size > 4096) return fail();
                    chunks.push(chunk);
                });
                socket.on('end', () => { streamEnded = true; complete(); });
                socket.on('error', fail);
            }
        });
        // Native diagnostics are deliberately discarded: no stdout/stderr, key,
        // exception details or pipe payload is ever forwarded to a logger.
        child.stderr.resume();
        child.on('error', fail);
        child.on('close', code => { childClosed = true; childCode = code; if (!socket) fail(); else complete(); });
    }).finally(() => { pending = null; });
    return pending;
}
module.exports = { promptForModelKey };
