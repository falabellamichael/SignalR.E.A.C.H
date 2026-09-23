'use strict';

const path = require('node:path');

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
  return resolved;
}

module.exports = { resolveInProject };
