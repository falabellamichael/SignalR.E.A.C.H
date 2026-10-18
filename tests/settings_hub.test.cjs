'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hub = require('../vscode/settings-hub.cjs');
const values = { name: 'Mine', endpoint: 'https://provider.example/v1', model: 'model-a', temperature: .7, maxTokens: 1024 };
test('shared settings persist and apply to both clients without changing permissions or credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-hub-'));
  try {
    const file = path.join(dir, 'settings.json');
    hub.save(values, file);
    hub.setSync(true, file);
    const shared = hub.read(file);
    const original = { connections: [{ id: 'mine', endpoint: values.endpoint, accessKey: 'secret' }], shellEnabled: false, budgets: { maxRounds: 5 } };
    const studio = hub.applyStudio(original, shared);
    assert.equal(studio.model, values.model);
    assert.equal(studio.accessKey, 'secret');
    assert.equal(studio.shellEnabled, false);
    assert.equal(studio.budgets.maxRounds, 5);
    assert.equal(hub.applyStudio(studio, shared), studio);
    const updates = {};
    const state = new Map();
    const vscode = { ConfigurationTarget: { Global: 1 }, workspace: { getConfiguration: () => ({ get: () => [], update: async (k,v) => { updates[k] = v; } }) } };
    await hub.applyCode(vscode, { globalState: { get: k => state.get(k), update: async (k,v) => state.set(k,v) } }, shared);
    assert.equal(updates.model, studio.model);
    assert.equal(updates.selectedEndpoint, studio.endpoint);
    assert.equal(updates.maxTokens, studio.budgets.maxTokens);
    assert.equal(updates.accessKey, undefined);
    assert.equal(updates.agentic, undefined);
    assert.throws(() => hub.save({ ...values, admin: true }, file), /Unsupported/);
    assert.throws(() => hub.save({ ...values, endpoint: 'https://user:secret@example.com' }, file));
    assert.equal(hub.read(file).revision, shared.revision);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('sync off leaves clients alone; enabling and saving refreshes each revision once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-hub-watch-'));
  const file = path.join(dir, 'settings.json');
  const seen = [];
  const watcher = hub.watch(async shared => seen.push(shared.settings.model), file);
  try {
    hub.save(values, file);
    await watcher.poll();
    assert.deepEqual(seen, []);
    const original = { model: 'local' };
    assert.equal(hub.applyStudio(original, hub.read(file)), original);
    hub.setSync(true, file);
    await watcher.poll(); await watcher.poll();
    assert.deepEqual(seen, ['model-a']);
    hub.save({ ...values, model: 'model-b' }, file);
    await watcher.poll();
    assert.deepEqual(seen, ['model-a', 'model-b']);
    hub.setSync(false, file);
    hub.save({ ...values, model: 'model-c' }, file);
    await watcher.poll();
    assert.deepEqual(seen, ['model-a', 'model-b']);
  } finally { watcher.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
