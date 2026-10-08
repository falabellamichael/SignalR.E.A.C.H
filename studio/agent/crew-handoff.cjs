'use strict';

/* Reach Studio — structured crew handoffs.
 *
 * When one agent hands work to a teammate, the handoff should carry the same
 * shape every time: the goal, what was found, the evidence behind it, the
 * files touched, what is still open, and the suggested next step. Free-form
 * chat summaries lose half of that; a fixed envelope makes the receiving
 * agent's first turn cheaper and makes "what did I inherit" answerable.
 *
 * Pure leaf module: normalise + validate + render + parse. The crew's
 * existing transport (team-message.cjs) is unchanged — a handoff is just a
 * message whose body is a fenced HANDOFF block, and `parseHandoff` recovers
 * the envelope from a peer's text so the recipient (or the UI) can render
 * the structured card instead of a wall of prose.
 */

const MAX_SECTION = 2000;
const MAX_FILES = 50;
const MAX_ITEMS = 50;

const str = (value, max = MAX_SECTION) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const list = (value, max = MAX_ITEMS) => {
  if (!Array.isArray(value)) return [];
  return value.map(item => str(item, MAX_SECTION)).filter(Boolean).slice(0, max);
};

/**
 * Normalise arbitrary input into a handoff envelope. Every section is
 * optional EXCEPT goal — a handoff without a goal is a forwarded message,
 * not a handoff, and `validateHandoff` says so.
 */
function normalizeHandoff(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    from: str(input.from, 200),
    to: str(input.to, 200),
    goal: str(input.goal),
    findings: list(input.findings),
    evidence: list(input.evidence),
    filesTouched: (Array.isArray(input.filesTouched) ? input.filesTouched : [])
      .map(f => (typeof f === 'string' ? f : f && typeof f === 'object' ? str(f.path || f.file, 500) : ''))
      .filter(Boolean).slice(0, MAX_FILES),
    unresolved: list(input.unresolved),
    nextStep: str(input.nextStep),
  };
}

function validateHandoff(handoff) {
  const errors = [];
  const h = normalizeHandoff(handoff);
  if (!h.goal) errors.push('A handoff needs a goal: what is the receiving agent supposed to accomplish?');
  if (!h.nextStep) errors.push('A handoff needs a suggested next step for the receiving agent.');
  return { ok: errors.length === 0, errors, handoff: h };
}

/** Render the envelope as the fenced block that travels inside a crew message. */
function renderHandoff(handoff) {
  const h = normalizeHandoff(handoff);
  const section = (title, items) => items.length
    ? `${title}\n${items.map(i => `- ${i}`).join('\n')}`
    : null;
  const body = [
    h.goal ? `Goal: ${h.goal}` : null,
    section('Findings', h.findings),
    section('Evidence', h.evidence),
    section('Files touched', h.filesTouched),
    section('Unresolved', h.unresolved),
    h.nextStep ? `Next step: ${h.nextStep}` : null,
  ].filter(Boolean).join('\n');
  const header = (h.from || h.to) ? `HANDOFF ${h.from ? `from ${h.from}` : ''} ${h.to ? `to ${h.to}` : ''}`.trim() : 'HANDOFF';
  return '```handoff\n' + JSON.stringify(h) + '\n```\n' + header + '\n' + body;
}

/**
 * Recover a handoff envelope from a peer's free text. Accepts the fenced
 * JSON form produced by renderHandoff; when only the prose sections are
 * present, the labelled sections are parsed best-effort. Returns null when
 * the text carries no handoff at all.
 */
function parseHandoff(text) {
  const raw = String(text || '');
  const fence = /```handoff\s*\n([\s\S]*?)```/.exec(raw);
  if (fence) {
    try {
      const value = JSON.parse(fence[1]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeHandoff(value);
    } catch { /* fall through to the prose parse */ }
  }
  if (!/HANDOFF|goal:|next step:/i.test(raw)) return null;
  const pick = label => {
    const match = new RegExp(`^${label}:[ \\t]*(.+)$`, 'mi').exec(raw);
    return match ? match[1].trim() : '';
  };
  const bullets = label => {
    const re = new RegExp(`^${label}\\s*\\n((?:\\s*[-*][ \\t]*.+$\\n?)+)`, 'mi');
    const match = re.exec(raw);
    return match ? match[1].trim().split('\n').map(l => l.replace(/^\s*[-*][ \t]*/, '').trim()).filter(Boolean) : [];
  };
  const goal = pick('Goal');
  if (!goal && !bullets('Findings').length && !pick('Next step')) return null;
  return normalizeHandoff({
    goal,
    findings: bullets('Findings'),
    evidence: bullets('Evidence'),
    filesTouched: bullets('Files touched'),
    unresolved: bullets('Unresolved'),
    nextStep: pick('Next step'),
  });
}

module.exports = { normalizeHandoff, validateHandoff, renderHandoff, parseHandoff };
