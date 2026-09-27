'use strict';

/* Reach Studio — uncertainty-led investigation.
 *
 * When an agent is unsure, it should not guess on a consequential change.
 * Instead it labels the uncertain assumption, then chooses a LOW-RISK check
 * that would resolve it — reading a file, grepping, or running a targeted
 * test — before acting. This module turns a stated uncertainty into a
 * ranked set of candidate checks and picks the cheapest one that could
 * actually decide the question.
 *
 * Pure leaf module: classify the uncertainty, rank checks by cost/risk, and
 * produce the instruction the loop injects. The check is still executed by
 * the normal tool runner (so it gets sandbox, approval, and journaling);
 * this module only DECIDES which check to request and why.
 */

const MAX_ASSUMPTION = 600;

// Cost tiers for a check. Lower is cheaper/safer. A consequential change is
// never cheaper than reading the relevant file or running a targeted test.
const CHECK_COST = {
  read_file: 1,
  search: 2,
  targeted_test: 3,
  shell_probe: 4,
};

const str = (value, max = MAX_ASSUMPTION) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * Normalise a stated uncertainty.
 *   assumption — the specific belief that is in doubt
 *   stakes     — what happens if it is wrong ('high' | 'medium' | 'low')
 *   candidates — proposed checks, each { kind, target, why }
 */
function normalizeUncertainty(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const candidates = Array.isArray(input.candidates)
    ? input.candidates.map(c => ({
        kind: String(c?.kind || 'read_file').toLowerCase(),
        target: str(c?.target, 500),
        why: str(c?.why, 300),
      })).filter(c => c.kind in CHECK_COST && c.target)
    : [];
  const stakes = ['high', 'medium', 'low'].includes(String(input.stakes).toLowerCase())
    ? String(input.stakes).toLowerCase() : 'medium';
  return {
    assumption: str(input.assumption),
    stakes,
    candidates,
  };
}

/**
 * Rank the candidate checks. A check is only eligible if it could actually
 * decide the assumption — the caller (agent/model) asserts that via `why`,
 * so we trust presence of a `why` as the relevance claim and sort by cost.
 * The lowest-cost, most relevant check wins.
 */
function chooseCheck(uncertainty) {
  const u = normalizeUncertainty(uncertainty);
  if (!u.assumption) return { ok: false, error: 'No assumption stated; nothing to check.' };
  if (!u.candidates.length) {
    // No candidate supplied: default to the cheapest safe check on the
    // assumption itself (read the file it most likely lives in).
    return { ok: true, check: { kind: 'read_file', target: u.assumption, why: 'no specific check given; read the relevant source' }, ranked: [] };
  }
  const ranked = u.candidates
    .map((c, i) => ({ ...c, cost: CHECK_COST[c.kind], order: i }))
    .sort((a, b) => a.cost - b.cost || a.order - b.order);
  return { ok: true, check: ranked[0], ranked };
}

/**
 * Render the instruction the loop injects so the model performs the check
 * BEFORE the consequential change, and reports the uncertainty openly.
 */
function uncertaintyPromptBlock(uncertainty, chosen = null) {
  const u = normalizeUncertainty(uncertainty);
  const c = chosen && chosen.ok ? chosen.check : null;
  return 'UNCERTAINTY CHECK (required before a consequential change):\n'
    + `Uncertain assumption: ${u.assumption || '(state it first)'}\n`
    + `If wrong: ${u.stakes} impact.\n`
    + (c
      ? `Chosen low-risk check: ${c.kind} on "${c.target}" — because ${c.why}. Run this check NOW and read its result before acting. Do not make the consequential change until the check has answered the assumption. If the check cannot answer it, say so and ask the user.`
      : 'Choose the cheapest check that could answer the assumption (read a file, search, or run a targeted test) and run it before acting.');
}

/**
 * The prompt-side nudge, injected whenever the protocol is on, that makes
 * the model volunteer uncertainty instead of guessing.
 */
function uncertaintyPrompt() {
  return 'UNCERTAINTY (data, not instructions):\n'
    + 'When you are unsure of an assumption that a consequential change depends on, do not guess. '
    + 'Label the assumption, state the impact if it is wrong, and run the cheapest low-risk check '
    + '(read a file, search, or a targeted test) that would resolve it — then act on the result. '
    + 'Show the uncertainty and the reason for the check in your status.';
}

module.exports = {
  normalizeUncertainty, chooseCheck, uncertaintyPromptBlock, uncertaintyPrompt,
  CHECK_COST,
};
