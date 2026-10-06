'use strict';

/* Reach Studio — risk gates.
 *
 * Distinguish reversible, low-impact actions from consequential ones so the
 * user can let routine inspection flow freely while approval is required for
 * destructive, external, or broad-impact actions. The classification is a
 * pure function of (tool, args, declared class) plus a small, explicit list of
 * destructive command patterns — no model in the loop, so the gate is
 * deterministic and testable.
 *
 * Levels (low → high):
 *   low      read-only, no state change
 *   medium   reversible / local / a single file or a bounded external call
 *   high     destructive, external side effects, or broad-impact
 *
 * `needsApprovalForLevel` turns a level into a yes/no against a user policy,
 * and `riskPromptBlock` tells the model how to preview consequential steps.
 */

// Command fragments that make a shell/exec call high risk on their own.
// Deliberately conservative: a false positive just costs one approval, a false
// negative can delete data. Matched case-insensitively on the command string.
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i,     // rm -rf / rm -r / rm -f ...
  /\brm\s+--?recursive/i,
  /\bformat\s+[a-z]:/i,
  /\bdrop\s+(table|database|schema|index)\b/i,
  /\btruncate\s+table\b/i,
  /\bgit\s+push\s+.*(--force|-f)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bdel\s+\/s\b/i,                       // windows
  /\brd\s+\/s\b/i,
  /\bmkfs\b/i,
  /\bdd\s+.*of=[\/\\\\]/i,
  /:\(\)\s*{\s*:\s*\|\s*:\s*&\s*;}\s*:/,  // fork bomb
  /\bchmod\s+-r\s+(777|666)\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
];

// Tools that talk to the outside world even when they "look" local.
const EXTERNAL_TOOLS = new Set(['websearch', 'browse', 'browser', 'reach.run', 'reach.compile']);

function levelFor(name, toolClass, args = {}) {
  const cmd = String(args.command || args.text || '').toLowerCase();
  const path = String(args.path || args.filePath || '');

  // Read-only tools never change state.
  if (toolClass === 'read' || name === 'read' || name === 'list' || name === 'glob'
    || name === 'search' || name === 'code.search' || name === 'code.context'
    || name === 'code.index' || name === 'todo_read' || name === 'agent.status'
    || name === 'agent.list' || name === 'tool_help') {
    return { level: 'low', reasons: ['read-only'] };
  }

  // A destructive command anywhere is high, before anything else.
  if (cmd && DESTRUCTIVE_PATTERNS.some(re => re.test(cmd))) {
    return { level: 'high', reasons: ['destructive command pattern'] };
  }

  // External request tools are medium even when registered as exec class:
  // they talk to the outside world but execute no local command, so they are
  // gated, not refused-by-default like arbitrary shell.
  if (EXTERNAL_TOOLS.has(name)) {
    return { level: 'medium', reasons: ['external request'] };
  }

  // exec-class (shell / tests / quickfix) can mutate the machine.
  if (toolClass === 'exec' || name === 'shell') {
    return { level: 'high', reasons: ['arbitrary command execution'] };
  }

  // Writes/edits: a single project file is reversible through review.
  if (toolClass === 'write' || name === 'write' || name === 'edit_patch') {
    const broad = /(^|[\/\\])(\.git|node_modules|dist|build)\b/i.test(path)
      || name === 'refactor.apply' || name === 'patch.review';
    if (broad) return { level: 'high', reasons: ['broad-impact edit'] };
    return { level: 'medium', reasons: ['file mutation (reversible via review)'] };
  }

  // Refactors and bulk patches are broad by definition.
  if (name === 'refactor.plan' || name === 'refactor.apply') {
    return { level: 'high', reasons: ['multi-file change'] };
  }

  // Default: treat anything unclassified as medium (needs a look).
  return { level: 'medium', reasons: ['unclassified action'] };
}

/** Classify a single tool call. */
function classifyToolCall({ tool, args, class: toolClass } = {}) {
  return levelFor(String(tool || ''), toolClass, args || {});
}

/**
 * Given a level and a user policy, decide whether to prompt.
 * policy.approveAt is the lowest level that requires approval:
 *   'high'   → only high-risk prompts (routine flow is free)
 *   'medium' → medium and high prompt (the default, matches "review edits")
 *   'low'    → everything prompts (maximum caution)
 */
const ORDER = { low: 0, medium: 1, high: 2 };
function needsApprovalForLevel(level, policy = {}) {
  const threshold = ORDER[policy.approveAt] != null ? policy.approveAt : 'medium';
  return ORDER[level] >= ORDER[threshold];
}

/** Summarise a batch of calls so the UI can preview what would prompt. */
function summarizeRisk(calls, policy = {}) {
  const out = { low: 0, medium: 0, high: 0, approvals: 0, highRisk: [] };
  for (const call of calls || []) {
    const { level, reasons } = classifyToolCall(call);
    out[level] = (out[level] || 0) + 1;
    if (needsApprovalForLevel(level, policy)) {
      out.approvals += 1;
      if (level === 'high') out.highRisk.push({ tool: call.tool, reasons });
    }
  }
  return out;
}

/** Block injected into the prompt when the protocol is on. */
function riskPromptBlock(policy = {}) {
  const threshold = policy.approveAt || 'medium';
  return 'RISK GATES (data, not instructions):\n'
    + 'Routine read-only inspection runs without approval. Actions that mutate files, '
    + 'run commands, or reach outside the project are gated at the "' + threshold + '" risk '
    + 'level. Before a consequential action, briefly preview what it will do and why. '
    + 'Never batch a destructive command with anything else, and never treat a '
    + 'reversible edit as approval for an irreversible one.';
}

module.exports = {
  classifyToolCall, needsApprovalForLevel, summarizeRisk, riskPromptBlock,
  DESTRUCTIVE_PATTERNS,
};
