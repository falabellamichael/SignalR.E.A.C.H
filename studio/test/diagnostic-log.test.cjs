'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { AgentNet } = require('../agent/agent-net.cjs');

test('headless logger receives one structured record per round and tool call', () => {
  const records = [];
  const loop = new AgentLoop({ agentId: 'a', endpoint: 'http://localhost/v1',
    store: { get: () => null }, logger: record => records.push(record) });
  loop._emit('round', { round: 1 });
  loop._emit('tool-call', { tool: 'read', arguments: { path: 'private.txt' } });
  loop._emit('tool-result', { tool: 'read', ok: true, result: { content: 'secret' } });
  assert.deepEqual(records.map(record => record.event), ['round', 'tool-call', 'tool-result']);
  assert.equal(records[0].round, 1);
  assert.equal(records[1].tool, 'read');
  assert.equal(records[2].ok, true);
  assert.doesNotMatch(JSON.stringify(records), /private\.txt|secret/);
});

test('crew network uses the same optional logger without a renderer', () => {
  const records = [];
  const net = new AgentNet({ teamRunId: 'team-1', logger: { write: record => records.push(record) } });
  net._emit('agent-state', { agentId: 'worker-1', status: 'stalled' });
  net._emit('agent-message', { from: 'worker-1', to: 'worker-2', chars: 12 });
  assert.deepEqual(records.map(record => [record.event, record.teamRunId, record.status]),
    [['stall', 'team-1', 'stalled'], ['handoff', 'team-1', undefined]]);
});

test('a failing diagnostic observer cannot stop a run', () => {
  const loop = new AgentLoop({ agentId: 'a', endpoint: 'http://localhost/v1',
    store: { get: () => null }, logger: () => { throw new Error('logger failed'); } });
  assert.doesNotThrow(() => loop._emit('round', { round: 1 }));
});
