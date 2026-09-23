'use strict';

/* Reach Studio — plan item E3: tool results are actually bounded.
 *
 * agent-tool-runner.cjs used to truncate only TOP-LEVEL STRING fields, each to
 * half the budget. A top-level array or object was never touched — so `list` on
 * a big directory, `search` with many matches, `code.index` output and the
 * `tests.run` gate array could be arbitrarily large — and a result with ten
 * string fields could occupy ~5x its budget. These tests pin the replacement:
 * one total budget for the whole structure. The persisted tool record keeps
 * only provenance; the loop stores the full bounded body once in tool-summary.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { boundResult, sizeOf } = require('../agent/bounded-result.cjs');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');
const { TOOLS, budgetFor } = require('../agent/tool-registry.cjs');

const BIG_ARRAY = () => Array.from({ length: 200000 }, (_, i) => ({ path: `file-${i}.py`, line: i, text: 'x'.repeat(40) }));

test('a 10 MB array result is bounded to the budget with an explicit elision marker', () => {
  const huge = BIG_ARRAY();
  assert.ok(sizeOf(huge) > 10 * 1024 * 1024, 'the fixture really is about 10 MB');

  const bounded = boundResult(huge, { budget: 8000 });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.bytes <= 8000, `bounded bytes ${bounded.bytes} must fit the budget`);
  assert.ok(bounded.elided.total > 0, 'the marker reports how much was dropped');

  // The elision names the scale rather than silently shrinking the array: a
  // model must be able to tell "3 items" from "30,000 items".
  const marker = bounded.value.at(-1);
  assert.match(marker, /^\[\+\d[\d,]* more items elided\]$/);
  assert.ok(bounded.value.length < huge.length);
});

test('a result with many string fields cannot exceed its budget in aggregate', () => {
  const wide = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`field${i}`, 'y'.repeat(20000)]));
  assert.ok(sizeOf(wide) > 190000);
  const bounded = boundResult(wide, { budget: 6000 });
  assert.ok(bounded.bytes <= 6000, `ten fields must share ONE budget, got ${bounded.bytes}`);
  // Every field survives (as a bounded string) — the fix halves nothing per key.
  assert.equal(Object.keys(bounded.value).filter(k => k.startsWith('field')).length, 10);
});

test('errors are never elided', () => {
  const failed = { ok: false, error: 'E'.repeat(50000), output: 'z'.repeat(50000) };
  const bounded = boundResult(failed, { budget: 4000 });
  assert.equal(bounded.value.error, failed.error, 'the reason a tool failed is preserved in full');
  assert.ok(bounded.bytes <= 4000 || bounded.value._bounded, 'and the rest is still bounded');
});

test('a result within budget is returned untouched', () => {
  const small = { ok: true, path: 'index.rsh', content: 'export const main = Reach.App(() => {});' };
  const bounded = boundResult(small, { budget: 40000 });
  assert.equal(bounded.truncated, false);
  assert.deepEqual(bounded.value, small);
});

test('the returned result is bounded and the persisted tool record is a small provenance stub', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-bounded-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A real store is not needed: the runner only calls appendMessage.
  const messages = [];
  const store = {
    get: () => ({ settings: {}, todos: [], pendingEdits: {} }),
    appendMessage: (_id, message) => { messages.push(message); return null; },
  };

  // `list` is a real registry tool; stub its executor so the test needs no disk
  // walk and can hand back the 10 MB shape deterministically.
  const original = TOOLS.list.execute;
  TOOLS.list.execute = async () => ({ ok: true, entries: BIG_ARRAY() });
  t.after(() => { TOOLS.list.execute = original; });

  // The runner bounds to the tool's OWN registry budget, not a fixed number:
  // `list` is 40000, so asserting 4000 here would test nothing about the code.
  const budget = budgetFor('list');
  const result = await runToolCall('agent-1', 'list', { path: '.' }, {
    projectDir: dir, agentStore: store, getSettings: () => ({}),
  });

  assert.equal(result.ok, true);
  assert.ok(sizeOf(result) <= budget + 2000, `returned object must be bounded, got ${sizeOf(result)}`);
  const toolMessage = messages.find(m => m.role === 'tool');
  assert.ok(toolMessage, 'the tool message was persisted');
  assert.ok(sizeOf(toolMessage) < 1000, `provenance must stay small, got ${sizeOf(toolMessage)}`);
  assert.match(toolMessage.content, /resultSha256/);
  assert.doesNotMatch(toolMessage.content, /more items elided/);
  // The 10 MB input is what makes the bound meaningful: without it this would
  // pass on a result that was never bounded at all.
  assert.ok(sizeOf({ ok: true, entries: BIG_ARRAY() }) > 10 * 1024 * 1024);
});
