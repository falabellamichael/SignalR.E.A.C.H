'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveInProject } = require('./tool-registry.cjs');
const PAGE_SIZE = 250;

// List one folder at a time. A large build folder must never consume a
// project-wide budget and hide unrelated source files from the browser.
async function listDirectory(root, directory = '', offset = 0) {
  const abs = resolveInProject(root, directory || '.');
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(root), fs.realpath(abs)]);
  const relative = path.relative(realRoot, realDirectory);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Folder escapes the project directory.');
  const entries = (await fs.readdir(abs, { withFileTypes: true }))
    .filter(entry => !entry.isSymbolicLink() && !['.git', 'node_modules', '__pycache__'].includes(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const start = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const prefix = path.relative(path.resolve(root), abs).split(path.sep).join('/');
  const tree = entries.slice(start, start + PAGE_SIZE).map(entry => ({
    path: prefix ? prefix + '/' + entry.name : entry.name,
    type: entry.isDirectory() ? 'dir' : 'file',
    depth: prefix ? prefix.split('/').length : 0,
  }));
  return { ok: true, root, directory: prefix, tree, total: entries.length,
    nextOffset: start + PAGE_SIZE < entries.length ? start + PAGE_SIZE : null };
}

module.exports = { listDirectory };
