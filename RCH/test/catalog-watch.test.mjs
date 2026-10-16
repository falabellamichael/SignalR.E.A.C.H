import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchModelCatalog } from '../service/catalog-watch.mjs';

const until = async predicate => {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('Model watcher did not observe the update');
};

test('model file watcher applies validated changes, ignores unrelated configuration and retains last good state', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'reach-catalog-test-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const file = join(directory, 'accounts.json');
  const initial = [{ id: 'test', limit: 20 }];
  writeFileSync(file, JSON.stringify({ models: initial, privateSetting: 'fixture' }));
  const applied = [];
  const logs = [];
  const stop = watchModelCatalog(file, initial, models => {
    if (!Array.isArray(models) || models[0]?.limit < 1) throw new Error('Invalid fixture');
    applied.push(models);
  }, message => logs.push(message));
  t.after(stop);
  writeFileSync(file, JSON.stringify({ models: [{ id: 'test', limit: 10 }], privateSetting: 'unrelated' }));
  await until(() => applied.length === 1);
  assert.equal(applied[0][0].limit, 10);
  writeFileSync(file, '{invalid');
  await until(() => logs.some(message => message.includes('rejected')));
  assert.equal(applied.length, 1);
  writeFileSync(file, JSON.stringify({ models: [{ id: 'test', limit: 10 }], privateSetting: 'changed-again' }));
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(applied.length, 1);
  writeFileSync(file, JSON.stringify({ models: [{ id: 'test', limit: 5 }] }));
  await until(() => applied.length === 2);
  assert.equal(applied[1][0].limit, 5);
});
