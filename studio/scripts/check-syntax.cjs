// Syntax gate for the Studio tree.
//
// This walks every JS/CJS/MJS source under the Studio root and runs
// `node --check` on each. It used to do a FLAT `fs.readdirSync(dir)` per
// directory, which means the moment anyone added a subdirectory (e.g.
// `ipc/` from the Phase 3 split, or `agent/sub/`) those files were silently
// unchecked with no warning — a parse error would only surface at runtime.
//
// It now recurses, so new subdirectories are covered automatically.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Directories that are never source: build output, installed deps, VCS.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.cache', 'coverage']);

// Entry files at the Studio root, checked explicitly so a rename is a loud
// failure rather than a silently-empty walk.
const ENTRY_FILES = ['main.mjs', 'preload.cjs'];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, out);
    } else if (entry.isFile() && /\.(cjs|mjs|js)$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

const sources = [];
for (const entry of ENTRY_FILES) {
  const abs = path.join(ROOT, entry);
  if (!fs.existsSync(abs)) {
    console.error(`check-syntax: expected entry file is missing: ${entry}`);
    process.exit(1);
  }
  sources.push(abs);
}
walk(ROOT, sources);

// Stable order so CI output is diffable between runs.
const unique = [...new Set(sources)].sort();

let failed = 0;
for (const source of unique) {
  const rel = path.relative(ROOT, source) || source;
  const result = spawnSync(process.execPath, ['--check', source], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`check-syntax: FAILED ${rel}`);
  }
}

if (failed > 0) {
  console.error(`check-syntax: ${failed} of ${unique.length} files failed to parse`);
  process.exit(1);
}
console.log(`check-syntax: ${unique.length} files parse cleanly (recursive)`);
