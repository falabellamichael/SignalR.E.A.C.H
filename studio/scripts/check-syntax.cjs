const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const sources = ['main.mjs', 'preload.cjs', ...['agent', 'browser', 'renderer', 'test', 'scripts'].flatMap(dir => fs.readdirSync(dir).filter(name => /\.(cjs|mjs|js)$/.test(name)).map(name => `${dir}/${name}`))];
for (const source of sources) {
  const result = spawnSync(process.execPath, ['--check', source], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
