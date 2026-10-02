'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const studio = require('../studio/renderer/account-view.js');
const vscode = require('../vscode/media/account-view.js');
const studioAdapter = require('../studio/agent/hosted-account.cjs');
const vscodeAdapter = require('../vscode/hosted-account.js');
const requestModel = { id: 'browser-model', name: 'My model', access: 'requests',
  pricing: { unit: 'request', usdMicrosPerRequest: 10000, includedRequests: 1500 } };

function state({ basicActive = true, remaining = 1497, balance = 0, debt = 0, status = 'connected', ...extra } = {}) {
  return { status, baseUrl: 'https://accounts.example', secureStorageAvailable: true,
    account: { walletAddress: '0x' + '11'.repeat(20),
      plan: { name: 'Old Pro metadata', status: 'active', expiresAt: '2026-12-01T00:00:00.000Z' },
      allowedModels: [requestModel], allowance: { includedRemaining: 999999, totalRemaining: 999999, prepaidRemaining: 0, reserved: 0 },
      requestAllowance: { includedLimit: basicActive ? 1500 : 0, completed: 2, reserved: 1, remaining,
        periodEndsAt: '2026-11-01T00:00:00.000Z', overageUsdMicrosPerRequest: 10000, basicActive },
      credit: { currency: 'USD', balanceMicros: balance, reservedMicros: 0, debtMicros: debt } },
    config: { redemptionEnabled: false, redemptionModels: [requestModel] }, ...extra };
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {};
    this.handlers = {}; this.value = ''; this.disabled = false; this.classList = { add() {} };
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return (this.ownText || '') + this.children.map(child => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  querySelector(tag) { return descendants(this).find(child => child.tagName === tag.toUpperCase()); }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }

function vscodeRender(accountState, busy = false) {
  const parent = new Element(), actions = [];
  vscode.render({ createElement: tag => new Element(tag) }, parent, accountState,
    { onAction: (...args) => actions.push(args), drafts: {}, busy, error: '' });
  const use = descendants(parent).find(node => node.id === 'account-use');
  return { parent, use, actions };
}

function studioRenderer() {
  const html = fs.readFileSync(path.join(__dirname, '../studio/renderer/index.html'), 'utf8');
  const nodes = new Map(Array.from(html.matchAll(/\bid="([^"]+)"/g), match => [match[1], new Element()]));
  for (const id of ['included', 'prepaid', 'reserved', 'total']) {
    const card = new Element('article');
    card.append(new Element('p'), nodes.get('home-allowance-' + id), new Element('span'));
  }
  const document = { getElementById: id => nodes.get(id) || null, createElement: tag => new Element(tag) };
  let emit;
  const window = { reach: { account: { onState: handler => { emit = handler; }, get: () => new Promise(() => {}) } },
    ReachAccountView: studio, addEventListener() {}, ReachAccountMenu: {
      update() { nodes.get('account-menu-summary').textContent = 'Legacy usage tokens available'; }
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../studio/renderer/account.js'), 'utf8'),
    { window, document, setInterval: () => 0, clearInterval() {} }, { filename: 'studio/renderer/account.js' });
  return { emit, get: id => nodes.get(id), text: id => nodes.get(id).textContent };
}

test('Studio request view shows Basic only for an active Basic allowance and preserves period units', () => {
  const view = studio.derive(state());
  assert.equal(view.plan, 'Basic'); assert.equal(view.usable, true);
  assert.deepEqual(view.counts, { includedRemaining: '1,497', prepaidRemaining: '2', reserved: '1', totalRemaining: 'US$0.01 / request' });
  assert.equal(view.requestAllowance.includedLimit, '1,500');
  assert.equal(view.requestAllowance.periodEndsAt, '2026-11-01T00:00:00.000Z');
  assert.match(view.usageSummary, /1,497 included completed requests remaining.*US\$0\.01 overage per completed request/);
  const inactive = studio.derive(state({ basicActive: false, remaining: 1500, balance: 10000 }));
  assert.equal(inactive.plan, 'Wallet pay as you go');
  assert.equal(inactive.requestAllowance.remaining, '0');
  assert.equal(inactive.requestAllowance.includedLimit, '0');
  assert.equal(inactive.requestAllowance.periodEndsAt, null);
  assert.doesNotMatch(inactive.usageSummary, /1,500|Pro|included/);
});

test('both account UIs enforce the request credit boundary and do not grant inactive wallets included requests', () => {
  for (const options of [
    { basicActive: true, remaining: 1, balance: 0, expected: true },
    { basicActive: true, remaining: 0, balance: 9999, expected: false },
    { basicActive: true, remaining: 0, balance: 10000, expected: true },
    { basicActive: false, remaining: 1500, balance: 0, expected: false },
    { basicActive: false, remaining: 1500, balance: 9999, expected: false },
    { basicActive: false, remaining: 1500, balance: 10000, expected: true },
    { basicActive: false, remaining: 1500, balance: 10000, debt: 1, expected: false },
    { basicActive: true, remaining: 'invalid', balance: 0, expected: false },
  ]) {
    const fixture = state(options);
    assert.equal(studio.derive(fixture).usable, options.expected, JSON.stringify(options));
    assert.equal(vscodeRender(fixture).use.disabled, !options.expected, JSON.stringify(options));
  }
});

test('request allowance and credit do not bypass connected or secure-storage guards', () => {
  for (const status of ['locked', 'expired', 'disconnected', 'connecting']) {
    const fixture = state({ status, remaining: 1500, balance: 10000 });
    assert.equal(studio.derive(fixture).usable, false, status);
    assert.equal(vscodeRender(fixture).use, undefined, status);
  }
  const locked = state({ secureStorageAvailable: false });
  assert.equal(studio.derive(locked).usable, false);
  assert.equal(vscodeRender(locked).use.disabled, true);
  assert.equal(vscodeRender(state(), true).use.disabled, true, 'busy state still disables activation');
});

test('Studio renderer switches account cards, model prices and menu summary to completed requests', () => {
  const ui = studioRenderer(); ui.emit(state());
  assert.equal(ui.text('home-account-plan'), 'Basic');
  assert.equal(ui.text('home-account-plan-status'), 'BASIC');
  assert.match(ui.text('home-account-plan-detail'), /1,500 completed requests this subscription period/);
  assert.match(ui.text('home-account-models'), /US\$0\.01 per completed request after 1,500 included Basic requests/);
  assert.doesNotMatch(ui.text('home-account-models'), /per 1M tokens|Input|output/);
  assert.equal(ui.get('home-allowance-included').parentElement.querySelector('p').textContent, 'Included requests remaining');
  assert.doesNotMatch(ui.get('home-allowance-included').parentElement.textContent, /AI usage tokens/);
  assert.match(ui.text('account-menu-summary'), /1,497 included completed requests remaining/);
  assert.doesNotMatch(ui.text('account-menu-summary'), /usage tokens/);
  assert.equal(ui.get('home-account-use').disabled, false);
  ui.emit(state({ basicActive: false, remaining: 1500, balance: 9999 }));
  assert.equal(ui.text('home-account-plan'), 'Wallet pay as you go');
  assert.equal(ui.text('home-account-plan-status'), 'PAY AS YOU GO');
  assert.doesNotMatch(ui.text('home-account-plan-detail'), /1,500|Pro|Current period ends/);
  assert.equal(ui.get('home-account-use').disabled, true);
});

test('VS Code renders included completed requests and pay as you go without token prices or stale Pro claims', () => {
  const active = vscodeRender(state());
  assert.match(active.parent.textContent, /Basic includes 1,500 completed requests per subscription period/);
  assert.match(active.parent.textContent, /Included requests remaining1,497/);
  assert.match(active.parent.textContent, /Additional completed requests cost US\$0\.01 each/);
  assert.doesNotMatch(active.parent.textContent, /Available AI tokens|per 1M tokens|Old Pro/);
  const inactive = vscodeRender(state({ basicActive: false, remaining: 1500, balance: 10000 }));
  assert.match(inactive.parent.textContent, /Wallet pay as you go/);
  assert.match(inactive.parent.textContent, /US\$0\.01 per completed request/);
  assert.doesNotMatch(inactive.parent.textContent, /1,500|Old Pro|Subscription expires/);
  inactive.use.handlers.click();
  assert.deepEqual(inactive.actions, [['use', undefined]], 'the existing action transport is preserved');
});

test('card payment controls appear only when the service enables them and respect an active plan', () => {
  const find = (parent, id) => descendants(parent).find(node => node.id === id);
  const hidden = vscodeRender(state({ basicActive: false }));
  assert.equal(find(hidden.parent, 'account-subscribe'), undefined);
  const card = state({ basicActive: false, config: { cardPayments: true, subscription: { basic: { priceUsdMicros: '15000000' } }, redemptionModels: [requestModel] } });
  card.account.plan = { status: 'none' };
  const offered = vscodeRender(card);
  assert.match(find(offered.parent, 'account-subscribe').textContent, /Subscribe to Basic · US\$15\.00 a month/);
  assert.equal(find(offered.parent, 'account-subscribe').disabled, false);
  find(offered.parent, 'account-subscribe').handlers.click();
  find(offered.parent, 'account-topup').value = ' 20 ';
  find(offered.parent, 'account-topup-card').handlers.click();
  assert.deepEqual(offered.actions, [['subscribe', undefined], ['topup', '20']]);
  const active = vscodeRender({ ...card, account: { ...card.account, plan: { status: 'active' } } });
  assert.equal(find(active.parent, 'account-subscribe').disabled, true);
  assert.equal(find(active.parent, 'account-subscribe').textContent, 'Basic is active');
  assert.equal(find(offered.parent, 'account-billing'), undefined, 'nothing to manage without a plan');
  find(active.parent, 'account-billing').handlers.click();
  assert.deepEqual(active.actions, [['billing', undefined]]);

  const studioView = studioRenderer();
  studioView.emit({ ...card, status: 'disconnected', account: null });
  assert.equal(studioView.get('home-card-subscribe').disabled, true);
  assert.match(studioView.text('home-card-status'), /Connect your wallet/);
  studioView.emit(card);
  assert.equal(studioView.text('home-card-badge'), 'AVAILABLE');
  assert.equal(studioView.get('home-card-subscribe').disabled, false);
  assert.equal(studioView.get('home-card-topup').disabled, true, 'top-up waits for an amount');
  assert.equal(studioView.get('home-card-manage').hidden, true);
  studioView.emit({ ...card, account: { ...card.account, plan: { status: 'active' } } });
  assert.equal(studioView.get('home-card-manage').hidden, false);
  assert.equal(studioView.get('home-card-manage').disabled, false);
  studioView.emit({ ...card, config: { ...card.config, cardPayments: false } });
  assert.match(studioView.text('home-card-status'), /not enabled/);
});

test('PayPal controls appear next to card ones only when the service offers PayPal', () => {
  const find = (parent, id) => descendants(parent).find(node => node.id === id);
  const both = state({ basicActive: false, config: { cardPayments: true, paypalPayments: true, subscription: { basic: { priceUsdMicros: '15000000' } }, redemptionModels: [requestModel] } });
  both.account.plan = { status: 'none' };
  const view = vscodeRender(both);
  assert.match(find(view.parent, 'account-subscribe-paypal').textContent, /Subscribe with PayPal · US\$15\.00 a month/);
  find(view.parent, 'account-topup').value = '30';
  find(view.parent, 'account-subscribe-paypal').handlers.click();
  find(view.parent, 'account-topup-paypal').handlers.click();
  assert.deepEqual(view.actions, [['paypalSubscribe', undefined], ['paypalTopup', '30']]);
  const paypalOnly = vscodeRender({ ...both, config: { ...both.config, cardPayments: false } });
  assert.equal(find(paypalOnly.parent, 'account-subscribe'), undefined);
  assert.ok(find(paypalOnly.parent, 'account-topup-paypal'));
  const active = vscodeRender({ ...both, account: { ...both.account, plan: { status: 'active' } } });
  assert.equal(find(active.parent, 'account-subscribe-paypal').disabled, true);
  assert.match(active.parent.textContent, /cancelled in your PayPal account/);
  for (const adapter of [vscodeAdapter, studioAdapter]) {
    assert.equal(adapter.publicConfig({ paypalPayments: true }).paypalPayments, true);
    assert.equal(adapter.paypalUrl('https://www.sandbox.paypal.com/checkoutnow?token=1'), 'https://www.sandbox.paypal.com/checkoutnow?token=1');
    for (const bad of ['https://www.paypal.com.evil.example/x', 'https://paypal.com/x', 'http://www.paypal.com/x', 'https://u:p@www.paypal.com/x'])
      assert.throws(() => adapter.paypalUrl(bad), /outside PayPal/, bad);
  }
  const studioView = studioRenderer();
  studioView.emit({ ...both, config: { ...both.config, cardPayments: false } });
  assert.equal(studioView.text('home-card-badge'), 'AVAILABLE');
  assert.equal(studioView.get('home-card-subscribe').hidden, true);
  assert.equal(studioView.get('home-card-subscribe-paypal').hidden, false);
  assert.equal(studioView.get('home-card-subscribe-paypal').disabled, false);
  assert.equal(studioView.get('home-card-amount').disabled, false);
  studioView.emit({ ...both, account: { ...both.account, plan: { status: 'active' } } });
  assert.equal(studioView.get('home-card-paypal-note').hidden, false);
});

test('email accounts show their address and both apps offer email sign-in only when the service does', () => {
  const find = (parent, id) => descendants(parent).find(node => node.id === id);
  const emailOnly = state();
  emailOnly.account = { ...emailOnly.account, walletAddress: '', email: 'ada@example.com' };
  assert.match(vscodeRender(emailOnly).parent.textContent, /ada@example\.com/);
  const signedOut = { ...state({ status: 'disconnected' }), account: null };
  assert.equal(find(vscodeRender(signedOut).parent, 'account-connect').textContent, 'Sign in with wallet');
  assert.equal(find(vscodeRender({ ...signedOut, config: { ...signedOut.config, emailLogin: true } }).parent, 'account-connect').textContent, 'Sign in with wallet or email');
  for (const adapter of [vscodeAdapter, studioAdapter]) {
    assert.equal(adapter.publicAccount({ email: 'ada@example.com' }).email, 'ada@example.com');
    assert.equal(adapter.publicAccount({ email: 'not an email' }).email, '');
    assert.equal(adapter.publicAccount({ email: 'x'.repeat(250) + '@example.com' }).email, '');
    assert.equal(adapter.publicConfig({ emailLogin: true }).emailLogin, true);
    assert.equal(adapter.publicConfig({ emailLogin: 'yes' }).emailLogin, false);
  }
  const studioView = studioRenderer();
  studioView.emit(emailOnly);
  assert.equal(studioView.text('home-account-wallet'), 'ada@example.com');
  studioView.emit({ ...signedOut, config: { ...signedOut.config, emailLogin: true } });
  assert.equal(studioView.text('home-account-connect'), 'Sign in with wallet or email');
});

test('legacy token models retain their rate labels, allowances and USD credit activation in both renderers', () => {
  const legacyModel = { id: 'legacy', pricing: { inputUsdMicrosPerMillion: 150000, outputUsdMicrosPerMillion: 600000,
    cachedInputUsdMicrosPerMillion: 75000 } };
  const legacy = { status: 'connected', account: { plan: { name: 'Builder', status: 'active' },
    allowedModels: [legacyModel], allowance: { includedRemaining: 50, prepaidRemaining: 0, reserved: 0, totalRemaining: 50 } },
    config: { redemptionModels: [requestModel] } };
  assert.equal(studio.derive(legacy).requestMode, false);
  assert.equal(studio.derive(legacy).plan, 'Builder');
  assert.equal(studio.derive(legacy).counts.includedRemaining, '50');
  for (const view of [studio, vscode]) assert.equal(view.modelPrice(legacyModel), 'Input US$0.15 / output US$0.60 per 1M tokens / cached input US$0.075');
  const ui = studioRenderer(); ui.emit(state()); ui.emit(legacy);
  assert.equal(ui.get('home-allowance-included').parentElement.querySelector('span').textContent, 'AI usage tokens');
  assert.match(ui.text('home-account-models'), /per 1M tokens/);
  assert.match(vscodeRender(legacy).parent.textContent, /Available AI tokens50/);
  legacy.account.allowance.totalRemaining = 0;
  legacy.account.credit = { currency: 'USD', balanceMicros: 1, debtMicros: 0, reservedMicros: 0 };
  assert.equal(studio.derive(legacy).usable, true);
  assert.equal(vscodeRender(legacy).use.disabled, false);
  assert.match(vscodeRender(legacy).parent.textContent, /US\$0\.000001/);
});

test('public request model metadata displays the request tariff before sign-in without claiming a Basic grant', () => {
  const disconnected = { status: 'disconnected', baseUrl: 'https://accounts.example', config: { redemptionModels: [requestModel] } };
  assert.equal(studio.derive(disconnected).usable, false);
  assert.doesNotMatch(studio.modelPrice(requestModel), /1,500|tokens/);
  const ui = studioRenderer(); ui.emit(disconnected);
  assert.match(ui.text('home-account-models'), /US\$0\.01 per completed request/);
  const rendered = vscodeRender(disconnected);
  assert.match(rendered.parent.textContent, /US\$0\.01 per completed request/);
  assert.doesNotMatch(rendered.parent.textContent, /1,500|Old Pro/);
});

test('VS Code projects legacy token prices and pre-sign-in catalogue without subscription or credential fields', () => {
  const privateValue = 'private-fixture-credential';
  const model = { id: 'legacy-priced', name: 'Legacy priced', provider: 'Legacy provider', apiKey: privateValue,
    bridge: { model: privateValue }, pricing: { inputUsdMicrosPerMillion: 150000, outputUsdMicrosPerMillion: 600000,
      cachedInputUsdMicrosPerMillion: 75000, providerKey: privateValue } };
  const projected = vscodeAdapter.publicAccount({ allowedModels: [model] }).allowedModels[0];
  assert.deepEqual(projected, { id: 'legacy-priced', name: 'Legacy priced', provider: 'Legacy provider',
    pricing: { inputUsdMicrosPerMillion: '150000', outputUsdMicrosPerMillion: '600000', cachedInputUsdMicrosPerMillion: '75000' } });
  const config = vscodeAdapter.publicConfig({ enabled: true, redemptionModels: [model], apiKey: privateValue });
  assert.equal(config.subscription, undefined);
  assert.deepEqual(config.redemptionModels, [projected]);
  assert.equal(JSON.stringify(config).includes(privateValue), false);
  assert.match(vscodeRender({ status: 'disconnected', config }).parent.textContent, /Input US\$0\.15 \/ output US\$0\.60 per 1M tokens \/ cached input US\$0\.075/);
  for (const input of [null, -1, '1e6', {}, Number.NaN]) {
    assert.equal(vscodeAdapter.publicAccount({ allowedModels: [{ ...model, pricing: { ...model.pricing, inputUsdMicrosPerMillion: input } }] })
      .allowedModels[0].pricing, undefined);
  }
});

test('both account adapters whitelist the exact uncapped request capability without other model internals', () => {
  const model = { ...requestModel, capabilities: { outputTokenLimit: false, apiKey: 'private-capability-credential' },
    providerApi: { apiKey: 'private-provider-credential' } };
  for (const adapter of [studioAdapter, vscodeAdapter]) {
    for (const models of [adapter.publicAccount({ allowedModels: [model] }).allowedModels,
      adapter.publicConfig({ redemptionModels: [model] }).redemptionModels]) {
      assert.deepEqual(models[0].capabilities, { outputTokenLimit: false });
      assert.equal(models[0].pricing.unit, 'request');
      assert.equal(/private-|apiKey|providerApi/.test(JSON.stringify(models)), false);
    }
    for (const invalid of [true, 0, 'false', undefined]) {
      assert.equal(adapter.publicAccount({ allowedModels: [{ ...model, capabilities: { outputTokenLimit: invalid } }] })
        .allowedModels[0].capabilities, undefined);
    }
  }
});
