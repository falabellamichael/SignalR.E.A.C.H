'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TeamMessageQueue } = require('../agent/team-message-queue.cjs');
const { decideTeamPriority } = require('../agent/jev-team-priority.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const saved = new Map(), events = [], delivered = [], started = [];
  let run = { teamRunId: 'r', team: { id: 't' } }, apply;
  const queue = new TeamMessageQueue({
    read: id => saved.get(id), write: (id, rows) => saved.set(id, structuredClone(rows)),
    notify: (...event) => events.push(event), findRun: () => run,
    judge: async () => ({ steer: false, reason: 'can-wait' }),
    steer: (_run, _item, callback) => { apply = callback; return { ok: true }; },
    applied: (_id, item) => delivered.push(item.message),
    dispatch: async (_id, item) => { started.push(item.message); run = { teamRunId: 'next', team: { id: 't' } }; return { ok: true }; },
    ...options,
  });
  return { queue, saved, events, delivered, started, apply: () => apply(), setRun: value => { run = value; },
    add: (message, mode = 'auto') => queue.enqueue('a', { teamId: 't', teamRunId: 'r', message, mode }) };
}
test('ordinary follow-up waits, survives reads, and starts exactly once when the team finishes', async () => {
  const f = fixture(); f.add('Then write documentation.'); await tick();
  assert.equal(f.queue.list('a')[0].state, 'queued'); assert.deepEqual(f.started, []);
  f.setRun(null); f.queue.finished('a', 'r', true); await tick();
  assert.deepEqual(f.started, ['Then write documentation.']); assert.deepEqual(f.queue.list('a'), []);
});
test('important Auto guidance is delivered once and removed only after application', async () => {
  const f = fixture({ judge: async () => ({ steer: true, reason: 'important' }) });
  const item = f.add('Correction: preserve the existing endpoint.'); await tick();
  assert.equal(f.queue.list('a')[0].state, 'steering'); assert.deepEqual(f.delivered, []);
  assert.equal(f.queue.promote('a', item.id).ok, false);
  f.apply(); f.apply(); assert.equal(f.delivered.length, 1); assert.deepEqual(f.queue.list('a'), []);
});
test('manual steering wins over a late Auto decision without double delivery', async () => {
  let finish;
  const f = fixture({ judge: () => new Promise(resolve => { finish = resolve; }) });
  const item = f.add('Please correct that.'); await tick();
  assert.equal(f.queue.promote('a', item.id).ok, true);
  finish({ steer: true }); await tick();
  assert.equal(f.queue.list('a')[0].state, 'steering'); f.apply(); assert.equal(f.delivered.length, 1);
});
test('cancel while judging never resurrects or delivers a message', async () => {
  let finish; const f = fixture({ judge: () => new Promise(resolve => { finish = resolve; }) });
  const item = f.add('Later task'); await tick(); f.queue.cancel('a', item.id);
  finish({ steer: true }); await tick(); assert.deepEqual(f.queue.list('a'), []); assert.deepEqual(f.delivered, []);
});
test('a stale classification cannot steer a replacement team run', async () => {
  let finish; const f = fixture({ judge: () => new Promise(resolve => { finish = resolve; }) });
  f.add('Do not replace the file.'); await tick(); f.setRun({ teamRunId: 'replacement', team: { id: 't' } });
  finish({ steer: true }); await tick(); assert.equal(f.queue.list('a')[0].state, 'queued');
});
test('paused member rejection and thrown routing errors restore the queued message', async () => {
  for (const steer of [() => ({ ok: false, error: 'Paused' }), () => { throw new Error('Missing member'); }]) {
    const f = fixture({ steer }); f.add('Fix this', 'steer'); await tick(); assert.equal(f.queue.list('a')[0].state, 'queued');
  }
});
test('stopped runs hold messages and a late judgment cannot auto-start more work', async () => {
  let finish; const f = fixture({ judge: () => new Promise(resolve => { finish = resolve; }) });
  f.add('Later task'); await tick(); f.setRun(null); f.queue.finished('a', 'r', false);
  finish({ steer: true }); await tick(); await f.queue.drain('a'); assert.deepEqual(f.started, []);
  await f.queue.drain('a', true); assert.equal(f.started.length, 1);
});
test('undelivered steering becomes the next turn instead of disappearing on completion', async () => {
  const f = fixture(); f.add('Change this', 'steer'); await tick();
  f.setRun(null); f.queue.finished('a', 'r', true); await tick(); assert.deepEqual(f.started, ['Change this']);
});
test('failed dispatch keeps its text and does not retry automatically in a loop', async () => {
  let calls = 0; const f = fixture({ dispatch: async () => { calls++; return { ok: false, err: 'Provider unavailable' }; } });
  f.add('Later'); await tick(); f.setRun(null); await f.queue.drain('a');
  assert.equal(calls, 1); assert.equal(f.queue.list('a')[0].message, 'Later');
});
test('persistent queue recovery requires Send now, even after another run finishes', async () => {
  const f = fixture(); f.saved.set('a', [{ id: 'old', message: 'Keep me', state: 'steering' }]);
  assert.equal(f.queue.list('a')[0].state, 'queued'); assert.deepEqual(f.started, []);
  f.setRun(null); f.queue.finished('a', 'another-run', true); await tick(); assert.deepEqual(f.started, []);
  await f.queue.drain('a', true); assert.deepEqual(f.started, ['Keep me']);
});
test('queue rejects empty, oversized, and excessive messages before saving', () => {
  const f = fixture(); assert.throws(() => f.add('')); assert.throws(() => f.add('a'.repeat(20001)));
  for (let i = 0; i < 20; i++) f.add('Later ' + i, 'queue');
  assert.throws(() => f.add('Overflow')); assert.equal(f.queue.list('a').length, 20);
});
test('priority validates Noul results and uses bounded state with one question', async () => {
  for (const [value, steer] of [[.95, true], [.8, true], [.79, false], [.2, false]]) {
    const result = await decideTeamPriority({ apiKey: 'fixture', message: 'Do not delete anything', task: 'Clean the repo', fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body.questions), ['steer_now']);
      assert.equal(body.state.new_message, 'Do not delete anything');
      return { ok: true, json: async () => ({ answers: { steer_now: { type: 'noul', noul: value } }, usage: { input_tokens: 80, output_tokens: 2 } }) };
    } }); assert.equal(result.steer, steer); assert.equal(result.usage.inputTokens, 80);
  }
});
test('missing keys, long input, malformed answers, timeouts and errors safely queue', async () => {
  assert.equal((await decideTeamPriority({ message: 'Urgent' })).steer, false);
  assert.equal((await decideTeamPriority({ apiKey: 'fixture', message: 'a'.repeat(1501) })).steer, false);
  for (const fetchImpl of [async () => { throw new Error('Offline'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ answers: { steer_now: { type: 'noul', noul: 2 } } }) })]) {
    assert.equal((await decideTeamPriority({ apiKey: 'fixture', message: 'Urgent', fetchImpl })).steer, false);
  }
  const keepAlive = setTimeout(() => {}, 100);
  const result = await decideTeamPriority({ apiKey: 'fixture', message: 'Urgent', timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  clearTimeout(keepAlive); assert.equal(result.reason, 'timeout');
});
