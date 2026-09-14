'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Telemetry, normalizeModels, gpuSnapshot, validateSources } = require('../agent/telemetry.cjs');
test('resident inventories do not confuse installed model size with RAM', () => {
  const models = normalizeModels('lmstudio', { models: [
    { key: 'downloaded-only', size_bytes: 123, loaded_instances: [] },
    { key: 'loaded', size_bytes: 999, loaded_instances: [{ id: 'resident', config: { context_length: 4096 } }] },
  ] });
  assert.equal(models.length, 1); assert.equal(models[0].name, 'resident'); assert.equal(models[0].bytes, null);
  assert.equal(normalizeModels('ollama', { models: [{ name: 'split', size: 100, size_vram: 60 }] })[0].ram, 40);
  assert.equal(normalizeModels('lemonade', { all_models_loaded: [], model_loaded: 'stale' }).length, 0);
  assert.throws(() => normalizeModels('lmstudio', { data: [{ id: 'available' }] }), /inventory/);
});
test('GPU sums processes within each engine then selects busiest, without summing unrelated engines', () => {
  const gpu = gpuSnapshot({ engines: [{ Name: 'pid_1_luid_A_eng_0', UtilizationPercentage: 40 }, { Name: 'pid_2_luid_A_eng_0', UtilizationPercentage: 30 }, { Name: 'pid_1_luid_A_eng_1', UtilizationPercentage: 50 }], memory: [{ DedicatedUsage: 90, SharedUsage: 12 }], adapters: [{ name: 'AMD', total: 12884901888 }] });
  assert.equal(gpu.utilization, 70); assert.equal(gpu.total, 12884901888); assert.equal(gpu.shared, 12);
  assert.equal(gpuSnapshot({}).utilization, null); assert.equal(gpuSnapshot({}).dedicated, null);
});
test('telemetry URLs reject credentials, unsafe protocols and query secrets', () => {
  for (const url of ['file:///secret', 'http://user:password@localhost', 'http://localhost?token=secret']) assert.throws(() => validateSources([{ type: 'ollama', url }]));
  assert.deepEqual(validateSources([]), []);
});
test('sampling is single flight and model inventory never sends chat or leaks credentials to another origin', async () => {
  let finish, samples = 0; const calls = [];
  const telemetry = new Telemetry({ getSettings: () => ({ endpoint: 'http://localhost:9999/v1', accessKey: 'private', telemetrySources: [{ type: 'ollama', url: 'http://127.0.0.1:11434' }] }),
    samplePlatform: () => { samples++; return new Promise(r => { finish = r; }); },
    fetcher: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ models: [] })); } });
  const a = telemetry.sample(), b = telemetry.sample(); finish({ notes: [], processes: [] });
  assert.equal(await a, await b); assert.equal(samples, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/ps'); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal((await telemetry.sample()).sources[0].state, 'connected'); assert.equal(samples, 1);
});
test('provider timeouts and missing OS counters remain unavailable instead of fabricated zero', async () => {
  const telemetry = new Telemetry({ samplePlatform: async () => { throw new Error('denied'); }, fetcher: async () => { throw new Error('offline'); } });
  const sample = await telemetry.sample(); assert.equal(sample.gpu.dedicated, null); assert.equal(sample.models.length, 0);
  assert.ok(sample.sources.every(s => s.state === 'unavailable')); assert.ok(sample.ram.total > 0); assert.ok(sample.notes.length);
});
