'use strict';

/* Describe a file write for the Files drawer.
 *
 * The renderer paints this. It does not get the file bodies: it re-reads the
 * saved text and uses `changes` only to place green lines and red deletions.
 * `at` on a deletion is the 1-based line in the NEW file that the deleted
 * text should sit in front of, or null when the deletion is at the end.
 */

const path = require('node:path');
const { diffEntries, stats } = require('./diff.cjs');

const MAX_COMBINED_CHARS = 200000;
const MAX_LINES = 1200;
const MAX_LINE_PRODUCT = 800000;
const MAX_CHANGES = 400;
const MAX_DEL_CHARS = 400;

function cleanRelative(rel) {
  const norm = String(rel || '').split('\\').join('/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!norm || norm === '.' || norm.includes(':')) return '';
  const parts = norm.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return '';
  return parts.join('/');
}

function relativePath(root, file) {
  if (!root || !file) return '';
  const rel = path.relative(path.resolve(String(root)), path.resolve(String(file)));
  return cleanRelative(rel);
}

function clipLine(text) {
  const line = String(text ?? '');
  if (line.length <= MAX_DEL_CHARS) return line;
  return line.slice(0, MAX_DEL_CHARS - 1) + '…';
}

function truncated(base) {
  return { ...base, added: null, removed: null, truncated: true, changes: [] };
}

/* A brand-new or emptied file does not need the LCS table. Diffing against
 * '' also invents a phantom blank line, which would show up as a fake deletion. */
/* A terminating newline is not its own line. Counting it would paint a blank
 * green or red row under every new or cleared file. */
function contentLines(text) {
  const lines = text.split('\n');
  if (text.endsWith('\n') && lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? lines : [''];
}

function wholeFileChange(base, oldText, newText) {
  if (oldText === '') {
    const lines = contentLines(newText);
    base.added = lines.length;
    base.removed = 0;
    base.changes = lines.slice(0, MAX_CHANGES).map((_line, index) => ({ type: 'add', next: index + 1 }));
    base.truncated = lines.length > MAX_CHANGES;
    return base;
  }
  const lines = contentLines(oldText);
  base.added = 0;
  base.removed = lines.length;
  base.changes = lines.slice(0, MAX_CHANGES).map(line => ({ type: 'del', text: clipLine(line), at: null }));
  base.truncated = lines.length > MAX_CHANGES;
  return base;
}

function buildLiveChange({ root, file, path: relPath, before, after, created = false } = {}) {
  if (!root) return null;
  const rel = relPath ? cleanRelative(relPath) : relativePath(root, file);
  if (!rel) return null;
  const oldText = String(before ?? '');
  const newText = String(after ?? '');
  if (oldText === newText) return null;
  const base = {
    root: path.resolve(String(root)),
    path: rel,
    created: created === true && oldText.length === 0,
    added: 0,
    removed: 0,
    truncated: false,
    changes: [],
  };
  if (oldText.length + newText.length > MAX_COMBINED_CHARS) return truncated(base);
  if (oldText === '' || newText === '') return wholeFileChange(base, oldText, newText);
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES || oldLines.length * newLines.length > MAX_LINE_PRODUCT) {
    return truncated(base);
  }
  const entries = diffEntries(oldText, newText);
  const count = stats(entries);
  base.added = count.added;
  base.removed = count.removed;
  const changes = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === 'ctx') continue;
    if (changes.length >= MAX_CHANGES) { base.truncated = true; break; }
    if (entry.type === 'add') {
      changes.push({ type: 'add', next: entry.next });
      continue;
    }
    let at = null;
    for (let k = i + 1; k < entries.length; k++) {
      if (entries[k].next != null) { at = entries[k].next; break; }
    }
    changes.push({ type: 'del', text: clipLine(entry.text), at });
  }
  base.changes = changes;
  return base;
}

function liveEventFor(info) {
  if (!info || info.live === false) return null;
  return buildLiveChange(info);
}

module.exports = { buildLiveChange, liveEventFor, relativePath, cleanRelative };
