'use strict';
/*
 * No source file may write to a machine-specific absolute path.
 *
 * studio/main.mjs carried `fs.copyFileSync(..., '/private/tmp/reach-studio-...')`
 * twice — a developer convenience for finding a smoke screenshot on a Mac.
 * /private/tmp exists only on macOS, so on the Linux and Windows runners the
 * copy threw ENOENT and failed the whole REACH Studio job. main was red on
 * all three platforms before this test existed.
 *
 * The convenience is fine; the literal path is not. os.tmpdir() is the
 * portable answer, and a copy made for convenience belongs in a try/catch so
 * it can never fail a run.
 *
 * Test fixtures are exempt: a path used as DATA (asserting how a command line
 * is built for a hypothetical mac user) never touches the filesystem.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/* Roots that ship runnable code. */
const TREES = ['studio', 'vscode', 'src', 'copilot', 'server', 'tools'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'test', 'tests', '__pycache__']);
const CODE = /\.(c|m)?js$|\.py$/;

/* Absolute locations that only exist on one operating system, or only on one
 * person's machine. Matched inside string literals. */
const MACHINE_SPECIFIC = [
  { re: /['"`]\/private\/(tmp|var)\//, why: 'macOS-only path (/private/... does not exist on Linux or Windows)' },
  { re: /['"`]\/Users\/(?!test )/, why: 'a macOS home directory' },
  { re: /['"`][A-Za-z]:\\\\?Users\\\\/, why: 'a Windows home directory' },
  { re: /['"`]\/home\/(?!runner\b)[a-z]/, why: 'a Linux home directory' },
];

function sourceFiles() {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!CODE.test(entry.name)) continue;
      if (entry.name === 'editor.bundle.js') continue;
      out.push(full);
    }
  })(ROOT);
  return out.filter(f => TREES.some(t =>
    path.relative(ROOT, f).split(path.sep)[0] === t));
}

test('no source file hardcodes a machine-specific absolute path', () => {
  const offences = [];
  for (const file of sourceFiles()) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|#|\*)/.test(line)) return;   // a comment may name the old bug
      for (const { re, why } of MACHINE_SPECIFIC) {
        if (re.test(line)) offences.push(`${rel}:${i + 1} — ${why}\n      ${line.trim().slice(0, 110)}`);
      }
    });
  }
  assert.deepEqual(offences, [],
    'Use os.tmpdir(), app.getPath(), or a path relative to the repo:\n    ' + offences.join('\n    '));
});

test('the smoke screenshot copy is portable and cannot fail a run', () => {
  const main = fs.readFileSync(path.join(ROOT, 'studio', 'main.mjs'), 'utf8');
  assert.ok(main.includes('function copySmokeShot'),
    'both call sites go through one helper');
  const body = main.slice(main.indexOf('function copySmokeShot'));
  const helper = body.slice(0, body.indexOf('\n}') + 2);
  assert.ok(helper.includes('os.tmpdir()'), 'the destination is the platform temp dir');
  assert.ok(/catch\s*(\([^)]*\))?\s*\{/.test(helper),
    'a convenience copy is wrapped so it can never fail the smoke run');
});

test('the scanner would actually catch the bug it was written for', () => {
  /* A guard that cannot fail is decoration. Prove the pattern matches the
   * exact line that turned main red on three platforms. */
  const regressed = `        fs.copyFileSync(path.join(smokeRoot, 'x.png'), '/private/tmp/reach-studio-x.png');`;
  assert.ok(MACHINE_SPECIFIC.some(({ re }) => re.test(regressed)),
    'the /private/tmp pattern is matched');
  const fixed = `        copySmokeShot(smokeRoot, 'x.png');`;
  assert.ok(!MACHINE_SPECIFIC.some(({ re }) => re.test(fixed)), 'the fix is not flagged');
});

test('a CI runner path is not treated as machine-specific', () => {
  // /home/runner is GitHub's own checkout root and shows up in logs and docs.
  const runner = `const p = '/home/runner/work/repo/file.txt';`;
  assert.ok(!MACHINE_SPECIFIC.some(({ re }) => re.test(runner)));
});
