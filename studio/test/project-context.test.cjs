'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { identifyProject } = require('../agent/project-context.cjs');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('project identity reads branding evidence and never carries it to a different project', t => {
  const rag = project(t), other = project(t);
  fs.writeFileSync(path.join(rag, 'README.md'), '# SimpleRAG — Offline-First RAG Desktop Workspace\n');
  fs.writeFileSync(path.join(rag, 'pyproject.toml'), '[project]\nname = "RAGWorkspace"\n');
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other-project', productName: 'Other App' }));
  const first = identifyProject(rag), second = identifyProject(other);
  assert.match(first.name, /^SimpleRAG/);
  assert.ok(first.evidence.some(item => item.path === 'pyproject.toml' && item.value === 'RAGWorkspace'));
  assert.equal(second.name, 'Other App');
  assert.equal(second.root, path.resolve(other));
  assert.doesNotMatch(JSON.stringify(second), /SimpleRAG|RAGWorkspace/);
});

test('missing, invalid, and oversized metadata leave a usable folder identity', t => {
  const root = project(t);
  fs.writeFileSync(path.join(root, 'package.json'), '{ invalid json');
  fs.writeFileSync(path.join(root, 'README.md'), '# Unusable oversized metadata\n' + 'x'.repeat(70 * 1024));
  const identity = identifyProject(root);
  assert.equal(identity.name, path.basename(root));
  assert.deepEqual(identity.evidence, []);
  assert.doesNotThrow(() => identifyProject(path.join(root, 'missing')));
});

test('Python-only projects can use their declared project name', t => {
  const root = project(t);
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[build-system]\nrequires = []\n[project]\nname = "my-python-project"\n');
  const identity = identifyProject(root);
  assert.equal(identity.name, 'my-python-project');
  assert.equal(identity.evidence[0].field, 'project.name');
});
