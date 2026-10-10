'use strict';

/* Reach Studio — provenance-aware project memory (agentic capability 9).
 *
 * A flat note file cannot answer "is this fact still true?". A project fact
 * here carries its SOURCE (where it came from), when it was last CONFIRMED,
 * and a confidence. Facts older than the staleness window are flagged STALE
 * in the prompt block instead of silently reading as current truth, and two
 * active facts about the same thing with different claims are surfaced as a
 * CONFLICT. Forgetting is explicit and user-driven: disable() soft-hides a
 * fact, forget() removes it.
 *
 * Pure leaf module with one file of its own: atomic JSON writes (invariant
 * A1), bounded sizes, and no other requires, so it can sit next to the
 * agent's soul files without dragging in I/O-heavy modules.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteText } = require('./atomic-write.cjs');

const MAX_FACTS = 200;
const MAX_CLAIM_CHARS = 2000;
const STALE_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CONFIDENCES = ['high', 'medium', 'low'];

const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function nowIso(now) {
  return now ? String(now) : new Date().toISOString();
}

class ProvenanceMemory {
  constructor(file) {
    this.file = String(file);
    this.facts = ProvenanceMemory.read(this.file).facts;
  }

  static read(file) {
    try {
      const raw = fs.readFileSync(String(file), 'utf8');
      const value = JSON.parse(raw);
      return { facts: Array.isArray(value?.facts) ? value.facts : [] };
    } catch {
      return { facts: [] };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWriteText(this.file, JSON.stringify({ facts: this.facts }, null, 2) + '\n');
  }

  /** Add one fact. Returns the new fact. Throws on bad input or a full store. */
  addFact({ claim, source, confidence = 'medium', about = '', tags = [] } = {}) {
    const claimText = norm(claim);
    const sourceText = norm(source);
    if (!claimText) throw new Error('A fact needs a claim.');
    if (claimText.length > MAX_CLAIM_CHARS) throw new Error('A fact claim is capped at ' + MAX_CLAIM_CHARS + ' characters.');
    if (!sourceText) throw new Error('A fact needs its source (where it came from).');
    if (!CONFIDENCES.includes(confidence)) throw new Error('Confidence must be one of: ' + CONFIDENCES.join(', '));
    if (this.facts.length >= MAX_FACTS) throw new Error('Provenance memory is full (' + MAX_FACTS + ' facts); disable or forget some first.');
    const stamp = nowIso(null);
    const fact = {
      id: 'fact-' + crypto.randomBytes(4).toString('hex'),
      claim: claimText,
      source: sourceText.slice(0, 300),
      about: norm(about).slice(0, 300),
      tags: Array.isArray(tags) ? tags.map(t => norm(t)).filter(Boolean).slice(0, 10) : [],
      confidence,
      status: 'active',
      recordedAt: stamp,
      confirmedAt: stamp,
    };
    this.facts.push(fact);
    this.save();
    return fact;
  }

  _find(id) {
    const fact = this.facts.find(f => f.id === String(id));
    if (!fact) throw new Error('Unknown fact: ' + String(id));
    return fact;
  }

  /** Re-assert the fact is still true; resets the staleness clock. */
  confirm(id, { now = null } = {}) {
    const fact = this._find(id);
    fact.confirmedAt = nowIso(now);
    this.save();
    return fact;
  }

  setConfidence(id, level) {
    if (!CONFIDENCES.includes(level)) throw new Error('Confidence must be one of: ' + CONFIDENCES.join(', '));
    const fact = this._find(id);
    fact.confidence = level;
    this.save();
    return fact;
  }

  /** Soft-hide the fact; it stays on disk and can be re-activated. */
  disable(id) {
    const fact = this._find(id);
    fact.status = 'disabled';
    this.save();
    return fact;
  }

  enable(id) {
    const fact = this._find(id);
    fact.status = 'active';
    this.save();
    return fact;
  }

  /** Explicit, user-driven removal. */
  forget(id) {
    const index = this.facts.findIndex(f => f.id === String(id));
    if (index < 0) throw new Error('Unknown fact: ' + String(id));
    this.facts.splice(index, 1);
    this.save();
    return true;
  }

  list({ includeDisabled = false } = {}) {
    const facts = this.facts.filter(f => includeDisabled || f.status === 'active');
    return facts.slice().sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
  }

  /** Active facts whose last confirmation is older than the window. */
  stale({ now = null, maxAgeMs = STALE_DEFAULT_MS } = {}) {
    const nowMs = Date.parse(now || new Date().toISOString());
    if (Number.isNaN(nowMs)) throw new Error('Invalid "now".');
    return this.facts.filter(f => f.status === 'active' && nowMs - Date.parse(f.confirmedAt) > maxAgeMs);
  }

  /** Pairs of active facts about the same thing that disagree. */
  conflicts() {
    const normalizeClaim = c => norm(c).toLowerCase();
    const active = this.facts.filter(f => f.status === 'active' && f.about);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        if (a.about !== b.about) continue;
        if (normalizeClaim(a.claim) === normalizeClaim(b.claim)) continue;
        const key = [a.id, b.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ about: a.about, ids: [a.id, b.id] });
      }
    }
    return out;
  }
}

/**
 * The prompt block: header + one line per active fact, with a STALE marker
 * exactly for facts in memory.stale(). '' when there is nothing active.
 */
function renderMemoryBlock(memory, { now = null, maxAgeMs = STALE_DEFAULT_MS } = {}) {
  const facts = memory.list();
  if (!facts.length) return '';
  const staleIds = new Set(memory.stale({ now, maxAgeMs }).map(f => f.id));
  const lines = facts.map(f =>
    '- [' + f.confidence + '] ' + f.claim + ' (source: ' + f.source + '; confirmed ' + f.confirmedAt
    + (staleIds.has(f.id) ? '; STALE — verify before relying on it' : '') + ')'
  );
  const conflicts = memory.conflicts();
  const conflictLines = conflicts.map(c => 'CONFLICT about "' + c.about + '": facts ' + c.ids.join(' vs ') + ' disagree — confirm which is current.');
  return 'PROJECT FACTS (provenance-tracked; verify stale items before relying on them):\n'
    + lines.join('\n')
    + (conflictLines.length ? '\n' + conflictLines.join('\n') : '');
}

module.exports = { ProvenanceMemory, renderMemoryBlock, MAX_FACTS, MAX_CLAIM_CHARS, STALE_DEFAULT_MS };
