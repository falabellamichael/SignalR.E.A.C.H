'use strict';
// Parse tracked source rather than fragile shell globs; works on Windows too.
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const scope = process.argv[2];
if (scope && !['vscode', 'copilot/tray'].includes(scope)) throw new Error('Unknown JavaScript check scope.');
const files = execFileSync('git', ['ls-files', '-z', '--', scope || '.'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(file => /\.(js|cjs|mjs)$/.test(file) && !file.startsWith('studio/'));
if (!files.length) throw new Error('No JavaScript sources found.');
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(1);
}
console.log(`Parsed ${files.length} JavaScript sources (${scope || 'repo outside Studio'}).`);
