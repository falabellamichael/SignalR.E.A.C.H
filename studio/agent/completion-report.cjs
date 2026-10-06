'use strict';

/* Reach Studio — evidence-based completion.
 *
 * An agent's final answer must separate what it VERIFIED from what it ASSUMED
 * or merely PLANNED. A completion report cites the concrete evidence that
 * exists for the run — tool results, edits and their verdicts, test outcomes —
 * so a "done" claim can be checked instead of trusted.
 *
 * Pure leaf module. The loop already journals every tool call with argument
 * and result digests (agent-tool-runner.cjs → crew-journal.cjs) and records
 * edit verdicts; this module reads those records and builds the report. It
 * never invents evidence: a claim without a matching record is listed under
 * "unverified", which is the whole point.
 */

const EVIDENCE_KINDS = ['read', 'shell', 'write', 'edit', 'test', 'other'];

function isEvidenceArray(items) {
  return Array.isArray(items);
}

/* Map a raw journal evidence record (agent-tool-runner's shape) into a report
 * item. The journal stores digests, not bodies — that is intentional: the
 * report says WHAT ran and whether it succeeded, not the whole output. */
function normalizeEvidence(record, index = 0) {
  const tool = String(record.tool || 'unknown');
  return {
    id: `e${index + 1}`,
    tool,
    kind: /(^|\.)test|tests\.run|npm test|pytest|vitest|jest/i.test(tool + ' ' + String(record.command || '')) ? 'test'
      : tool === 'read' ? 'read'
        : tool === 'write' || tool === 'edit_patch' || tool === 'edit' ? 'edit'
          : tool === 'shell' ? 'shell' : 'other',
    path: String(record.path || ''),
    ok: !!record.ok,
    pending: !!record.pending,
    decision: record.decision || null,   // 'accepted' | 'declined' from the ledger
    note: record.error ? String(record.error).slice(0, 200) : null,
  };
}

/**
 * Build a completion report.
 *
 *   claims  — what the agent says it did (strings or { text, evidence: id[] })
 *   evidence — journal records for this agent (CrewJournal#evidence shape)
 *
 * Every claim is checked: a claim names evidence (by id or by tool/path match)
 * only if a matching record exists with ok !== false; otherwise it lands in
 * `unverified`. A claim can also cite an edit by path — an edit whose verdict
 * was 'declined' is NEVER counted as evidence for the claim.
 */
function buildCompletionReport(claims = [], evidence = []) {
  if (!isEvidenceArray(claims)) claims = [];
  if (!isEvidenceArray(evidence)) evidence = [];

  const items = evidence.map(normalizeEvidence);
  const tests = items.filter(i => i.kind === 'test');
  const edits = items.filter(i => i.kind === 'edit');
  const reads = items.filter(i => i.kind === 'read');
  const shells = items.filter(i => i.kind === 'shell');

  const matched = new Set();
  const verified = [];
  const unverified = [];
  const failed = [];

  const claimItems = claims.map(c => (typeof c === 'string' ? { text: c, evidence: [] } : c));
  for (const claim of claimItems) {
    const text = String(claim.text || '').slice(0, 500);
    if (!text.trim()) continue;
    const cited = Array.isArray(claim.evidence) ? claim.evidence : [];
    // A claim matches an evidence record when it CITES it (by id, tool, or path)
    // OR, for a plain string claim, when the record's path appears in the claim
    // text. Matching is per-claim: one record may back several claims, but only
    // while it is real, successful, and not an edit whose verdict was declined.
    const lower = text.toLowerCase();
    const hits = items.filter((item, index) => {
      if (matched.has(index)) return false;
      if (item.ok === false) return false;
      if (item.decision === 'declined') return false;   // a refused edit proves nothing
      const citedHit = cited.some(ref => ref === item.id
        || (ref && item.tool && String(ref).toLowerCase().includes(item.tool.toLowerCase()))
        || (ref && item.path && String(ref).toLowerCase().includes(item.path.toLowerCase())));
      const pathHit = !cited.length && item.path && lower.includes(item.path.toLowerCase());
      return citedHit || pathHit;
    });
    if (hits.length) {
      for (const hit of hits) matched.add(items.indexOf(hit));
      verified.push({ text, evidence: hits.map(h => h.id) });
    } else {
      // A failed matching record is stronger than none: it actively disproves.
      const disproven = items.find(item => item.ok === false && (
        item.path && text.toLowerCase().includes(item.path.toLowerCase())
      ));
      if (disproven) failed.push({ text, contradictedBy: disproven.id });
      else unverified.push({ text, reason: 'no matching tool result, test run, or accepted edit in the journal' });
    }
  }

  const testsPassed = tests.filter(t => t.ok).length;
  const testsFailed = tests.filter(t => t.ok === false).length;
  const editsAccepted = edits.filter(e => e.decision === 'accepted' || (e.ok && e.decision !== 'declined')).length;
  const editsDeclined = edits.filter(e => e.decision === 'declined').length;
  // Readiness hinges on the CLAIMS: an unrelated declined edit is surfaced in the
  // summary but does not make this run "not done". A failed TEST does, because it
  // is direct counter-evidence for the whole change, not for one specific claim.
  const ready = unverified.length === 0 && failed.length === 0
    && testsFailed === 0 && verified.length > 0;

  return {
    ready,
    verified,
    unverified,
    failed,
    evidence: items,
    summary: {
      evidenceCount: items.length,
      testsRun: tests.length,
      testsPassed,
      testsFailed,
      editsProposed: edits.length,
      editsAccepted,
      editsDeclined,
      reads: reads.length,
      shells: shells.length,
    },
  };
}

/** Render the report as the user-facing completion card text. */
function renderCompletionReport(report) {
  const s = report.summary;
  const lines = ['COMPLETION REPORT',
    `Evidence on record: ${s.evidenceCount} tool result(s) — ${s.testsRun} test run(s) ${s.testsPassed} passed, ${s.testsFailed} failed; `
    + `${s.editsProposed} edit(s) ${s.editsAccepted} accepted, ${s.editsDeclined} declined; ${s.reads} read(s), ${s.shells} shell command(s).`];
  if (report.verified.length) {
    lines.push('', 'Verified claims:');
    for (const v of report.verified) lines.push(`  - ${v.text} [${v.evidence.join(', ')}]`);
  }
  if (report.unverified.length) {
    lines.push('', 'NOT verified (claimed but no evidence found):');
    for (const u of report.unverified) lines.push(`  - ${u.text}`);
  }
  if (report.failed.length) {
    lines.push('', 'Contradicted by evidence:');
    for (const f of report.failed) lines.push(`  - ${f.text} (see ${f.contradictedBy})`);
  }
  lines.push('', report.ready
    ? 'Verdict: every claim has evidence and no test or edit stands against it.'
    : 'Verdict: do not treat this run as done — resolve the unverified or contradicted items first.');
  return lines.join('\n');
}

/**
 * The prompt-side half: the instruction block that makes the model produce
 * claims with citations. Injected when the agentic protocol is on.
 */
function completionPromptBlock() {
  return 'EVIDENCE-BASED COMPLETION (required before you finish):\n'
    + 'Before declaring the task complete, list each claim you are making and the '
    + 'tool result, test run, or accepted edit that proves it. A claim without a '
    + 'matching tool result, test, or accepted edit in this conversation is NOT done: '
    + 'either run the check or label it as an assumption. Separate "verified" from '
    + '"assumed" in your final answer. Never count a failed test or a declined edit '
    + 'as evidence of success.';
}

function buildReport(input = {}) {
  const normalize = value => {
    const text = String(value || '').replace(/\\s+/g, ' ').trim();
    if (text.length > 400) throw new Error('Report field is too long.');
    return text;
  };
  const summary = normalize(input.summary);
  if (!summary) throw new Error('Completion report needs a summary.');
  if (!Array.isArray(input.verified) || input.verified.length === 0) throw new Error('Completion report needs at least one verified item.');
  const verified = input.verified.slice(0, 50).map(item => typeof item === 'string'
    ? { what: normalize(item), evidence: '' }
    : { what: normalize(item?.what), evidence: normalize(item?.evidence) });
  const assumptions = Array.isArray(input.assumptions) ? input.assumptions.slice(0, 50).map(normalize).filter(Boolean) : [];
  const remaining = Array.isArray(input.remaining) ? input.remaining.slice(0, 50).map(normalize).filter(Boolean) : [];
  if (verified.some(item => !item.what)) throw new Error('Verified items need a description.');
  return { summary, verified, assumptions, remaining };
}

function renderReport(report) {
  const r = buildReport(report);
  return ['COMPLETION REPORT', `Summary: ${r.summary}`, '', 'Verified:',
    ...r.verified.map(item => `- ${item.what}${item.evidence ? ` — evidence: ${item.evidence}` : ' — evidence: (not independently verified)'}`),
    '', 'Assumptions:', ...(r.assumptions.length ? r.assumptions.map(item => `- ${item}`) : ['- none declared']),
    '', 'Remaining:', ...(r.remaining.length ? r.remaining.map(item => `- ${item}`) : ['- none known']),
  ].join('\\n');
}

function gradeCompletion(text) {
  const value = String(text || '');
  return {
    claimsDone: /\\b(done|complete(?:d)?|finished|works?)\\b/i.test(value),
    citesEvidence: /(?:\\b(?:npm|node|pytest|vitest|jest)\\b|\\btest(?:s)?\\b|→\\s*\\d+|\\bdiff\\b|\\.c?js\\b|\\.py\\b)/i.test(value),
  };
}

module.exports = {
  buildCompletionReport, renderCompletionReport, completionPromptBlock,
  normalizeEvidence, EVIDENCE_KINDS,
  buildReport, renderReport, gradeCompletion,
};
