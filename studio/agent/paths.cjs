'use strict';

const path = require('node:path');
const fs = require('node:fs');

function realExistingAncestor(target) {
  let current = target;
  while (true) {
    try { fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
      continue;
    }
    // An existing dangling link must fail here, rather than being treated as
    // a missing path whose parent would incorrectly pass the boundary check.
    return fs.realpathSync(current);
  }
}

function resolveInProject(projectDir, requested) {
  if (!projectDir) throw new Error('This agent is not bound to a project directory.');
  const raw = String(requested || '').trim();
  if (!raw) throw new Error('A path is required.');
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(raw)) throw new Error('Absolute paths are not allowed. Use a project-relative path.');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) throw new Error('Parent-directory traversal (..) is not allowed.');
  const resolved = path.resolve(projectDir, raw);
  const rootResolved = path.resolve(projectDir);
  const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (!resolved.startsWith(rootWithSep) && resolved !== rootResolved) throw new Error('Path escapes the project directory.');
  const realRoot = fs.realpathSync(rootResolved);
  const realTarget = realExistingAncestor(resolved);
  const relative = path.relative(realRoot, realTarget);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Path escapes the project directory through a symbolic link or junction.');
  }
  return resolved;
}

module.exports = { resolveInProject };
