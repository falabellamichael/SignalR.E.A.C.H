'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/pages-settings.js'), 'utf8');

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.handlers = {};
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.open = false;
    this.classList = { add() {}, remove() {} };
  }
  appendChild(node) {
    if (node.parentElement) {
      const previous = node.parentElement.children;
      previous.splice(previous.indexOf(node), 1);
    }
    this.children.push(node);
    node.parentElement = this;
    return node;
  }
  set innerHTML(value) { this.children = []; this.html = value; }
  set value(value) { this.inputValue = String(value); }
  get value() {
    if (this.tagName === 'SELECT') {
      return (this.children.find(node => node.selected) || this.children[0])?.value || '';
    }
    return this.inputValue || '';
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  dispatch(name) { this.handlers[name]?.({ preventDefault() {} }); }
  scrollIntoView() { this.wasOpenWhenScrolled = this.open; }
}

function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

function field(root, label) {
  const wrap = descendants(root).find(node => node.tagName === 'LABEL'
    && node.children[0]?.textContent === label);
  assert.ok(wrap, 'field exists: ' + label);
  return wrap.children[1];
}

async function renderer(editAlias = '') {
  const container = new Element('main');
  const saved = [];
  const prefs = { 'model-edit': editAlias };
  const model = {
    upstream: 'user/model-alpha', description: 'My model', public: true, enabled: true,
    fallback: null, context_window: 32768, temperature: 0.7, max_tokens: 2048,
    rate_limits: { rpm: 5, tokens_day: 10000 }, allow_stream: true, allow_tools: false,
  };
  const cfg = {
    models: { alpha: model, beta: { ...model, upstream: 'user/model-beta', fallback: 'alpha' } },
    request: { default_model: 'beta', blocked_fields: [] }, rate_limits: {},
    access: { access_key: 'set (masked)', keys: [] }, cache: {}, data: {},
    publish: {}, system: {}, omniroute_key: 'set (masked)',
  };
  const el = (tag, className, textContent) => {
    const node = new Element(tag);
    node.className = className || '';
    node.textContent = textContent || '';
    return node;
  };
  const core = {
    el, esc: value => value, toast() {}, store: {},
    loadSettings: async () => cfg,
    saveSettings: async patch => { saved.push(patch); return { ok: true, data: {} }; },
    refreshLocal: async () => ({}),
    prefsGet: name => prefs[name], prefsSet: (name, value) => { prefs[name] = value; },
  };
  const window = {
    __reachCore: core,
    __reachPageRegistry: {},
    __reachPageWidgets: { pageHeader: () => el('header'), emptyNote: text => el('p', '', text) },
  };
  const document = {
    createElement: tag => new Element(tag), createTextNode: text => el('#text', '', text),
    getElementById: id => descendants(container).find(node => node.id === id),
  };
  vm.runInNewContext(source, { window, document, setTimeout() {} }, { filename: 'pages-settings.js' });
  window.__reachPageRegistry.settings(container);
  await new Promise(resolve => setImmediate(resolve));
  return { container, saved, prefs, core, cfg, document };
}

test('model editors start collapsed, keeping the default-model and fallback dropdowns', async () => {
  const { container, document, core } = await renderer();
  for (const alias of ['alpha', 'beta']) {
    const card = document.getElementById('reach-model-' + alias);
    assert.equal(card.tagName, 'DETAILS');
    assert.equal(card.open, false);
    assert.equal(card.children[0].tagName, 'SUMMARY');
    assert.equal(descendants(card.children[0]).some(node => ['INPUT', 'BUTTON', 'SELECT'].includes(node.tagName)), false,
      'editing controls belong in the expanded body');
  }
  const defaultModel = field(container, 'Default model');
  assert.equal(defaultModel.tagName, 'SELECT');
  assert.equal(defaultModel.value, 'beta');
  assert.equal(field(document.getElementById('reach-model-beta'), 'Fallback alias').value, 'alpha');
  assert.equal(core.store.dirty, false, 'collapsing the editors does not change settings');
});

test('expanded model edits survive closing and save with the original values of other aliases', async () => {
  const { container, document, saved, cfg, core } = await renderer();
  const card = document.getElementById('reach-model-alpha');
  card.open = true;
  const temperature = field(card, 'Default temperature');
  temperature.value = '0.25';
  temperature.dispatch('input');
  const enabled = descendants(card).find(node => node.attributes['aria-label'] === 'alpha: enabled');
  enabled.checked = false;
  enabled.dispatch('change');
  card.open = false;
  card.open = true;
  assert.equal(temperature.value, '0.25');
  assert.equal(core.store.dirty, true);
  const save = descendants(container).find(node => node.tagName === 'BUTTON' && node.textContent === 'Save settings');
  save.dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].models.alpha.temperature, 0.25);
  assert.equal(saved[0].models.alpha.enabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0].models.beta)), cfg.models.beta);
  assert.equal(saved[0].request.default_model, 'beta');
  assert.equal(saved[0].models.alpha.rate_limits.tokens_day, 10000);
  assert.equal(saved[0].omniroute_key, undefined, 'existing masked-key save behavior remains');
  assert.equal(core.store.dirty, false);
});

test('Models-page editing opens only the requested alias before scrolling', async () => {
  const { document, prefs } = await renderer('beta');
  const target = document.getElementById('reach-model-beta');
  assert.equal(target.open, true);
  assert.equal(target.wasOpenWhenScrolled, true);
  assert.equal(document.getElementById('reach-model-alpha').open, false);
  assert.equal(prefs['model-edit'], '', 'the navigation preference is consumed once');
});
