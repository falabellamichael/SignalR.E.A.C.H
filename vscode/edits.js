'use strict';

// Match literal source, allowing only the platform's newline representation to
// differ. Never guess an occurrence or normalize meaningful whitespace.
function locateEdit(current, search, replacement) {
  if (!search) throw new Error('This file already exists. Read its current text and propose a replacement with a non-empty search.');
  const escaped = search.replace(/\r\n/g, '\n').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n');
  const pattern = new RegExp(escaped, 'g');
  const match = pattern.exec(current);
  if (!match) throw new Error('This proposal no longer matches the current file. Refresh the edit to create a new proposal.');
  pattern.lastIndex = match.index + 1;
  if (pattern.exec(current)) throw new Error('The search text occurs more than once. Refresh the edit with more surrounding source.');
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  return { start: match.index, end: match.index + match[0].length, text: replacement.replace(/\r\n/g, '\n').replace(/\n/g, eol) };
}

// A bounded, verbatim window for repairing an anchor. Similarity selects what
// to show the model only; locateEdit must still validate its result exactly.
function repairWindow(current, search, limit = 3200) {
  if (current.length <= limit) return current;
  const anchors = search.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 12).sort((a,b) => b.length-a.length);
  const anchor = anchors.map(s => current.indexOf(s)).find(i => i >= 0);
  if (anchor === undefined) throw new Error('Could not locate this change in the current file. Read the relevant function and request a new, smaller edit.');
  const start = Math.max(0, current.lastIndexOf('\n', Math.max(0, anchor - 600)) + 1);
  const end = current.lastIndexOf('\n', start + limit);
  return current.slice(start, end > start ? end : start + limit);
}
module.exports = { locateEdit, repairWindow };
