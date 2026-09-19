'use strict';

/* Every executeJavaScript template literal in main.mjs must GENERATE parseable JS.
 *
 * The smoke drives the renderer by evaluating template literals built in
 * main.mjs. A backslash escape typed inside such a literal is consumed when the
 * template is evaluated, so `throw new Error('the one\'s key')` becomes
 * `throw new Error('the one's key')` in the generated source — a syntax error
 * that makes the ENTIRE block fail to parse. The only symptom is
 *
 *     SMOKE FAIL: Error: Script failed to execute, this normally means an error
 *     was thrown. Check the renderer console for the error.
 *
 * which names no line and no block, and the renderer console is not captured by
 * the smoke. This bug shipped once already (2026-09-18, an apostrophe in a
 * connection assertion) and cost a full smoke cycle to find.
 *
 * node --check on main.mjs cannot catch it: the template literal is a perfectly
 * valid STRING; only its generated contents are broken. So parse the generated
 * contents here instead.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', 'main.mjs');

/**
 * Reproduce what the JS engine produces for a template literal body.
 * `${...}` interpolations become placeholder identifiers (their runtime values
 * are unknown here, but any expression parses the same way as a name), and
 * backslash escapes are applied exactly as the parser would apply them.
 */
function generatedSource(rawTemplateBody) {
  return rawTemplateBody
    .replace(/\\\$\{/g, '__ESCAPED_DOLLAR_BRACE__')
    .replace(/\$\{[\s\S]*?\}/g, '__INTERP__')
    .replace(/\\(.)/g, (_all, ch) => {
      if (ch === 'n') return '\n';
      if (ch === 't') return '\t';
      if (ch === 'r') return '\r';
      return ch;   // \' -> '   \" -> "   \\ -> \   and any other \x -> x
    });
}

function collectBlocks(src) {
  const re = /executeJavaScript\(\s*`([\s\S]*?)`\s*[,)]/g;
  const blocks = [];
  let m;
  while ((m = re.exec(src)) !== null) blocks.push({ raw: m[1], index: m.index });
  return blocks;
}

test('main.mjs smoke blocks generate parseable renderer JS', () => {
  const src = fs.readFileSync(MAIN, 'utf8');
  const blocks = collectBlocks(src);

  // Guard the guard: if the regex stopped matching (refactor, renamed helper),
  // this test would silently pass while covering nothing.
  assert.ok(blocks.length >= 20,
    `expected the smoke's executeJavaScript blocks to be found, got ${blocks.length} — did the harness change shape?`);

  const failures = [];
  for (const [i, block] of blocks.entries()) {
    const generated = generatedSource(block.raw);
    try {
      // new Function parses without executing — exactly what we want to test.
      // eslint-disable-next-line no-new-func
      new Function(generated);
    } catch (error) {
      // Report the line in main.mjs, which the raw smoke error never does.
      const line = src.slice(0, block.index).split('\n').length;
      failures.push(`block #${i + 1} (main.mjs line ~${line}): ${error.message}`);
    }
  }
  assert.deepEqual(failures, [], 'generated renderer script must parse:\n  ' + failures.join('\n  '));
});

test('no stray backslash escapes lurk in the smoke template literals', () => {
  /* The specific shape that broke: a backslash inside a template literal that is
   * NOT one of the escapes the author meant. Listing them makes the failure
   * actionable — "block does not parse" alone sends you hunting through a
   * 3000-line file.
   *
   * Allowed: \\ (a literal backslash the generated code needs), \` and \${ which
   * are about the template itself. Everything else in these blocks is almost
   * certainly an apostrophe or quote someone escaped out of habit.
   */
  const src = fs.readFileSync(MAIN, 'utf8');
  const blocks = collectBlocks(src);
  const suspicious = [];
  for (const [i, block] of blocks.entries()) {
    for (const m of block.raw.matchAll(/\\(.)/g)) {
      const ch = m[1];
      if (!['\\', '`', '$', 'n', 't', 'r'].includes(ch)) {
        const line = src.slice(0, block.index + m.index).split('\n').length;
        suspicious.push(`block #${i + 1} (main.mjs line ~${line}): backslash before '${ch}' in ...${block.raw.slice(Math.max(0, m.index - 40), m.index + 20).replace(/\n/g, ' ')}...`);
      }
    }
  }
  assert.deepEqual(suspicious, [], 'unexpected escapes in generated renderer code:\n  ' + suspicious.join('\n  '));
});
