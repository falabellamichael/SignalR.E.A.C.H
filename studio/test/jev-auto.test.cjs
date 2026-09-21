'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideAuto, intersectFeatures } = require('../agent/jev-auto.cjs');

const enabled = { agent: true, workspace: true, think: true, web: true, terminal: true };
const candidates = [
  { id: 'small', kind: 'model', label: 'Small model', model: 'small-model' },
  { id: 'team', kind: 'team', label: 'Project team', description: 'Independent code and test review', members: [{ name: 'Coder', role: 'Implementation' }, { name: 'Tester', role: 'Verification' }] },
];
const base = () => ({ apiKey: 'test-key', query: 'Explain how a rainbow forms in simple language.', candidates, features: enabled, cache: new Map() });

function payload(body, { choice = 'candidate_0', confidence = 0.95, probability = 0.96, needs = {}, usage = { input_tokens: 210, output_tokens: 25 } } = {}) {
  const options = Object.keys(body.questions.route.criteria);
  const answers = { route: { type: 'choice', choice, confidence,
    probabilities: Object.fromEntries(options.map(option => [option, option === choice ? probability : (1 - probability) / (options.length - 1)])),
  } };
  for (const question of Object.keys(body.questions).filter(key => key.startsWith('need_'))) answers[question] = { type: 'noul', noul: needs[question.slice(5)] ?? 0.8 };
  return { answers, usage };
}

function respond(options = {}, inspect = () => {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    inspect(body, url, init);
    return { ok: true, json: async () => payload(body, options) };
  };
}

test('auto selects a configured model and removes clearly unnecessary tools without sharing credentials or prompts', async () => {
  const privateCandidate = { ...candidates[0], id: 'private-id', connectionId: 'private-connection', endpoint: 'https://private-host', accessKey: 'private-key', systemPrompt: 'private-persona', source: 'private-source' };
  const result = await decideAuto({ ...base(), candidates: [privateCandidate, candidates[1]],
    fetchImpl: respond({ needs: { agent: 0.02, workspace: 0.04, think: 0.09, web: 0.03, terminal: 0.01 } }, (body, url, init) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(init.headers.Authorization, 'Bearer test-key');
      assert.equal(init.redirect, 'error');
      assert.equal(body.model, 'jev-latest');
      assert.deepEqual(body.questions.route.criteria.candidate_0, { kind: 'model', label: 'Small model', model: 'small-model' });
      assert.deepEqual(body.state, { request: base().query, allowed_features: enabled });
      for (const value of ['private-id', 'private-connection', 'private-host', 'private-key', 'private-persona', 'private-source']) assert.ok(!init.body.includes(value));
    }),
  });
  assert.equal(result.candidateId, 'private-id');
  assert.deepEqual(result.features, { agent: false, workspace: false, think: false, web: false, terminal: false });
  assert.equal(result.reason, 'jev-auto');
  assert.deepEqual(result.usage, { inputTokens: 210, outputTokens: 25 });
});

test('team routing retains its local identity and only includes bounded member metadata', async () => {
  const result = await decideAuto({ ...base(), query: 'Implement the feature and have a separate specialist review tests.',
    candidates: [candidates[0], { ...candidates[1], teamId: 'private-team-id', members: [{ name: 'Reviewer', role: 'Test review', systemPrompt: 'private-role-prompt', endpoint: 'private-address' }] }],
    fetchImpl: respond({ choice: 'candidate_1' }, body => {
      assert.deepEqual(body.questions.route.criteria.candidate_1.members, [{ name: 'Reviewer', role: 'Test review' }]);
      assert.ok(!JSON.stringify(body).includes('private-'));
    }),
  });
  assert.equal(result.candidateId, 'team');
  assert.deepEqual(result.features, enabled);
});

test('uncertain route or feature judgments retain user settings; current is an explicit no-switch option', async () => {
  for (const route of [{ confidence: 0.79 }, { probability: 0.79 }, { choice: 'current' }]) {
    const result = await decideAuto({ ...base(), fetchImpl: respond({ ...route, needs: { agent: 0.5, workspace: 0.5, think: 0.5, web: 0.5, terminal: 0.5 } }) });
    assert.equal(result.candidateId, null);
    assert.deepEqual(result.features, enabled);
    assert.equal(result.reason, 'jev-keep');
  }
});

test('malformed choice distributions cannot switch routes or remove permissions', async () => {
  const corruptions = [
    answer => { answer.choice = 'not-configured'; },
    answer => { answer.probabilities.candidate_0 = '0.96'; },
    answer => { answer.probabilities.candidate_0 = NaN; },
    answer => { delete answer.probabilities.current; },
    answer => { answer.probabilities.unexpected = 0; },
    answer => { answer.probabilities.candidate_0 = 1; },
    answer => { answer.choice = 'current'; },
    answer => { answer.confidence = Infinity; },
    answer => { answer.type = 'score'; },
  ];
  for (const corrupt of corruptions) {
    const result = await decideAuto({ ...base(), fetchImpl: async (_url, init) => {
      const data = payload(JSON.parse(init.body), { needs: { agent: 0.01 } });
      corrupt(data.answers.route);
      return { ok: true, json: async () => data };
    } });
    assert.equal(result.candidateId, null);
    assert.equal(result.reason, 'invalid-response');
    assert.deepEqual(result.features, enabled);
  }
});

test('missing, wrongly typed, and out-of-range feature answers preserve the complete manual fallback', async () => {
  for (const invalid of [null, { type: 'choice', noul: 0 }, { type: 'noul', noul: -0.1 }, { type: 'noul', noul: '0' }]) {
    const result = await decideAuto({ ...base(), fetchImpl: async (_url, init) => {
      const data = payload(JSON.parse(init.body));
      data.answers.need_workspace = invalid;
      return { ok: true, json: async () => data };
    } });
    assert.equal(result.reason, 'invalid-response');
    assert.equal(result.candidateId, null);
    assert.deepEqual(result.features, enabled);
  }
});

test('auto cannot enable explicit disabled features or revive tool access while Agent is off', async () => {
  const result = await decideAuto({ ...base(), features: { ...enabled, agent: false, think: false },
    fetchImpl: respond({}, body => assert.deepEqual(Object.keys(body.questions), ['route'])),
  });
  assert.deepEqual(result.features, { agent: false, workspace: false, think: false, web: false, terminal: false });
  const settings = { features: { ...enabled, web: false }, approvals: 'prompt', disabledTools: ['shell'], reviewEdits: true, budgets: { maxTokens: 10 }, sandbox: { enabled: true } };
  const effective = intersectFeatures(settings, { ...enabled, terminal: false });
  assert.equal(effective.features.web, false);
  assert.equal(effective.features.terminal, false);
  for (const key of ['approvals', 'disabledTools', 'reviewEdits', 'budgets', 'sandbox']) assert.equal(effective[key], settings[key]);
  assert.equal(settings.features.terminal, true);
  // Reapplying the mask after a settings change must respect newly disabled tools.
  assert.equal(intersectFeatures({ ...settings, features: { ...settings.features, workspace: false } }, enabled).features.workspace, false);
});

test('manual commands, vague followups, long requests, missing keys, and absent candidates make no call', async () => {
  const cases = [
    [{ apiKey: '' }, 'missing-key'],
    [{ query: 'a'.repeat(1501) }, 'unusable-request'],
    [{ query: '/model select my saved model' }, 'explicit-route'],
    [{ query: '@ReviewTeam fix the UI layout' }, 'explicit-route'],
    [{ query: 'Please continue with that previous task' }, 'vague-request'],
    [{ query: 'What about the other one?' }, 'vague-request'],
    [{ query: 'yes' }, 'vague-request'],
    [{ candidates: [] }, 'no-candidates'],
    [{ candidates: Array.from({ length: 33 }, (_, i) => ({ id: `model-${i}`, kind: 'model', label: `Model ${i}` })) }, 'too-many-candidates'],
  ];
  for (const [change, reason] of cases) {
    let calls = 0;
    const result = await decideAuto({ ...base(), ...change, fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
    assert.equal(result.reason, reason);
    assert.equal(calls, 0);
    assert.equal(result.candidateId, null);
    assert.deepEqual(result.features, enabled);
  }
});

test('Stop cancels auto selection even when transport ignores the signal', async () => {
  const controller = new AbortController();
  const stopped = new Error('stopped by user');
  const result = decideAuto({ ...base(), signal: controller.signal, fetchImpl: () => {
    controller.abort(stopped);
    return new Promise(() => {});
  } });
  await assert.rejects(result, error => error === stopped);
  let calls = 0;
  await assert.rejects(decideAuto({ ...base(), signal: controller.signal, fetchImpl: async () => { calls++; } }), error => error === stopped);
  assert.equal(calls, 0);
});

test('the deadline bounds a stalled JSON body and falls back without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const result = decideAuto({ ...base(), fetchImpl: async () => {
    calls++;
    return { ok: true, json: () => new Promise(() => {}) };
  } });
  await Promise.resolve();
  t.mock.timers.tick(3500);
  assert.equal((await result).reason, 'request-timeout');
  assert.equal(calls, 1);
});

test('service errors, malformed JSON, and missing usage safely fall back without retries', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 429 }),
    async () => { throw new Error('network unavailable'); },
    async () => ({ ok: true, json: () => { throw new Error('not JSON'); } }),
  ]) {
    const result = await decideAuto({ ...base(), fetchImpl });
    assert.equal(result.candidateId, null);
    assert.deepEqual(result.features, enabled);
    assert.equal(result.usage, null);
  }
  assert.equal((await decideAuto({ ...base(), fetchImpl: respond({ usage: { input_tokens: 10 } }) })).usage, null);
});

test('cache reuses the identical decision without usage and invalidates changes to permissions, candidates, or API key', async () => {
  const cache = new Map();
  let calls = 0;
  const options = { ...base(), cache, fetchImpl: respond({}, () => calls++) };
  const first = await decideAuto(options);
  first.features.think = false;
  const second = await decideAuto(options);
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
  assert.equal(second.usage, null);
  assert.equal(second.features.think, true);
  await decideAuto({ ...options, features: { ...enabled, web: false } });
  await decideAuto({ ...options, candidates: [{ ...candidates[0], label: 'New model label' }, candidates[1]] });
  await decideAuto({ ...options, candidates: [{ ...candidates[0], id: 'replacement' }, candidates[1]] });
  await decideAuto({ ...options, apiKey: 'new-test-key' });
  assert.equal(calls, 5);
  const serialized = JSON.stringify([...cache]);
  assert.ok(!serialized.includes('test-key'));
  assert.ok(!serialized.includes(base().query));
});

test('cache evicts old decisions and remains bounded', async () => {
  const cache = new Map();
  let calls = 0;
  const options = { ...base(), cache, fetchImpl: respond({}, () => calls++) };
  for (let i = 0; i < 66; i++) await decideAuto({ ...options, query: `Explain how rainbow number ${i} forms in simple language.` });
  assert.equal(cache.size, 64);
  await decideAuto({ ...options, query: 'Explain how rainbow number 0 forms in simple language.' });
  assert.equal(calls, 67);
});
