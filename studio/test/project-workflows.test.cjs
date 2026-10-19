'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { templates, buildPrompt, mount } = require('../renderer/project-workflows.js');

// Minimal DOM surface: exercise form dispatch and state changes without an
// Electron process or any provider calls. Native rendering has a separate test.
function fixture(onStart = async () => {}) {
  const doc = { createElement(tag) {
    return { tag, ownerDocument: doc, children: [], attributes: {}, dataset: {}, value: '', listeners: {},
      append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
    };
  } };
  const host = doc.createElement('section');
  let project = { name: 'Same name', dir: '/project/one' };
  const controller = mount(host, { getProject: () => project, onStart });
  const all = root => [root, ...root.children.flatMap(all)];
  const find = predicate => all(host).find(predicate);
  const requirements = find(item => item.tag === 'textarea');
  const start = find(item => item.type === 'submit');
  return {
    requirements, start, status: find(item => item.attributes.role === 'status'),
    choose: id => find(item => item.dataset?.workflow === id).onclick(),
    submit: () => find(item => item.tag === 'form').onsubmit({ preventDefault() {} }),
    project: next => { project = next; controller.sync(); },
    type: text => { requirements.value = text; requirements.listeners.input(); },
  };
}

test('workflow dispatch keeps the exact selected path and user requirements', () => {
  const project = { dir: 'D:\\Projects\\a "quoted" app\nAnother heading' };
  const prompt = buildPrompt('security', project, 'Check the private uploads.');
  assert.ok(prompt.includes(JSON.stringify(project.dir)));
  assert.ok(prompt.endsWith('Check the private uploads.'));
  assert.throws(() => buildPrompt('unknown', project), /Choose a project/);
  assert.throws(() => buildPrompt('security', { dir: '' }), /Select a project/);
});

test('each template dispatches its own task, not a hard-coded security request', async () => {
  const dispatched = [];
  const f = fixture(async task => dispatched.push(task));
  for (const template of templates) { f.choose(template.id); await f.submit(); }
  assert.deepEqual(dispatched.map(item => item.template.id), ['security', 'hardening', 'migration', 'access']);
  for (const task of dispatched) {
    assert.equal(task.project.dir, '/project/one');
    assert.ok(task.prompt.startsWith(`Project workflow: ${task.template.title}`));
  }
});

test('requirements survive template and same-name project switches without leaking', () => {
  const f = fixture();
  f.type('Review private files.');
  f.choose('migration'); assert.equal(f.requirements.value, '');
  f.type('Use our existing cloud account.');
  f.project({ name: 'Same name', dir: '/project/two' });
  assert.equal(f.requirements.value, '');
  f.type('Second project requirements.');
  f.project({ name: 'Same name', dir: '/project/one' });
  assert.equal(f.requirements.value, 'Use our existing cloud account.');
  f.choose('security'); assert.equal(f.requirements.value, 'Review private files.');
});

test('double submit cannot create duplicate runs; rejection leaves a retryable brief', async () => {
  let reject, calls = 0;
  const f = fixture(() => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); });
  f.type('Keep this brief after failure.');
  const pending = f.submit();
  assert.equal(f.start.disabled, true);
  await f.submit(); assert.equal(calls, 1);
  reject(new Error('Provider is not configured.')); await pending;
  assert.equal(f.start.disabled, false);
  assert.equal(f.requirements.value, 'Keep this brief after failure.');
  assert.equal(f.status.textContent, 'Provider is not configured.');
});

test('an unselected project cannot start a workflow', async () => {
  let calls = 0;
  const f = fixture(async () => calls++);
  f.project(null); await f.submit();
  assert.equal(calls, 0); assert.equal(f.start.disabled, true);
});
