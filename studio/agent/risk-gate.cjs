'use strict';

/* Reach Studio — risk levels and risk gates (agentic capability 2).
 *
 * The engine already has approval modes, a command sandbox, and edit review;
 * what was missing is the distinction between REVERSIBLE, LOW-IMPACT actions
 * and CONSEQUENTIAL ones, and a user-controlled gate that makes high-impact
 * actions prompt even when the user chose auto-approve. The classifier is a
 * pure function of the tool's registry class, so it cannot drift from the
 * approval logic: read → low, browse and write → medium, exec → high.
 *
 * `riskGates: true` in the agent's settings opts into the strict gate: any
 * high-impact call (shell, reach.*, tests.*, …) requires an explicit user
 * decision even under `approvals: 'auto-all'`. The gate is additive — it can
 * only add prompts, never remove them — so enabling it cannot widen the
 * agent's powers, only narrow them.
 *
 * Pure and leaf: no I/O, no requires (the tool record is passed in).
 */

const LEVELS = ['low', 'medium', 'high'];

/**
 * Classify one tool call. Unknown tools fail closed to 'high': a tool the
 * classifier cannot judge must be treated as the riskiest kind it could be.
 */
function riskLevel(tool, args = {}, settings = {}) {
  if (!tool || typeof tool !== 'object') return 'high';
  const level = tool.class === 'read' ? 'low'
    : tool.class === 'exec' ? 'high'
      : tool.class === 'browse' || tool.class === 'write' ? 'medium'
        : 'high';
  // A tool that asks for approval by definition is never low-impact.
  if (tool.approval === true && level === 'low') return 'medium';
  return level;
}

/** True when the user's risk gate forces a prompt for this call. */
function gateRequired(level, settings = {}) {
  return !!settings && settings.riskGates === true && level === 'high';
}

/** Short label for prompts and audit records. */
function riskLabel(level) {
  return level === 'low' ? 'low-impact, reversible'
    : level === 'medium' ? 'moderate (workspace or external effect)'
      : 'high-impact (runs a command or tool with broad reach)';
}

module.exports = { riskLevel, gateRequired, riskLabel, LEVELS };
