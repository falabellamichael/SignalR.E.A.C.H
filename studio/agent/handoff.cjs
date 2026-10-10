'use strict';

/* Reach Studio — structured crew handoffs (agentic capability 4).
 *
 * When one agent passes work to another, the relay currently carries free text,
 * so findings, evidence and open questions get lost or re-investigated. This
 * module defines the canonical handoff shape (goal, findings, evidence, files
 * touched, unresolved questions, suggested next step), renders it, and parses
 * it back out of a member's answer. TeamRunner uses parseHandoff() to
 * canonicalize chain relays: a structured answer is re-rendered in canonical
 * form, and an unstructured one passes through untouched, so existing crews
 * keep working unchanged.
 *
 * Pure and leaf: no I/O, no requires.
 */

const FIELDS = ['goal', 'findings', 'evidence', 'filesTouched', 'unresolved', 'nextStep'];
const REQUIRED = ['goal', 'nextStep'];
const MAX_FIELD = 2000;

const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Validate and normalize a handoff. `goal` and `nextStep` are required (a
 * handoff that says what came next is useless without the goal); the rest may
 * be empty, which is rendered explicitly so the receiver sees the absence.
 */
function buildHandoff(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('A handoff must be an object.');
  const out = {};
  for (const field of FIELDS) {
    const text = norm(record[field]);
    if (REQUIRED.includes(field) && !text) throw new Error(`A handoff needs its ${field === 'nextStep' ? 'next step' : field}.`);
    if (text.length > MAX_FIELD) throw new Error(`The handoff ${field} is too long (max ${MAX_FIELD} characters).`);
    out[field] = text;
  }
  out.from = norm(record.from) || 'crew member';
  out.to = norm(record.to) || 'next member';
  return out;
}

const HEADER = 'HANDOFF — from ' + '{from} to {to}';

/** The canonical rendering; chain relays carry this exact shape. */
function renderHandoff(handoff) {
  const h = buildHandoff(handoff);
  return HEADER.replace('{from}', h.from).replace('{to}', h.to) + '\n'
    + 'Goal: ' + h.goal + '\n'
    + 'Findings: ' + (h.findings || '(none)') + '\n'
    + 'Evidence: ' + (h.evidence || '(none)') + '\n'
    + 'Files touched: ' + (h.filesTouched || '(none)') + '\n'
    + 'Unresolved: ' + (h.unresolved || '(none)') + '\n'
    + 'Suggested next step: ' + h.nextStep;
}

const LINE = {
  goal: /^Goal: ?([^\r\n]*)$/m,
  findings: /^Findings: ?([^\r\n]*)$/m,
  evidence: /^Evidence: ?([^\r\n]*)$/m,
  filesTouched: /^Files touched: ?([^\r\n]*)$/m,
  unresolved: /^Unresolved: ?([^\r\n]*)$/m,
  nextStep: /^Suggested next step: ?([^\r\n]*)$/m,
};

/**
 * Extract a handoff from a member's answer text. `structured` is true only
 * when the canonical header AND both required sections are present; anything
 * else (including partial matches) returns { structured: false } so the relay
 * can pass the original text through unchanged.
 */
function parseHandoff(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const header = /^HANDOFF — from (.+?) to (.+?)(?:\n|$)/m.exec(raw);
  if (!header) return { structured: false };
  const fields = { from: norm(header[1]), to: norm(header[2]) };
  for (const field of FIELDS) {
    const match = LINE[field].exec(raw);
    fields[field] = match ? norm(match[1]) : '';
    if (!REQUIRED.includes(field) && fields[field] === '(none)') fields[field] = '';
  }
  if (!fields.goal || !fields.nextStep) return { structured: false };
  try {
    return { structured: true, handoff: buildHandoff(fields) };
  } catch {
    return { structured: false };
  }
}

module.exports = { buildHandoff, renderHandoff, parseHandoff, FIELDS, REQUIRED, MAX_FIELD };
