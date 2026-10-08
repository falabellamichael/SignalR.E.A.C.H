'use strict';

/* Reach Studio — independent counterfactual review.
 *
 * After an implementer finishes, a SEPARATE reviewer asks three questions the
 * implementer tends not to ask itself: how could this plausibly fail, what is
 * the simpler alternative, and which single test could disprove the approach.
 * The reviewer's findings are kept in their own envelope, never merged into
 * the implementer's explanation, and any disagreement between the two is
 * surfaced explicitly so the user decides.
 *
 * Pure leaf module: build the reviewer prompt, parse the reviewer's reply
 * into a fixed envelope, and diff it against the implementer's report to
 * surface disagreements. No model call lives here — the loop or a crew
 * member supplies the text, exactly like agent-run.cjs supplies the protocol
 * text.
 */

const MAX_FIELD = 2000;

const str = (value, max = MAX_FIELD) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/** The prompt sent to the independent reviewer. */
function reviewerPrompt({ goal, change, tests, implementerReport } = {}) {
  return [
    'You are an independent reviewer. A different agent implemented a change; you did not write it and you must not defend it.',
    '',
    `Task: ${str(goal, 500) || '(no goal stated)'}`,
    change ? `Change summary:\n${str(change)}` : null,
    tests ? `Tests reported:\n${str(tests, 1000)}` : null,
    implementerReport ? `Implementer's completion report:\n${str(implementerReport, 3000)}` : null,
    '',
    'Answer EXACTLY these three, in this fenced shape:',
    '```review',
    'failure_mode: one concrete, plausible way this change fails in production',
    'simpler_alternative: a simpler approach that still meets the goal (or "none")',
    'disproof_test: one test that, if run, could show this approach is wrong',
    '```',
  ].filter(Boolean).join('\n');
}

/**
 * Parse the reviewer's reply into the envelope. Tolerant of prose around the
 * fence, but strict inside it: all three fields must be present and non-empty
 * (except simpler_alternative, which may be "none").
 */
const REVIEW_LABELS = ['failure_mode', 'simpler_alternative', 'disproof_test'];

function parseReview(text) {
  const raw = String(text || '');
  const fence = /```(?:review)?\s*\n([\s\S]*?)```/.exec(raw);
  const body = fence ? fence[1] : raw;
  // A field runs from its label line to the next label line (or the end), so a
  // reviewer may continue a finding on the following line. Label positions are
  // measured explicitly rather than with `$`: with the multiline flag `$` also
  // matches at every line end, which would truncate a multi-line field.
  const labelAt = label => {
    const match = new RegExp(`^${label}:[ \\t]*`, 'm').exec(body);
    return match ? { index: match.index, after: match.index + match[0].length } : null;
  };
  const pick = label => {
    const start = labelAt(label);
    if (!start) return '';
    let end = body.length;
    for (const other of REVIEW_LABELS) {
      if (other === label) continue;
      const found = labelAt(other);
      if (found && found.index >= start.index && found.index < end) end = found.index;
    }
    return body.slice(start.after, end).trim().replace(/\s+/g, ' ');
  };
  const failureMode = pick('failure_mode');
  const simplerAlternative = pick('simpler_alternative');
  const disproofTest = pick('disproof_test');
  const envelope = { failureMode, simplerAlternative, disproofTest };
  const complete = !!(failureMode && disproofTest && (simplerAlternative || /none/i.test(simplerAlternative)));
  return { ...envelope, complete };
}

/**
 * Surface disagreements between the implementer's report and the reviewer's
 * envelope. A disagreement is any reviewer finding the implementer's report
 * does not already acknowledge (case-insensitive substring match on the key
 * terms) — the user is the one who has to reconcile them.
 */
function surfaceDisagreements(implementerReport, review) {
  const text = String(implementerReport || '').toLowerCase();
  const has = (s) => {
    const terms = String(s || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (!terms.length) return false;
    const hit = terms.filter(t => text.includes(t)).length;
    return hit / terms.length >= 0.5;
  };
  const disagreements = [];
  if (review.failureMode && !has(review.failureMode)) {
    disagreements.push({ kind: 'failure_mode', text: review.failureMode });
  }
  if (review.simplerAlternative && !/none/i.test(review.simplerAlternative) && !has(review.simplerAlternative)) {
    disagreements.push({ kind: 'simpler_alternative', text: review.simplerAlternative });
  }
  if (review.disproofTest && !has(review.disproofTest)) {
    disagreements.push({ kind: 'disproof_test', text: review.disproofTest });
  }
  return disagreements;
}

/** Render the review card, with disagreements called out at the top. */
function renderReview(review, disagreements = []) {
  const lines = ['COUNTERFACTUAL REVIEW'];
  if (disagreements.length) {
    lines.push(`DISAGREEMENTS with the implementer's report (${disagreements.length}):`);
    for (const d of disagreements) lines.push(`  - [${d.kind}] ${d.text}`);
    lines.push('The implementer did not acknowledge these — the user must decide.');
  }
  lines.push(`Failure mode: ${review.failureMode || '(not stated)'}`);
  lines.push(`Simpler alternative: ${review.simplerAlternative || '(not stated)'}`);
  lines.push(`Disproof test: ${review.disproofTest || '(not stated)'}`);
  return lines.join('\n');
}

module.exports = { reviewerPrompt, parseReview, surfaceDisagreements, renderReview };
