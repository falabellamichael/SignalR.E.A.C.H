'use strict';

const fs = require('fs');
const path = require('path');
const engines = require('./engines.cjs');

const binaryExtensions = new Set(('.pyc .pyo .exe .dll .so .dylib .png .jpg .jpeg .gif .ico .webp .bmp .avif .tif .tiff .pdf .zip .gz .7z .rar .mp3 .mp4 .wav .woff .woff2 .ttf .db .sqlite .sqlite3 .asar').split(' '));

/* Previewable (non-text) files the editor drawer can render without saving.
 * Images render inline; audio/video render a player; PDFs render in an
 * iframe. Everything else binary still reports "cannot open as text" with an
 * "Open externally" affordance handled by the renderer. */
const previewMimeByExt = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
};
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

function previewKindFor(file) {
  const mime = previewMimeByExt[path.extname(file).toLowerCase()];
  if (!mime) return null;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return null;
}

function readPreviewFile(file) {
  const kind = previewKindFor(file);
  if (!kind) return null;
  const stat = fs.statSync(file);
  if (stat.size > PREVIEW_MAX_BYTES) throw new Error('File is too large to preview (25 MB limit).');
  const mime = previewMimeByExt[path.extname(file).toLowerCase()];
  const data = fs.readFileSync(file).toString('base64');
  return { kind, mime, dataUrl: `data:${mime};base64,${data}`, size: stat.size };
}

function assertTextPath(file) {
  if (!binaryExtensions.has(path.extname(file).toLowerCase())) return;
  const hint = /\.py[co]$/i.test(file)
    ? ' This is compiled Python bytecode; open the corresponding .py source file instead.' : '';
  throw new Error('Binary files cannot be opened or saved as text.' + hint);
}

function readTextFile(file) {
  assertTextPath(file);
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('File is too large to open as text (2 MB limit).');
  const bytes = fs.readFileSync(file);
  let encoding = 'utf-8', bom = Buffer.alloc(0), body = bytes;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = bytes.subarray(0, 3); body = bytes.subarray(3);
  } else if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    encoding = bytes[0] === 0xff ? 'utf-16le' : 'utf-16be';
    bom = bytes.subarray(0, 2); body = bytes.subarray(2);
  }
  let content;
  try { content = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body); }
  catch { throw new Error('This file is binary or uses an unsupported text encoding. It was not opened or modified.'); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(content)) {
    throw new Error('This file contains binary data and cannot be opened or saved as text.');
  }
  return { content, encoding, bom };
}

/* Write observers.
 *
 * Every write to disk goes through writeTextFile below — the core write and
 * edit_patch tools, the edit-review acceptance path in main.mjs, and the save
 * handler. Derived state about the file tree therefore has to be invalidated
 * here or not at all: patching each call site is how a cache goes stale the
 * first time someone adds a new writer.
 *
 * This is an observer rather than a direct require of code-context.cjs so the
 * layering stays honest — a text I/O utility should not know that a symbol index
 * exists. Observers must not throw into the write path.
 */
const writeObservers = [];
function onFileWrite(listener) {
  if (typeof listener !== 'function') return () => {};
  writeObservers.push(listener);
  return () => { const i = writeObservers.indexOf(listener); if (i >= 0) writeObservers.splice(i, 1); };
}

function writeTextFile(file, content, options = {}) {
  assertTextPath(file);
  if (options.root) engines.assertWritePath(options.root, path.relative(options.root, file));
  const existed = fs.existsSync(file);
  const before = existed ? fs.readFileSync(file) : null;
  if ('expectedHash' in options && options.expectedHash !== (before === null ? null : engines.hash(before))) {
    throw new Error('The file changed since this edit was proposed. Refresh the proposal before accepting it.');
  }
  const existing = existed ? readTextFile(file) : { encoding: 'utf-8', bom: Buffer.alloc(0) };
  let body = Buffer.from(String(content), existing.encoding === 'utf-8' ? 'utf8' : 'utf16le');
  if (existing.encoding === 'utf-16be') body = body.swap16();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.concat([existing.bom, body]);
  const tmp = file + '.reach-' + require('node:crypto').randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  engines.receipt(options.root ? path.relative(options.root, file) : path.basename(file), before, fs.readFileSync(file), options.scope || 'editor');
  /* `before` is the previous decoded text ('' for a new file). `live: false`
   * marks a user save so the editor does not replay its own write. Listeners
   * that only take the path are unchanged. */
  const info = {
    before: existing.content ?? '',
    after: String(content),
    root: options.root || '',
    live: options.live !== false,
    created: !existed,
  };
  for (const listener of writeObservers) {
    try { listener(file, info); } catch { /* a failing observer must not fail the write */ }
  }
}

module.exports = { readTextFile, writeTextFile, assertTextPath, onFileWrite, readPreviewFile, previewKindFor };
