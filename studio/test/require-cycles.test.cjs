'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function topLevelGraph(dir) {
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.cjs'));
  const graph = new Map();
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const edges = [];
    for (const line of source.split('\n')) {
      // All engine top-level requires use unindented const declarations.
      if (/^\s/.test(line) || /^\s*\/\//.test(line)) continue;
      for (const match of line.matchAll(/require\(['"]\.\/([\w.-]+\.cjs)['"]\)/g)) edges.push(match[1]);
    }
    graph.set(file, edges);
  }
  return graph;
}

function cycles(graph) {
  const seen = new Set(), active = new Set(), found = [];
  const visit = (node, stack = []) => {
    if (active.has(node)) { found.push([...stack, node]); return; }
    if (seen.has(node)) return;
    seen.add(node); active.add(node);
    for (const next of graph.get(node) || []) if (graph.has(next)) visit(next, [...stack, node]);
    active.delete(node);
  };
  for (const node of graph.keys()) visit(node);
  return found;
}

test('engine has no all-top-level require cycle', () => {
  assert.deepEqual(cycles(topLevelGraph(path.join(__dirname, '..', 'agent'))), []);
  assert.equal(cycles(new Map([['a', ['b']], ['b', ['a']]])).length, 1, 'fixture proves the graph test detects a cycle');
});
