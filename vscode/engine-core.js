'use strict';

// Shared Phase 1 engine runtime. Studio packages this exact module as an extra
// resource; the extension installer already includes root-level JS modules.
// No Python installation, network request, or model call is required.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SCHEMA_VERSION = 1;
const hash = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
const id = prefix => prefix + '-' + crypto.randomUUID();
const rules = [
  ['private_key_block', /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g],
  ['bearer_token', /\b(?:authorization\s*:\s*)?bearer\s+[^\s"']+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gi],
  ['openai_key', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['password_assignment', /(?:password|passwd|pwd|api_?key|secret|token)["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]{8,})/gi],
  ['basic_auth', /\bbasic\s+[A-Za-z0-9+/]{16,}={0,2}/gi],
];
function detect(text) {
  const hits = [];
  for (const [rule, regex] of rules) {
    regex.lastIndex = 0;
    for (const match of String(text).matchAll(regex)) {
      if (match[0].includes('[REDACTED:')) continue;
      hits.push({ rule, start: match.index, end: match.index + match[0].length });
    }
  }
  return hits.sort((a, b) => a.start - b.start || b.end - a.end);
}
function redact(text) {
  text = String(text);
  let cursor = 0, clean = '', hits = 0;
  for (const hit of detect(text)) {
    if (hit.start < cursor) continue;
    clean += text.slice(cursor, hit.start) + `[REDACTED:${hit.rule}]`;
    cursor = hit.end; hits++;
  }
  return { text: clean + text.slice(cursor), hits };
}
function scrub(value, key = '') {
  if (typeof value === 'string') {
    if (/(password|passwd|pwd|api_?key|secret|token|authorization)$/i.test(key) && value) return '[REDACTED:credential]';
    return redact(value).text;
  }
  if (Array.isArray(value)) return value.map(item => scrub(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k).text, scrub(v, k)]));
  return value;
}
function resolveExisting(file) {
  if (fs.existsSync(file)) return fs.realpathSync(file);
  const parent = path.dirname(file);
  if (parent === file) throw new Error('No existing project root.');
  return path.join(resolveExisting(parent), path.basename(file));
}
function assertWritePath(root, requested) {
  if (!root) throw new Error('A project root is required for engine writes.');
  const rel = String(requested || '').replace(/\\/g, '/');
  if (!rel || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.split('/').includes('..') || rel.includes(':')) {
    throw new Error('Engine write gate: use a project-relative path without traversal.');
  }
  const canonicalRoot = resolveExisting(path.resolve(root));
  const target = resolveExisting(path.resolve(root, rel));
  const resolved = path.relative(canonicalRoot, target);
  if (!resolved || resolved === '..' || resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved)) throw new Error('Engine write gate: path escapes the project.');
  const normalized = resolved.replace(/\\/g, '/').toLowerCase();
  const name = path.posix.basename(normalized);
  if (/^\.env(?:\.|$)|\.(?:pem|key|crt|spec)$|^requirements.*\.txt$/.test(name)
      || ['pyproject.toml', 'setup.py', 'rebuild_all_exes.ps1'].includes(name)
      || normalized.split('/').some(p => ['.git', 'credentials', 'migrations', 'release_metadata', 'packaging', 'databases'].includes(p))
      || normalized.endsWith('electron_app/installer-sidecar.nsh')) {
    throw new Error('Engine write gate: protected file requires a manual edit: ' + rel);
  }
  return target;
}
function scoreChange(file, before, after) {
  const text = String(after), why = [];
  let risk = 0;
  if (before == null) { risk += 25; why.push('whole new file'); }
  if (/\b(?:export\s|module\.exports|def [A-Za-z]|class [A-Za-z])/.test(text)) { risk += 40; why.push('public API surface'); }
  if (detect(text).length) { risk += 50; why.push('secret-shaped text'); }
  if (/(?:^|\/)(?:build|dist|electron_dist)\/|\.bundle\.js$|generated/i.test(file)) { risk += 30; why.push('generated file'); }
  if (/migration|schema|\.sql$/i.test(file)) { risk += 40; why.push('schema or migration'); }
  const size = text.split(/\r?\n/).length;
  if (size > 100) { risk += 20; why.push('large change'); }
  return { risk: Math.min(risk, 100), why: why.length ? why : ['unflagged'], heuristic: true };
}
class EngineLedger {
  constructor(file = null) {
    this.file = file; this.records = []; this.persistenceError = null;
    if (file && fs.existsSync(file)) {
      try {
        // This is a bounded local activity ledger, not an unbounded transcript.
        const size = fs.statSync(file).size;
        if (size <= 8 * 1024 * 1024) this.records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).slice(-1000);
      } catch { this.persistenceError = 'Previous engine ledger could not be read.'; }
    }
  }
  append(record) {
    const clean = scrub({ schemaVersion: SCHEMA_VERSION, id: id(record.kind || 'record'), timestamp: new Date().toISOString(), ...record });
    this.records.push(clean);
    if (this.records.length > 1000) this.records.shift();
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        if (fs.existsSync(this.file) && fs.statSync(this.file).size > 4 * 1024 * 1024) {
          const tmp = this.file + '.tmp';
          fs.writeFileSync(tmp, this.records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
          fs.renameSync(tmp, this.file);
        } else fs.appendFileSync(this.file, JSON.stringify(clean) + '\n', { mode: 0o600 });
        this.persistenceError = null;
      } catch { this.persistenceError = 'Engine evidence is in memory; its local ledger could not be saved.'; }
    }
    return clean;
  }
  observe(tool, args, result, scope = '') {
    const safeArgs = scrub(args || {}), safeResult = scrub(result || {});
    return this.append({ kind: 'observation', scope, tool, success: result?.ok === true && !result?.pending,
      pending: !!result?.pending, argsHash: hash(JSON.stringify(safeArgs)), resultHash: hash(JSON.stringify(safeResult)),
      redacted: JSON.stringify(safeArgs) !== JSON.stringify(args || {}) || JSON.stringify(safeResult) !== JSON.stringify(result || {}) });
  }
  claim(text, observations = [], scope = '') {
    // A tool succeeding is not proof of arbitrary prose. Claims remain
    // unverified until a reviewer explicitly corroborates the evidence.
    return this.append({ kind: 'claim', scope, text: redact(String(text)).text.slice(0, 2000), status: 'unverified', observations });
  }
  corroborate(claimId, observationIds) {
    const claim = this.records.find(r => r.id === claimId && r.kind === 'claim');
    if (!claim) throw new Error('Unknown claim.');
    const evidence = observationIds.map(obsId => this.records.find(r => r.id === obsId && r.kind === 'observation' && r.scope === claim.scope && r.success));
    if (evidence.some(r => !r) || new Set(evidence.map(r => r.tool)).size < 2) throw new Error('Two distinct successful tools in the same task are required.');
    return this.append({ kind: 'claim-status', claimId, status: 'corroborated', observations: observationIds, scope: claim.scope });
  }
  report(scope) {
    const records = this.records.filter(r => scope === undefined || r.scope === scope);
    return { schemaVersion: SCHEMA_VERSION, active: ['evidence ledger', 'write gate', 'review scoring', 'secret redaction'],
      modelCalls: 0, observations: records.filter(r => r.kind === 'observation').length,
      receipts: records.filter(r => r.kind === 'receipt').length,
      claims: records.filter(r => r.kind === 'claim').length,
      unverified: records.filter(r => r.kind === 'claim' && !records.some(s => s.kind === 'claim-status' && s.claimId === r.id && s.status === 'corroborated')).length,
      persistenceError: this.persistenceError, records: records.slice(-50),
      limits: 'Local bounded evidence. Review scores are heuristics. Shell commands remain governed by host approvals; the file write gate does not sandbox shells.' };
  }
}
let ledger = new EngineLedger();
function configure(file) { ledger = new EngineLedger(file); return ledger; }
function getLedger() { return ledger; }
function receipt(file, before, after, scope = '', storage = 'disk') {
  return ledger.append({ kind: 'receipt', path: file, beforeHash: before == null ? null : hash(before), afterHash: hash(after), scope, storage });
}
module.exports = { SCHEMA_VERSION, hash, detect, redact, scrub, assertWritePath, scoreChange, EngineLedger, configure, getLedger, receipt };
