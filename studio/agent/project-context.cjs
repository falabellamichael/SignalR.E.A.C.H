'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_METADATA_BYTES = 64 * 1024;

function readMetadata(root, relative) {
  try {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA_BYTES) return '';
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('\0') ? '' : text;
  } catch { return ''; }
}

// These are file-derived labels, never instructions. Callers must keep them in
// the same untrusted-data boundary as source snippets and other tool results.
function identifyProject(projectDir) {
  const root = path.resolve(String(projectDir));
  const evidence = [];
  const add = (file, field, value) => {
    if (typeof value !== 'string' || !value.trim()) return '';
    const label = value.trim().slice(0, 200);
    evidence.push({ path: file, field, value: label });
    return label;
  };
  let product = '', packageName = '', heading = '', pythonName = '';
  try {
    const manifest = JSON.parse(readMetadata(root, 'package.json'));
    product = add('package.json', 'productName', manifest.productName);
    packageName = add('package.json', 'name', manifest.name);
  } catch { /* A Python project need not have a package.json. */ }
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { /* Missing roots are reported by the indexer. */ }
  const readme = entries.filter(file => /^readme(?:\.(?:md|markdown|rst|txt))?$/i.test(file))
    .sort((a, b) => Number(!/\.md$/i.test(a)) - Number(!/\.md$/i.test(b)) || a.localeCompare(b))[0];
  if (readme) {
    const title = readMetadata(root, readme).match(/^\s{0,3}#{1,2}\s+([^\r\n]+)/m);
    if (title) heading = add(readme, 'heading', title[1].replace(/\s+#+\s*$/, ''));
  }
  let section = '';
  for (const line of readMetadata(root, 'pyproject.toml').split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) section = header[1];
    if (section !== 'project' && section !== 'tool.poetry') continue;
    const name = line.match(/^\s*name\s*=\s*(["'])([^"'\r\n]+)\1/);
    if (name) { pythonName = add('pyproject.toml', section + '.name', name[2]); break; }
  }
  return { root, name: product || heading || packageName || pythonName || path.basename(root), evidence };
}

module.exports = { identifyProject };
