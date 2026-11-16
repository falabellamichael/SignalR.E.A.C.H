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

function mount({ stored = {}, respond = async () => ({}), page = 'settings', native = false } = {}) {
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
  const context = { state: {}, elements: { settingsContainer: container } };
  if (native) Object.assign(context.elements, { navTitle: new Element('h2'), navFolderList: new Element('div'),
    listTitle: new Element('h2'), listContent: new Element('div') });
  controller.mount(context);
  controller.activate(context);
  if (page !== 'dashboard') controller.onFolderChanged(context, page);
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
    baseUrl: 'https://models.example.test/v1', model: '', defaults: {},
    statistics: { endpointId:'',comparisonId:'',model:'',days:30,cadPerUsd:'',rates:{} } });
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

test('the public extension opens Usage with three direct views and legacy routes resolve to consolidated controls', () => {
  const ui = mount({ page: 'dashboard', native: true });
  const elements = ui.context.elements;
  assert.equal(ui.container.querySelector('h1').textContent, 'Usage');
  assert.equal(elements.navTitle.textContent, 'SignalREACH');
  assert.equal(elements.listTitle.textContent, 'At a glance');
  assert.equal(descendants(elements.navFolderList).filter(node => node.tagName === 'BUTTON').length, 3);
  assert.match(elements.listContent.textContent, /Setup needed/);
  for (const page of ['Usage', 'Playground', 'Settings']) {
    button(elements.navFolderList, page).click();
    assert.equal(ui.container.querySelector('h1').textContent, page);
    assert.equal(ui.context.state.folder, page.toLowerCase());
    assert.equal(button(elements.navFolderList, page).attributes['aria-current'], 'page');
  }
  assert.equal(ui.calls.length, 0, 'navigation does not probe a provider or operator service');
  assert.doesNotMatch(elements.listContent.textContent, /Restart|Start Endpoint|Relay Settings/);
  ui.controller.onFolderChanged(ui.context, 'dashboard');
  assert.equal(ui.container.querySelector('h1').textContent, 'Usage');
  ui.context.state.folder = 'models';
  ui.controller.renderPage(ui.context);
  assert.equal(ui.container.querySelector('h1').textContent, 'Settings');
  assert.equal(descendants(elements.listContent).filter(node=>node.tagName==='BUTTON').length,0,'sidebar is a summary, not a second navigation layer');
});

test('activating the public extension replaces the previous app main pane', () => {
  const ui = mount({ page: 'dashboard', native: true });
  ui.controller.deactivate();
  const otherPage = new Element('section');
  otherPage.textContent = 'Another app main pane';
  ui.container.replaceChildren(otherPage);
  ui.controller.activate(ui.context);
  assert.equal(ui.container.children.length, 1);
  assert.equal(ui.container.querySelector('h1').textContent, 'Usage');
  assert.doesNotMatch(ui.container.textContent, /Another app main pane/);
});

test('shared settings and sync are folded into Settings instead of a separate launcher page', () => {
  const ui = mount({ page: 'dashboard', native: true });
  button(ui.context.elements.navFolderList, 'Settings').click();
  const sync = descendants(ui.container).find(node => node.tagName === 'IFRAME');
  assert.equal(sync.src, 'http://127.0.0.1:21309/sync');
  assert.equal(sync.title, 'Sync Studio and VS Code settings');
  assert.equal(ui.container.querySelector('h1').textContent, 'Settings');
  assert.equal(ui.context.state.folder, 'settings');
  const link = descendants(ui.container).find(node => node.tagName === 'A');
  assert.equal(link.href, 'http://127.0.0.1:21309/');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.match(ui.container.textContent, /Studio.*VS Code/);
  assert.equal(ui.calls.length, 0, 'the parent page does not read or write hub or host settings');
  button(ui.context.elements.navFolderList, 'Usage').click();
  assert.equal(ui.container.querySelector('h1').textContent, 'Usage');
  assert.equal(ui.context.elements.listContent.querySelector('iframe'),null);
});

test('saved connections are loaded explicitly and only the chosen connection metadata is retained', async () => {
  const ui = mount({ native: true, respond: async () => [
    { id: 'chosen', name: 'My saved REACH', base_url: 'https://models.example.test/v1',
      default_model: 'beta', chat_models: ['alpha', 'beta'], api_key: 'must-not-be-copied', is_enabled: true },
    { id: 'disabled', name: 'Disabled', base_url: 'https://disabled.example.test', is_enabled: false },
    { id: 'unsafe', name: 'Unsafe', base_url: 'https://user:secret@example.test' }
  ] });
  assert.equal(ui.calls.length, 0);
  await button(ui.container, 'Load saved connections').click();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].url, API + '/model-endpoints');
  assert.equal(ui.calls[0].body, undefined);
  assert.equal(ui.prefs().endpointId, undefined, 'loading is not selection');
  const choices = control(ui.container, 'Saved connection');
  assert.deepEqual(choices.children.map(item => item.value), ['', 'chosen']);
  choices.value = 'chosen';
  button(ui.container, 'Use connection').click();
  assert.equal(ui.container.querySelector('h1').textContent, 'Settings');
  assert.equal(ui.prefs().endpointId, 'chosen');
  assert.equal(ui.prefs().model, 'beta');
  assert.equal(ui.calls.length, 1, 'selection does not overwrite the saved endpoint or its key');
  assert.equal(Array.from(ui.storage.values()).some(value => value.includes('must-not-be-copied')), false);
  assert.match(ui.context.elements.listContent.textContent, /My saved REACH/);
  assert.match(ui.context.elements.listContent.textContent, /beta/);
});

test('Playground draft and response survive navigation and session activity contains metadata only', async () => {
  const ui = mount({ page: 'playground', stored: { [PREFS_KEY]: JSON.stringify(connectionPreferences()) },
    respond: async () => ({ response: 'Private model answer' }) });
  control(ui.container, 'Prompt').value = 'Private prompt text';
  control(ui.container, 'Prompt').dispatch('input');
  button(ui.container, 'Usage').click();
  button(ui.container, 'Playground').click();
  assert.equal(control(ui.container, 'Prompt').value, 'Private prompt text');
  await button(ui.container, 'Send prompt').click();
  assert.match(ui.container.querySelector('.sr-public-log-row').textContent, /alphaCompleted/,
    'activity updates on the current Playground without navigating away');
  button(ui.container, 'Usage').click();
  assert.match(ui.container.textContent, /REACH account totals/);
  assert.doesNotMatch(ui.container.textContent,/Completed prompts1/,'session prompt counts are not account-wide statistics');
  button(ui.container, 'Playground').click();
  assert.match(ui.container.textContent, /alphaCompleted/);
  assert.doesNotMatch(ui.container.querySelector('.sr-public-log-row').textContent, /Private prompt text|Private model answer/);
  button(ui.container, 'Playground').click();
  assert.equal(ui.container.querySelector('.sr-public-output').textContent, 'Private model answer');
});

test('a late public Playground completion cannot replace another extension sidebar', async () => {
  let finish;
  const ui = mount({ page: 'playground', native: true,
    stored: { [PREFS_KEY]: JSON.stringify(connectionPreferences()) },
    respond: () => new Promise(resolve => { finish = resolve; }) });
  control(ui.container, 'Prompt').value = 'Test';
  const sending = button(ui.container, 'Send prompt').click();
  ui.controller.deactivate();
  assert.equal(ui.calls[0].options.signal.aborted, true);
  ui.context.elements.listContent.textContent = 'Other extension content';
  finish({ response: 'Late response' });
  await sending;
  assert.equal(ui.context.elements.listContent.textContent, 'Other extension content');
  ui.controller.activate(ui.context);
  assert.equal(ui.container.querySelector('.sr-public-output').textContent, '');
});

function statisticsFixture(change={}) {
  return { period:{from:'2026-10-15T00:00:00.000Z',to:'2026-11-14T00:00:00.000Z',basis:'recorded_at'},
    requests:{completed:200,pending:1,released:2,measured:200},tokens:{input:2000000,output:1000000,cachedInput:500000},
    spending:{subscriptions:[{currency:'CAD',paidMicros:25000000,refundedMicros:0,netMicros:25000000}],creditUsdMicros:2000000,rchUsdMicros:1500000,unpricedCreditTokens:0},
    redemptions:{creditUsdMicros:5000000,tokenCredits:0,rchWei:'1000000000000000000'},
    models:[{model:'reach-model',requests:200,measured:200,inputTokens:2000000,outputTokens:1000000,cachedInputTokens:500000}],...change };
}
const statisticsConnections=[{id:'reach',name:'My REACH',base_url:'https://reach.example/v1',default_model:'reach-model',chat_models:['reach-model'],api_key:'never-render-this-key'},
  {id:'api-a',name:'Configured API A',base_url:'https://api-a.example/v1',default_model:'model-a',chat_models:['model-a','model-b']},
  {id:'api-b',name:'Configured API B',base_url:'https://api-b.example/v1',default_model:'model-c',chat_models:['model-c']}];
async function statisticsUI(report=statisticsFixture()) {
  const ui=mount({page:'usage',stored:{[PREFS_KEY]:JSON.stringify(connectionPreferences({endpointId:'reach'}))},
    respond:async call=>call.url===API+'/model-endpoints'?statisticsConnections:report});
  await button(ui.container,'Refresh statistics').click();
  return ui;
}
function chooseComparison(ui) {
  const provider=control(ui.container,'Compare with API');provider.value='api-a';provider.dispatch('change');
}
function setField(ui,label,value) {const field=control(ui.container,label);field.value=value;field.dispatch('input');}

test('Usage reads the chosen account and offers only configured comparison APIs without changing the active model',async()=>{
  const ui=await statisticsUI();
  assert.deepEqual(ui.calls.map(c=>c.url),[API+'/model-endpoints',API+'/model-endpoints/reach/reach-usage?days=30']);
  assert.deepEqual(control(ui.container,'Compare with API').children.map(c=>c.value),['','api-a','api-b']);
  chooseComparison(ui);
  assert.deepEqual(control(ui.container,'Comparison model').children.map(c=>c.value),['','model-a','model-b']);
  assert.equal(ui.prefs().endpointId,'reach');assert.equal(ui.prefs().model,'alpha');
  assert.doesNotMatch(ui.container.textContent,/never-render-this-key/);
  assert.doesNotMatch([...ui.storage.values()].join(''),/never-render-this-key/);
  assert.match(ui.container.textContent,/Crypto credit usedUSD\s*1\.50/);
  assert.match(ui.container.textContent,/Other credit usedUSD\s*0\.50/);
});

test('comparison requires explicit currency conversion, handles cached tokens, shows higher costs honestly, and retains model-specific rates',async()=>{
  const ui=await statisticsUI();chooseComparison(ui);
  setField(ui,'Input / 1M tokens','10');setField(ui,'Output / 1M tokens','20');setField(ui,'Cached input / 1M tokens','2');
  assert.match(ui.container.textContent,/Enter CAD per USD/);
  setField(ui,'CAD per USD','1.25');
  const result=ui.container.querySelector('.sr-public-comparison');
  assert.match(result.textContent,/REACH recorded costUSD\s*22\.00/);
  assert.match(result.textContent,/Selected API estimateUSD\s*36\.00/);
  assert.match(result.textContent,/DifferenceUSD\s*14\.00/);
  assert.match(ui.container.textContent,/REACH costs less/);
  setField(ui,'Output / 1M tokens','1');setField(ui,'Input / 1M tokens','1');setField(ui,'Cached input / 1M tokens','');
  assert.match(ui.container.textContent,/REACH costs more/);
  const model=control(ui.container,'Comparison model');model.value='model-b';model.dispatch('change');
  assert.equal(control(ui.container,'Input / 1M tokens').value,'');
  const back=control(ui.container,'Comparison model');back.value='model-a';back.dispatch('change');
  assert.equal(control(ui.container,'Input / 1M tokens').value,'1');
  setField(ui,'Input / 1M tokens','-1');assert.match(ui.container.textContent,/valid, non-negative decimal rates/);
  assert.doesNotMatch(ui.container.querySelector('.sr-public-comparison').textContent,/NaN|Infinity/);
});

test('missing measured usage and unpriced old credits do not become invented savings',async()=>{
  for(const report of [statisticsFixture({requests:{completed:200,pending:0,released:0,measured:199}}),
    statisticsFixture({spending:{...statisticsFixture().spending,unpricedCreditTokens:10}})]) {
    const ui=await statisticsUI(report);chooseComparison(ui);
    setField(ui,'Input / 1M tokens','10');setField(ui,'Output / 1M tokens','20');setField(ui,'CAD per USD','1.25');
    assert.match(ui.container.textContent,/full-period cost difference cannot be calculated/);
    assert.match(ui.container.querySelector('.sr-public-comparison').textContent,/Selected API estimate—Difference—/);
  }
});

test('failed or malformed summaries clear prior totals, and changing periods invalidates the previous report',async()=>{
  const ui=await statisticsUI({ok:false,status:404});
  assert.match(ui.container.textContent,/Statistics unavailable/);
  assert.match(ui.container.textContent,/Subscription payments · net—/);
  const invalid=await statisticsUI(statisticsFixture({tokens:{input:-1,output:0,cachedInput:0}}));
  assert.match(invalid.container.textContent,/Statistics unavailable/);
  const valid=await statisticsUI();const period=control(valid.container,'Reporting period');period.value='7';period.dispatch('change');
  assert.match(valid.container.textContent,/Subscription payments · net—/);
  await button(valid.container,'Refresh statistics').click();
  assert.equal(valid.calls.at(-1).url,API+'/model-endpoints/reach/reach-usage?days=7');
});

test('leaving Usage aborts refresh and a late response cannot replace Settings',async()=>{
  let finish;
  const ui=mount({page:'usage',stored:{[PREFS_KEY]:JSON.stringify(connectionPreferences({endpointId:'reach'}))},respond:async call=>call.url===API+'/model-endpoints'?statisticsConnections:new Promise(resolve=>{finish=resolve;})});
  const refresh=button(ui.container,'Refresh statistics').click();
  await new Promise(resolve=>setImmediate(resolve));
  button(ui.container,'Settings').click();
  assert.equal(ui.calls.at(-1).options.signal.aborted,true);
  finish(statisticsFixture());await refresh;
  assert.equal(ui.container.querySelector('h1').textContent,'Settings');
});
