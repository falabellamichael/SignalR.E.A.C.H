import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../service/store.mjs';
import studioAdapter from '../../studio/agent/hosted-account.cjs';
import vscodeAdapter from '../../vscode/hosted-account.js';
import studioView from '../../studio/renderer/account-view.js';
import vscodeView from '../../vscode/media/account-view.js';

test('a real SQLite Basic quota survives both account adapters without USD or legacy tokens', t => {
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const expiresAt = now + 86400000;
  const subscription = { basic: { id: 'basic-wallet', includedRequests: 1500, priceUsdMicros: 15000000 },
    overageUsdMicrosPerRequest: 10000, proEnabled: false };
  const model = { id: 'browser-model', name: 'My model', provider: 'Test bridge', access: 'requests',
    metered: true, bridge: { kind: 'tray', model: 'chatgpt-chat' } };
  const store = new AccountStore(':memory:', { subscription, models: [model], now: () => now });
  t.after(() => store.close());
  const raw = store.grantPlan({ wallet: '0x' + '11'.repeat(20), grantId: 'basic-adapter-regression',
    planId: 'basic-wallet', name: 'Basic', models: [model.id], tokens: 0, expiresAt });
  assert.equal(raw.credit.balanceMicros, 0);
  assert.equal(raw.allowance.totalRemaining, 0, 'request allowance does not convert into legacy tokens');
  assert.equal(raw.requestAllowance.remaining, 1500);
  for (const [name, adapter] of [['Studio', studioAdapter], ['VS Code', vscodeAdapter]]) {
    const projected = adapter.publicAccount(store.account(raw.id));
    assert.equal(projected.allowedModels.length, 1, name);
    assert.equal(projected.allowedModels[0].access, 'requests', name);
    assert.deepEqual(projected.allowedModels[0].pricing, { unit: 'request', usdMicrosPerRequest: '10000', includedRequests: '1500' }, name);
    assert.equal(projected.requestAllowance.basicActive, true, name);
    assert.equal(projected.requestAllowance.remaining, '1500', name);
    assert.equal(projected.requestAllowance.periodEndsAt, new Date(expiresAt).toISOString(), name);
    assert.equal(projected.credit.balanceMicros, '0', name);
    assert.equal(projected.allowedModels[0].bridge, undefined, 'private bridge routing stays out of public state');
    const view = studioView.derive({ status: 'connected', secureStorageAvailable: true, account: projected });
    assert.equal(view.usable, true, name + ' projection preserves eligibility without a USD balance');
    assert.equal(view.counts.includedRemaining, '1,500', name);
    for (const renderer of [studioView, vscodeView]) {
      assert.equal(renderer.modelPrice(projected.allowedModels[0], true),
        'US$0.01 per completed request after 1,500 included Basic requests', name);
    }
  }
  now = expiresAt;
  for (const adapter of [studioAdapter, vscodeAdapter]) {
    const account = adapter.publicAccount(store.account(raw.id));
    assert.equal(account.requestAllowance.basicActive, false);
    assert.equal(account.requestAllowance.remaining, '0');
    assert.deepEqual(account.allowedModels, []);
    assert.equal(studioView.derive({ status: 'connected', secureStorageAvailable: true, account }).usable, false);
  }
});
