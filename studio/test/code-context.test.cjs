'use strict';

/* Automatic codebase context injection (PRD, Codebase AST Context Search:
 * "Prompt requests automatically retrieve and inject top relevant symbol
 * definitions and dependency snippets into the prompt context buffer").
 *
 * The interesting failure mode is staleness: a conversation edits files as it
 * goes, and serving an index built before those edits would inject definitions
 * that no longer exist — actively worse than injecting nothing. So the
 * write-observer invalidation is tested here, not assumed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cc = require('../agent/code-context.cjs');
const { writeTextFile } = require('../agent/text-files.cjs');
const { resolveBudgets } = require('../agent/budgets.cjs');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codectx-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/math.ts'),
    'export function computeTotal(a: number, b: number): number { return a + b; }\n');
  fs.writeFileSync(path.join(dir, 'src/report.ts'),
    'export class SalesReport {\n  render(): string { return "report"; }\n}\n');
  return dir;
}

const userMsg = (text) => [{ role: 'user', content: text }];

test('builds a context block matching the prompt, with real source snippets', () => {
  const dir = project();
  const block = cc.buildCodeContext({ projectDir: dir, messages: userMsg('how does computeTotal work?') });
  assert.equal(block.skipped, false, block.reason);
  assert.match(block.text, /computeTotal/);
  assert.ok(block.chars > 0);
  assert.ok(block.symbols.some(s => s.name.includes('computeTotal')), JSON.stringify(block.symbols));
  // Snippets must carry the actual definition text, or the model learns nothing.
  assert.match(block.text, /return a \+ b/);
  assert.match(block.text, /src\/math\.ts/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an irrelevant prompt skips instead of injecting noise', () => {
  const dir = project();
  const block = cc.buildCodeContext({ projectDir: dir, messages: userMsg('hello, how are you today?') });
  assert.equal(block.skipped, true);
  assert.equal(block.text, '');
  assert.ok(block.reason, 'a skip always explains itself');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skip paths are all non-throwing and return empty text', () => {
  const dir = project();
  const cases = [
    ['no project', { messages: userMsg('computeTotal') }],
    ['no messages', { projectDir: dir }],
    ['empty messages', { projectDir: dir, messages: [] }],
    ['nonexistent project', { projectDir: path.join(dir, 'nope'), messages: userMsg('computeTotal') }],
  ];
  for (const [label, opts] of cases) {
    const block = cc.buildCodeContext(opts);
    assert.equal(block.skipped, true, label + ' should skip');
    assert.equal(block.text, '', label + ' must return empty text');
    assert.equal(typeof block.reason, 'string', label + ' must give a reason');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('injection is suppressed once the conversation is at the compaction trigger', () => {
  const dir = project();
  // Injecting source into a context that is about to be compressed wastes tokens
  // and accelerates the compression it is trying to avoid.
  const block = cc.buildCodeContext({
    projectDir: dir, messages: userMsg('computeTotal'),
    contextChars: 100000, contextTrigger: 96000,
  });
  assert.equal(block.skipped, true);
  assert.match(block.reason, /compression trigger/);
  // Below the trigger it injects normally.
  const ok = cc.buildCodeContext({ projectDir: dir, messages: userMsg('computeTotal'), contextChars: 1000, contextTrigger: 96000 });
  assert.equal(ok.skipped, false, ok.reason);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('character and symbol budgets are clamped, never trusted', () => {
  const dir = project();
  const huge = cc.buildCodeContext({ projectDir: dir, messages: userMsg('computeTotal'), maxChars: 10 ** 9, maxSymbols: 10 ** 6 });
  assert.equal(huge.skipped, false);
  assert.ok(huge.chars <= cc.MAX_CONTEXT_CHARS, 'chars clamped to ' + cc.MAX_CONTEXT_CHARS + ', got ' + huge.chars);
  assert.ok(huge.symbols.length <= cc.MAX_CONTEXT_SYMBOLS, 'symbols clamped to ' + cc.MAX_CONTEXT_SYMBOLS);
  const tiny = cc.buildCodeContext({ projectDir: dir, messages: userMsg('computeTotal'), maxChars: -5, maxSymbols: 0 });
  assert.equal(tiny.skipped, false, tiny.reason);
  assert.ok(tiny.chars <= cc.MAX_CONTEXT_CHARS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the query comes from the latest user message, not the whole history', () => {
  const messages = [
    { role: 'user', content: 'tell me about SalesReport' },
    { role: 'assistant', content: 'It renders a report.' },
    { role: 'user', content: 'now what does computeTotal do?' },
  ];
  assert.equal(cc.queryFromMessages(messages), 'now what does computeTotal do?');
  // A tool-result tail falls back to the last assistant text.
  const withTool = [...messages, { role: 'tool', content: '{"ok":true}' }];
  assert.equal(cc.queryFromMessages(withTool), 'now what does computeTotal do?');
  const onlyAssistant = [{ role: 'assistant', content: 'I will check the renderer.' }];
  assert.equal(cc.queryFromMessages(onlyAssistant), 'I will check the renderer.');
  assert.equal(cc.queryFromMessages([]), '');
});

test('a long query is bounded, and cut at a sentence boundary when that keeps most of the budget', () => {
  // Early boundary: cutting there would discard ~85% of the budget, so the full
  // (bounded) cut is kept instead of ending on the period.
  const earlyBoundary = 'First sentence about computeTotal. ' + 'x'.repeat(900);
  const kept = cc.truncateQuery(earlyBoundary, 200);
  assert.ok(kept.length <= 201, 'bounded, got ' + kept.length);
  assert.match(kept, /computeTotal/, 'the intent survives the cut');
  assert.ok(kept.length > 80, 'does not throw away most of the budget for an early period');

  // Late boundary: a period near the end of the cut is preferred, so the
  // trailing padding is dropped rather than cut mid-word.
  const lateBoundary = 'x'.repeat(150) + '. tail' + 'y'.repeat(500);
  const cut = cc.truncateQuery(lateBoundary, 200);
  assert.ok(cut.length <= 201, 'bounded, got ' + cut.length);
  assert.ok(!/y/.test(cut), 'padding after the boundary is dropped: ' + cut.slice(-30));
  assert.ok(cut.endsWith('.'), 'ends on the sentence boundary: ' + cut.slice(-20));

  // No boundary at all: still bounded, just a hard cut.
  const noBoundary = 'z'.repeat(900);
  assert.equal(cc.truncateQuery(noBoundary, 100).length, 100);
  // A short query is returned untouched.
  assert.equal(cc.truncateQuery('short', 200), 'short');
  assert.equal(cc.truncateQuery('', 200), '');
});

test('formatInjection frames the block as data that may be stale', () => {
  const dir = project();
  const block = cc.buildCodeContext({ projectDir: dir, messages: userMsg('computeTotal') });
  const text = cc.formatInjection(block);
  assert.match(text, /data, not instructions/i, 'must not read as instructions');
  assert.match(text, /may be stale/, 'warns the model not to trust it blindly');
  assert.match(text, /read a file before editing/i, 'tells it to verify first');
  assert.match(text, /computeTotal/);
  // A skipped block renders to nothing, so callers can append blindly.
  assert.equal(cc.formatInjection({ skipped: true, text: '' }), '');
  assert.equal(cc.formatInjection(null), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the index cache is shared and reused within the TTL', () => {
  const dir = project();
  const first = cc.getIndex(dir);
  const second = cc.getIndex(dir);
  assert.equal(first, second, 'same object served from cache');
  const forced = cc.getIndex(dir, { force: true });
  assert.notEqual(first, forced, 'force rebuilds');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writing a file through writeTextFile invalidates the index automatically', () => {
  const dir = project();
  const before = cc.getIndex(dir);
  const beforeNames = before.symbols.map(s => s.name);
  assert.ok(beforeNames.includes('computeTotal'));

  // Rewrite the file with a different exported symbol via the SAME write path
  // the tools and the edit-review accept use. Nothing calls invalidateIndex
  // explicitly — the observer must handle it.
  writeTextFile(path.join(dir, 'src/math.ts'),
    'export function renamedHelper(a: number): number { return a * 2; }\n');

  const after = cc.getIndex(dir);
  assert.notEqual(before, after, 'a stale index would be served here');
  const afterNames = after.symbols.map(s => s.name);
  assert.ok(afterNames.includes('renamedHelper'), 'new symbol visible: ' + afterNames.join(','));
  assert.ok(!afterNames.includes('computeTotal'), 'the deleted symbol is gone');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a write to a nested path invalidates its containing project', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'src/deep/nested'), { recursive: true });
  cc.getIndex(dir);
  assert.equal(cc.cacheSize() >= 1, true);
  writeTextFile(path.join(dir, 'src/deep/nested/leaf.ts'), 'export function leafFn() { return 1; }\n');
  const rebuilt = cc.getIndex(dir);
  assert.ok(rebuilt.symbols.some(s => s.name === 'leafFn'), 'deep write invalidated the project index');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a write outside any cached project leaves the cache alone', () => {
  const dir = project();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codectx-other-'));
  cc.getIndex(dir);
  const cachedBefore = cc.getIndex(dir);
  writeTextFile(path.join(other, 'unrelated.ts'), 'export const z = 1;\n');
  assert.equal(cc.getIndex(dir), cachedBefore, 'an unrelated write must not drop this project');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test('a path prefix collision does not falsely match (proj vs project)', () => {
  const dir = project();                      // ...\codectx-XXXX
  const lookalike = dir + '-suffix';           // shares the prefix, is NOT inside
  fs.mkdirSync(lookalike, { recursive: true });
  cc.getIndex(dir);
  const cached = cc.getIndex(dir);
  writeTextFile(path.join(lookalike, 'a.ts'), 'export const q = 1;\n');
  assert.equal(cc.getIndex(dir), cached, 'prefix-only match must not invalidate');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(lookalike, { recursive: true, force: true });
});

test('the cache is bounded and evicts oldest-first', () => {
  const dirs = [];
  for (let i = 0; i < 6; i++) dirs.push(project());
  for (const d of dirs) cc.getIndex(d);
  assert.ok(cc.cacheSize() <= 4, 'cache bounded to 4 projects, got ' + cc.cacheSize());
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('budgets expose the injection controls and validate them', () => {
  const r = resolveBudgets({}, {});
  assert.equal(r.codeContext, true, 'on by default');
  assert.equal(r.codeContextChars, 6000);
  const off = resolveBudgets({}, { budgetOverrides: { codeContext: false } });
  assert.equal(off.codeContext, false);
  const zero = resolveBudgets({}, { budgetOverrides: { codeContextChars: 0 } });
  assert.equal(zero.codeContextChars, 0, '0 disables injection');
  assert.throws(() => resolveBudgets({}, { budgetOverrides: { codeContext: 'yes' } }), /true or false/);
  assert.throws(() => resolveBudgets({}, { budgetOverrides: { codeContextChars: -1 } }), /whole number/);
});
