'use strict';

/* Reach Studio — crash-safe file writes.
 *
 * The settings/projects/personas/teams stores all persist one JSON document per
 * file, rewritten wholesale on save. A bare fs.writeFileSync on the real path
 * can truncate the file mid-write (kill -9, power loss, disk full), which on
 * the next load silently degrades to the empty shape and loses every key.
 *
 * The pattern here — write a sibling .tmp file, then fs.renameSync it over the
 * real path — is the same one agent-store.cjs and persona-store.cjs already
 * use. rename() is atomic on POSIX and on NTFS within a directory, so a reader
 * never observes a half-written document: they see either the old file or the
 * new file, never a truncated blend.
 *
 * audit-log.cjs deliberately does NOT use this: it is append-only and
 * hash-chained, so a tmp+rename per record would break the chain and turn every
 * append into an O(n) rewrite.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Atomically write `value` as pretty-printed JSON to `file`. */
function atomicWriteJson(file, value) {
  return atomicWriteText(file, JSON.stringify(value, null, 2) + '\n');
}

/** Atomically write the given string to `file` (tmp + rename). */
function atomicWriteText(file, text) {
  const target = String(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, String(text), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
}

module.exports = { atomicWriteJson, atomicWriteText };
