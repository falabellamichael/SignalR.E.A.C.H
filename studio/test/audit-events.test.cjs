'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuditLog } = require('../agent/audit-log.cjs');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');

test('a declined tool approval has one chained decision naming the tool and reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-audit-events-'));
  try {
    const log = new AuditLog(path.join(dir, 'audit.jsonl'));
    const result = await runToolCall('worker', 'shell', { command: 'npm test' }, {
      auditLog: log,
      agentStore: { get: () => ({ settings: { sandbox: { enabled: true } } }), appendMessage: () => {} },
      requestApproval: () => false,
      projectDir: dir,
    });
    assert.equal(result.ok, false);
    const decisions = log.read().filter(item => item.event === 'approval.decision');
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].allowed, false);
    assert.equal(decisions[0].reason, 'declined');
    assert.equal(JSON.parse(decisions[0].detail).tool, 'shell');
    assert.equal(log.verify().ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
