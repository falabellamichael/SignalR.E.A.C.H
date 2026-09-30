'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/public/reach-public.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/public/plugin.json'), 'utf8'));
const PREFS_KEY = 'signal-reach-public.preferences.v1';
const API = '/api/extensions/rag-workspace';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.classes = new Set();
    this.open = false;
    this.disabled = false;
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  appendChild(node) {
    node.remove();
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  replaceChildren(...nodes) {
    this.children.forEach(node => { node.parentElement = null; });
    this.children = [];
    nodes.forEach(node => this.appendChild(node));
  }
  set textContent(value) { this.ownText = String(value); this.replaceChildren(); }
  get textContent() { return (this.ownText || '') + this.children.map(node => node.textContent).join(''); }
  set value(value) { this.inputValue = String(value); }
  get value() { return this.inputValue ?? (this.tagName === 'SELECT' ? this.children[0]?.value : '') ?? ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  dispatch(name) { return this.handlers[name]?.({ preventDefault() {} }); }
  click() { if (!this.disabled) return this.dispatch('click'); }
  querySelector(selector) {
    const matches = selector.startsWith('[')
      ? node => Object.hasOwn(node.attributes, selector.slice(1, -1))
      : selector.startsWith('.') ? node => (node.className || '').split(' ').includes(selector.slice(1))
        : node => node.tagName === selector.toUpperCase();
    return descendants(this).find(matches) || null;
  }
}

function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }

function control(root, label) {
  const field = descendants(root).find(node => node.tagName === 'LABEL' && node.children[0]?.textContent === label);
  assert.ok(field, 'field exists: ' + label);
  return field.children[1];
}

function button(root, label) {
  const found = descendants(root).find(node => node.tagName === 'BUTTON' && node.textContent === label);
  assert.ok(found, 'button exists: ' + label);
  return found;
}

function mount({ stored = {}, respond = async () => ({}) } = {}) {
  const container = new Element('main');
  const storage = new Map(Object.entries(stored));
  const reads = [];
  const calls = [];
  const registrations = [];
  const localStorage = {
    getItem(key) { reads.push(key); return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const window = {
    __signalReachPublicManifest: manifest,
    RAGWorkspaceExtensions: {
      registerController: registration => registrations.push(registration),
      registerManifest: registration => registrations.push(registration),
    },
  };
  Object.defineProperty(window, '__reachCore', { get() { throw new Error('Public edition must not read the admin core'); } });
  const legacyController = Object.freeze({ owner: 'synthetic-owner-controller' });
  window.signalReach = legacyController;
  const document = { createElement: tag => new Element(tag), getElementById: () => null };
  const fetch = async (url, options) => {
    const call = { url, options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const reply = await respond(call, calls.length);
    return { ok: reply?.ok !== false, status: reply?.status || 200,
      json: async () => reply?.data ?? reply };
  };
  const sandbox = { window, document, localStorage, fetch, URL, AbortController };
  vm.runInNewContext(source, sandbox, { filename: 'reach-public.js' });
  const controller = window.signalReachPublic.controller;
  const context = { elements: { settingsContainer: container } };
  controller.mount(context);
  controller.activate(context);
  const prefs = () => JSON.parse(storage.get(PREFS_KEY) || '{}');
  return { container, controller, context, window, legacyController, calls, storage, reads, registrations, prefs };
}

async function saveConnection(ui, { url = 'https://models.example.test/v1/', key = 'synthetic-user-key', name = 'My provider' } = {}) {
  control(ui.container, 'Connection name').value = name;
  control(ui.container, 'Base URL').value = url;
  control(ui.container, 'Your API key').value = key;
  await button(ui.container, 'Save connection').click();
}

function connectionPreferences(extra = {}) {
  return { endpointId: 'my-endpoint', name: 'My provider', baseUrl: 'https://models.example.test/v1',
    model: 'alpha', defaults: { alpha: { temperature: 0.7, maxOutputTokens: 1024 } }, ...extra };
}

test('empty install, mount, activation, navigation and unmount make zero network calls', () => {
  const ui = mount();
  assert.equal(control(ui.container, 'Base URL').value, '');
  assert.equal(control(ui.container, 'Your API key').value, '');
  assert.equal(control(ui.container, 'Default model').value, '');
  assert.equal(button(ui.container, 'Refresh models').disabled, true);
  button(ui.container, 'Playground').click();
  assert.equal(button(ui.container, 'Send prompt').disabled, true);
  button(ui.container, 'Settings').click();
  ui.controller.deactivate();
  ui.controller.activate(ui.context);
  ui.controller.unmount();
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.storage.has(PREFS_KEY), false, 'empty lifecycle does not create a provider preference');
});

test('public edition has its own registration and never inherits admin globals or legacy preferences', () => {
  const ownerPreferences = JSON.stringify({ endpointId: 'owner-account', api_key: 'synthetic-owner-key',
    baseUrl: 'https://owner.example.test/v1', model: 'owner-paid-model' });
  const ui = mount({ stored: { 'signal-reach.preferences.v1': ownerPreferences,
    'reach.preferences': ownerPreferences,
    ragworkspace_plugins: JSON.stringify([{ id: 'signal-reach', ownerToken: 'synthetic-owner-token' }]) } });
  assert.equal(ui.window.signalReach, ui.legacyController);
  assert.equal(ui.window.signalReachPublic.pluginId, manifest.id);
  assert.equal(ui.registrations[0].pluginId, manifest.id);
  assert.deepEqual(ui.reads.filter(key => key !== PREFS_KEY && key !== 'ragworkspace_plugins'), []);
  assert.equal(control(ui.container, 'Base URL').value, '');
  assert.equal(control(ui.container, 'Your API key').value, '');
  assert.equal(control(ui.container, 'Default model').value, '');
  assert.equal(ui.calls.length, 0);
  const records = JSON.parse(ui.storage.get('ragworkspace_plugins'));
  assert.equal(records[0].ownerToken, 'synthetic-owner-token', 'co-installed admin record stays unchanged');
  assert.equal(records[1].id, manifest.id);
});

test('explicit Save connection sends only the typed provider through SimpleRAG with probing disabled', async () => {
  const ui = mount({ respond: async () => ({ id: 'user-endpoint' }) });
  const keyInput = control(ui.container, 'Your API key');
  await saveConnection(ui, { name: '  My provider  ', key: '  synthetic-user-key  ' });
  assert.equal(ui.calls.length, 1);
  const call = ui.calls[0];
  assert.equal(call.url, API + '/model-endpoints');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.redirect, 'error');
  assert.deepEqual(call.body, { name: 'My provider', base_url: 'https://models.example.test/v1',
    api_key: 'synthetic-user-key', default_model: '', category: 'api',
    endpoint_kind: 'openai-compatible', model_type: 'llm', skip_probe: true });
  assert.equal(keyInput.value, '', 'the entered credential is cleared even on the detached old input');
  assert.equal(control(ui.container, 'Your API key').value, '');
  assert.equal(Array.from(ui.storage.values()).some(value => value.includes('synthetic-user-key')), false);
  assert.deepEqual(ui.prefs(), { endpointId: 'user-endpoint', name: 'My provider',
    baseUrl: 'https://models.example.test/v1', model: '', defaults: {} });
});

test('local connection is user-entered and saved without an API key or automatic discovery', async () => {
  const ui = mount({ respond: async () => ({ id: 'local-endpoint' }) });
  await saveConnection(ui, { url: 'http://127.0.0.1:18110/v1/', key: '' });
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].url, API + '/model-endpoints');
  assert.equal(ui.calls[0].body.base_url, 'http://127.0.0.1:18110/v1');
  assert.equal(ui.calls[0].body.category, 'local');
  assert.equal(ui.calls[0].body.api_key, '');
  assert.equal(ui.calls[0].body.skip_probe, true);
});

test('unsafe URLs and URL-embedded secrets are rejected before any network call', async () => {
  for (const url of ['https://user:secret@models.example.test/v1', 'https://models.example.test/v1?key=secret',
    'https://models.example.test/v1#secret', 'http://models.example.test/v1',
    'file:///C:/private', 'javascript:alert(1)', 'ftp://models.example.test/v1', 'not a URL']) {
    const ui = mount();
    await saveConnection(ui, { url });
    assert.equal(ui.calls.length, 0, url);
    assert.ok(ui.container.querySelector('[data-status]').textContent, 'validation error is visible');
    assert.equal(ui.storage.has(PREFS_KEY), false, 'invalid URLs are not persisted');
  }
});

test('model refresh supplies dropdown choices and saves only the selected default to that connection', async () => {
  const ui = mount({ stored: { [PREFS_KEY]: JSON.stringify(connectionPreferences()) },
    respond: async call => call.options.method === 'POST' ? { saved: true }
      : { chat_models: ['beta', 'alpha', 'beta', '', null, 42], models: ['embedding-only'] } });
  assert.equal(ui.calls.length, 0, 'saved connections still require an explicit refresh');
  await button(ui.container, 'Refresh models').click();
  assert.equal(ui.calls[0].url, API + '/model-endpoints/my-endpoint/models?refresh=true');
  assert.equal(ui.calls[0].body, undefined);
  const defaultModel = control(ui.container, 'Default model');
  assert.deepEqual(defaultModel.children.map(option => option.value), ['', 'alpha', 'beta']);
  defaultModel.value = 'beta';
  defaultModel.dispatch('change');
  const modelDetails = descendants(ui.container).filter(node => node.tagName === 'DETAILS'
    && node.children[0]?.textContent === 'beta · default')[0];
  assert.ok(modelDetails);
  assert.equal(modelDetails.open, false, 'model defaults are compact dropdowns');
  const temperature = control(modelDetails, 'Temperature');
  const length = control(modelDetails, 'Output length');
  assert.equal(temperature.tagName, 'SELECT');
  assert.equal(length.tagName, 'SELECT');
  temperature.value = '0.3';
  temperature.dispatch('change');
  length.value = '2048';
  length.dispatch('change');
  await button(ui.container, 'Save model settings').click();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[1].url, API + '/model-endpoints/my-endpoint');
  assert.deepEqual(ui.calls[1].body, { default_model: 'beta' });
  assert.deepEqual(ui.prefs().defaults.beta, { temperature: 0.3, maxOutputTokens: 2048 });
  assert.equal(ui.prefs().model, 'beta');
});

test('switching to another saved endpoint clears the preceding connection model and tuning', async () => {
  const stored = { [PREFS_KEY]: JSON.stringify(connectionPreferences({ defaults: {
    alpha: { temperature: 0.3, maxOutputTokens: 2048, api_key: 'ignored-old-secret' }
  } })) };
  const ui = mount({ stored, respond: async () => ({ id: 'another-endpoint' }) });
  await saveConnection(ui, { url: 'https://another.example.test/v1', key: 'new-user-secret' });
  assert.equal(ui.prefs().endpointId, 'another-endpoint');
  assert.equal(ui.prefs().model, '');
  assert.deepEqual(ui.prefs().defaults, {});
  assert.deepEqual(control(ui.container, 'Default model').children.map(option => option.value), ['']);
  assert.equal(button(ui.container, 'Refresh models').disabled, false);
  assert.equal(ui.storage.get(PREFS_KEY).includes('secret'), false);
});

test('saving the same connection preserves its selected model and non-preset tuning', async () => {
  const stored = { [PREFS_KEY]: JSON.stringify(connectionPreferences({ defaults: {
    alpha: { temperature: 0.45, maxOutputTokens: 1500, api_key: 'ignored-old-secret' }
  } })) };
  const ui = mount({ stored, respond: async () => ({ id: 'my-endpoint' }) });
  await saveConnection(ui, { key: '' });
  assert.equal(ui.prefs().model, 'alpha');
  assert.deepEqual(ui.prefs().defaults.alpha, { temperature: 0.45, maxOutputTokens: 1500 });
  assert.equal(control(ui.container, 'Temperature').value, '0.45');
  assert.equal(control(ui.container, 'Output length').value, '1500');
  assert.equal(ui.storage.get(PREFS_KEY).includes('ignored-old-secret'), false, 'defaults serialization removes unknown keys');
});

test('Playground sends only the configured endpoint, model and tuning without workspace or web context', async () => {
  const ui = mount({ stored: { [PREFS_KEY]: JSON.stringify(connectionPreferences({ defaults: {
    alpha: { temperature: 0.3, maxOutputTokens: 2048 }
  } })) }, respond: async () => ({ response: 'Provider response' }) });
  button(ui.container, 'Playground').click();
  control(ui.container, 'Prompt').value = '  Hello, my model  ';
  await button(ui.container, 'Send prompt').click();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].url, API + '/chat');
  assert.deepEqual(ui.calls[0].body, { message: 'Hello, my model', endpoint_id: 'my-endpoint',
    model: 'alpha', temperature: 0.3, max_output_tokens: 2048, context: '',
    use_workspace_context: false, use_web_search: false, use_web_search_loop: false, embedding_enabled: false });
  assert.ok(ui.calls[0].options.signal instanceof AbortSignal);
  assert.equal(ui.container.querySelector('.sr-public-output').textContent, 'Provider response');
  assert.equal(button(ui.container, 'Stop waiting').disabled, true);
});

test('corrupt preferences recover locally without requests, including malformed model defaults', () => {
  const invalid = ['{invalid', 'null', '17', '[]', JSON.stringify({ defaults: null }),
    JSON.stringify(connectionPreferences({ defaults: [] })),
    JSON.stringify(connectionPreferences({ defaults: { alpha: null } })),
    JSON.stringify(connectionPreferences({ defaults: { alpha: 'invalid' } })),
    JSON.stringify(connectionPreferences({ defaults: { alpha: [] } })),
    JSON.stringify(connectionPreferences({ defaults: { alpha: { temperature: 'secret', maxOutputTokens: -3 } } })),
    JSON.stringify(connectionPreferences({ defaults: { alpha: { temperature: -1, maxOutputTokens: 0 } } })),
    JSON.stringify(connectionPreferences({ defaults: { alpha: { temperature: 3, maxOutputTokens: 32769 } } })),
    JSON.stringify(connectionPreferences({ defaults: { alpha: { temperature: {}, maxOutputTokens: 1.5 } } }))];
  for (const preferences of invalid) {
    const ui = mount({ stored: { [PREFS_KEY]: preferences, ragworkspace_plugins: '{invalid' } });
    assert.equal(ui.calls.length, 0, preferences);
    assert.equal(ui.storage.get('ragworkspace_plugins'), '{invalid', 'corrupt host records are preserved');
    const temperature = descendants(ui.container).find(node => node.tagName === 'LABEL'
      && node.children[0]?.textContent === 'Temperature')?.children[1];
    if (temperature) {
      assert.ok(Number.isFinite(Number(temperature.value)) && Number(temperature.value) >= 0 && Number(temperature.value) <= 2,
        'corrupt temperature recovers to a valid default');
      const tokenLimit = Number(control(ui.container, 'Output length').value);
      assert.ok(Number.isInteger(tokenLimit) && tokenLimit > 0 && tokenLimit <= 32768, 'corrupt token limit recovers');
    }
  }
});

test('provider error responses cannot expose the credential in the status or saved preferences', async () => {
  const ui = mount({ respond: async () => ({ ok: false, status: 401,
    data: { error: 'request failed using synthetic-user-key' } }) });
  await saveConnection(ui);
  assert.equal(ui.calls.length, 1);
  assert.match(ui.container.querySelector('[data-status]').textContent, /HTTP 401/);
  assert.equal(ui.container.querySelector('[data-status]').textContent.includes('synthetic-user-key'), false);
  assert.equal(Array.from(ui.storage.values()).some(value => value.includes('synthetic-user-key')), false);
});
