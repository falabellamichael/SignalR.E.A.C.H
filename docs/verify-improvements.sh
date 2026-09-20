#!/usr/bin/env bash
# Fast, dependency-free snapshot for IMPROVEMENTS_VERIFIED.md.
# Counts source only: never walk node_modules, dist, or live user-data.
set -euo pipefail
cd "$(dirname "$0")/.."
node <<'NODE'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const read = file => fs.readFileSync(file, 'utf8');
const count = (dir, suffix) => fs.readdirSync(dir).filter(name => name.endsWith(suffix)).length;
const report = (label, value) => console.log(label.padEnd(34), value);
const channels = (file, pattern) => new Set([...read(file).matchAll(pattern)].map(match => match[1]));
const handlers = channels('studio/main.mjs', /^\s*ipcMain\.handle\('([^']+)'/gm);
const preload = channels('studio/preload.cjs', /ipcRenderer\.invoke\('([^']+)'/g);
report('Node', process.version);
report('HEAD', execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim());
for (const file of ['studio/main.mjs', 'studio/renderer/app.js', 'studio/preload.cjs']) report(file + ' lines', read(file).split('\n').length - 1);
report('Static handlers', handlers.size);
report('Preload invoke channels', preload.size);
report('Preload-only channels', [...preload].filter(channel => !handlers.has(channel)).join(', ') || 'none');
report('Agent modules', count('studio/agent', '.cjs'));
report('Renderer scripts', count('studio/renderer', '.js'));
report('Unit test files', count('studio/test', '.test.cjs'));
report('Dirty paths (live snapshot)', execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length);
for (const file of ['studio/agent/settings-store.cjs', 'studio/agent/endpoint.cjs', 'studio/agent/attention.cjs', 'studio/agent/untrusted.cjs', 'studio/ipc-manifest.json', 'studio/CONTRIBUTING.md', 'SECURITY.md']) report(file, fs.existsSync(file) ? 'present' : 'MISSING');
report('Windows packaging in CI', read('.github/workflows/ci.yml').includes('npm run dist:win'));
report('Coverage command', JSON.parse(read('studio/package.json')).scripts['test:coverage'] || 'MISSING');
console.log('\nVerification (not run by this snapshot):');
console.log('cd studio && npm test && npm run smoke');
console.log('cd studio && npm run test:coverage');
console.log('cd vscode && npm test');
console.log('cd copilot/tray && npm test');
console.log('node tools/check-javascript.cjs');
NODE
