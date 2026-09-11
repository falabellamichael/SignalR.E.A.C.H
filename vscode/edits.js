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
/* A pure-insertion helper: replace the inclusive 1-based line range with the
 * supplied text. Used by the edit_patch tool when the model gives line ranges
 * instead of an exact search anchor. */
function replaceLines(current, startLine, endLine, replacement) {
  const lines = current.split('\n');
  const start = startLine === undefined ? 1 : startLine;
  const end = endLine === undefined ? start : endLine;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || start > lines.length) {
    throw new Error('Use valid 1-based startLine/endLine values. File has ' + lines.length + ' lines.');
  }
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const text = String(replacement === undefined ? '' : replacement)
    .replace(/\r\n/g, '\n').replace(/\n/g, eol);
  const next = lines.slice(0, start - 1).concat(text === '' ? [] : text.split(eol)).concat(lines.slice(end));
  return next.join('\n');
}

/* Apply an ordered set of hunks to the current text. Each hunk is either
 * { search, replace } (resolved through locateEdit, so it keeps today's exact
 * matching and uniqueness guarantees) or { startLine, endLine, replace }
 * (a line range). Hunks are applied in the given order against the evolving
 * text — an earlier hunk shifting line numbers is therefore the caller's
 * problem, which is why search-anchored hunks are preferred.
 *
 * All-or-nothing: if any hunk fails, nothing is returned and the caller's
 * original text is untouched, so a partially applied patch can never be
 * written to disk. */
function applyPatch(current, hunks) {
  if (!Array.isArray(hunks) || !hunks.length) throw new Error('edit_patch expects a non-empty "hunks" array.');
  if (hunks.length > 40) throw new Error('Keep an edit_patch to 40 hunks or fewer.');
  let text = current;
  hunks.forEach((hunk, i) => {
    if (!hunk || typeof hunk !== 'object') throw new Error('Hunk ' + (i + 1) + ' is not an object.');
    const label = 'Hunk ' + (i + 1) + ': ';
    try {
      if (typeof hunk.search === 'string' && hunk.search !== '') {
        const found = locateEdit(text, hunk.search, String(hunk.replace === undefined ? '' : hunk.replace));
        text = text.slice(0, found.start) + found.text + text.slice(found.end);
      } else if (hunk.startLine !== undefined) {
        text = replaceLines(text, hunk.startLine, hunk.endLine, hunk.replace);
      } else {
        throw new Error('needs either a non-empty "search" or a "startLine".');
      }
    } catch (e) {
      throw new Error(label + String((e && e.message) || e));
    }
  });
  if (text === current) throw new Error('This patch would not change the file. Check the hunks against the current source.');
  return text;
}

module.exports = { locateEdit, repairWindow, replaceLines, applyPatch, alreadyApplied };

/* A proposal whose replacement is already exactly in place — and whose search
 * anchor is gone — is done, not broken. That is the normal outcome for a card
 * that outlived a batch, a round that re-proposed the same change, or work
 * another surface landed first. Newline tolerance only; nothing else is guessed,
 * and a tiny replacement is never trusted (too easy to collide). */
function alreadyApplied(current, search, replace) {
  const repl = String(replace == null ? '' : replace);
  if (repl.trim().length < 8) return false;
  const text = String(current || '').replace(/\r\n/g, '\n');
  const anchor = String(search == null ? '' : search).replace(/\r\n/g, '\n');
  if (anchor && text.includes(anchor)) return false;   // still applicable
  return text.includes(repl.replace(/\r\n/g, '\n'));
}
