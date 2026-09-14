'use strict';

const fs = require('fs');
const path = require('path');

const binaryExtensions = new Set(('.pyc .pyo .exe .dll .so .dylib .png .jpg .jpeg .gif .ico .webp .pdf .zip .gz .7z .rar .mp3 .mp4 .wav .woff .woff2 .ttf .db .sqlite .sqlite3 .asar').split(' '));

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

function writeTextFile(file, content) {
  assertTextPath(file);
  const existing = fs.existsSync(file) ? readTextFile(file) : { encoding: 'utf-8', bom: Buffer.alloc(0) };
  let body = Buffer.from(String(content), existing.encoding === 'utf-8' ? 'utf8' : 'utf16le');
  if (existing.encoding === 'utf-16be') body = body.swap16();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([existing.bom, body]));
}

module.exports = { readTextFile, writeTextFile, assertTextPath };
