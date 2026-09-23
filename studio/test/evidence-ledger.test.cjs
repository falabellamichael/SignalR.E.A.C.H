'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CrewJournal } = require('../agent/crew-journal.cjs');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');

test('read, npm test, and a declined write leave three truthful evidence entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-ledger-'));
  try {
    fs.writeFileSync(path.join(dir, 'input.txt'), 'source evidence');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const journal = new CrewJournal(path.join(dir, 'teamrun-ledger.team.jsonl'));
    const edits = [];
    const context = {
      projectDir: dir, agentId: 'm0-test', journal,
      agentStore: { get: () => ({ settings: { approvals: 'prompt' } }), appendMessage: () => {} },
      requestApproval: () => true,
      requestEditReview: edit => edits.push(edit),
    };
    assert.equal((await runToolCall('m0-test', 'read', { path: 'input.txt' }, context)).ok, true);
    assert.equal((await runToolCall('m0-test', 'shell', { command: 'npm test' }, context)).ok, true);
    const write = await runToolCall('m0-test', 'write', { path: 'output.txt', content: 'proposal' }, context);
    assert.equal(write.pending, true);
    journal.append('evidence-decision', { editId: edits[0].editId, accepted: false });

    const ledger = new CrewJournal(journal.file).evidence('m0-test');
    assert.deepEqual(ledger.map(item => [item.tool, item.ok]), [['read', true], ['shell', true], ['write', false]]);
    assert.equal(ledger[2].decision, 'declined');
    for (const item of ledger) {
      assert.match(item.argumentsSha256, /^[a-f0-9]{64}$/);
      assert.match(item.resultSha256, /^[a-f0-9]{64}$/);
      assert.ok(item.elapsedMs >= 0);
    }
    assert.equal(fs.existsSync(path.join(dir, 'output.txt')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
