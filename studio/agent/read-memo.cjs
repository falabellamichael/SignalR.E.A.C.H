'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { onFileWrite } = require('./text-files.cjs');

const READ_TOOLS = new Set(['read', 'list', 'glob', 'search', 'code.index', 'code.search', 'code.context', 'code.impact']);
const MAX_ENTRIES = 64;
const MAX_BYTES = 8 * 1024 * 1024;
const TTL_MS = 30000;

class ReadMemo {
  constructor(projectDir, { now = Date.now } = {}) {
    this.root = projectDir ? path.resolve(projectDir) : '';
    this.now = now;
    this.entries = new Map();
    this.bytes = 0;
    this.unsubscribe = onFileWrite(file => this.invalidate(file));
  }

  descriptor(name, args = {}) {
    if (!this.root || !READ_TOOLS.has(name) || args?.refresh === true) return null;
    const scope = path.resolve(this.root, String(args.path || '.'));
    if (scope !== this.root && !scope.startsWith(this.root + path.sep)) return null;
    let stat;
    try { stat = fs.statSync(scope); } catch { return null; }
    const digest = createHash('sha256').update(JSON.stringify(args || {})).digest('hex');
    return { scope, key: `${name}:${scope}:${stat.mtimeMs}:${stat.size}:${digest}` };
  }

  get(name, args) {
    const descriptor = this.descriptor(name, args);
    if (!descriptor) return null;
    const entry = this.entries.get(descriptor.key);
    if (!entry) return null;
    if (this.now() - entry.at > TTL_MS) { this._drop(descriptor.key); return null; }
    return structuredClone(entry.value);
  }

  set(name, args, value) {
    const descriptor = this.descriptor(name, args);
    if (!descriptor || !value?.ok || value.pending) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_BYTES) return;
    this._drop(descriptor.key);
    while ((this.entries.size >= MAX_ENTRIES || this.bytes + bytes > MAX_BYTES) && this.entries.size) {
      this._drop(this.entries.keys().next().value);
    }
    this.entries.set(descriptor.key, { scope: descriptor.scope, value: structuredClone(value), bytes, at: this.now() });
    this.bytes += bytes;
  }

  _drop(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  invalidate(file) {
    const abs = path.resolve(file);
    for (const [key, entry] of this.entries) {
      if (abs === entry.scope || abs.startsWith(entry.scope + path.sep)) this._drop(key);
    }
  }

  close() { this.unsubscribe(); this.entries.clear(); this.bytes = 0; }
}

module.exports = { ReadMemo, READ_TOOLS };
