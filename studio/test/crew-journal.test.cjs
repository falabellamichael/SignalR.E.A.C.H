'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { CrewJournal, listRecoverable } = require('../agent/crew-journal.cjs');

test('a killed two-member crew keeps its completed turn and message for recovery', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-crew-crash-'));
  const file = path.join(dir, 'teamrun-crash-fixture.team.jsonl');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (body.model === 'b') return; // Keep member B in flight until SIGKILL.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'complete', message: 'A verified result.', actions: [], options: [] }) }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'crew-crash-child.cjs'), endpoint, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const deadline = Date.now() + 10000;
  let snapshot;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      snapshot = new CrewJournal(file).snapshot();
      if (snapshot.members.some(item => item.name === 'A') && snapshot.messages.length) break;
    }
    if (child.exitCode !== null) throw new Error(`Crew child exited early with ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(snapshot?.members.some(item => item.name === 'A'));
  assert.equal(snapshot.messages.length, 1);
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));

  const recovered = new CrewJournal(file).snapshot();
  assert.equal(recovered.recoverable, true);
  assert.match(recovered.members[0].output, /A verified result/);
  assert.equal(recovered.messages[0].message, 'First result is ready.');
  assert.equal(listRecoverable(dir).length, 1);
});
