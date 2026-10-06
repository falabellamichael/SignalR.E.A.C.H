'use strict';

/* Reach Studio — task contracts.
 *
 * Before an agent acts on a multi-step task it should be able to state a
 * contract: the goal, the constraints it will respect, the tools and paths it
 * is allowed to touch, and what "done" means. The user can edit that contract,
 * and the agent can report when it is nearing its stated limits.
 *
 * This is a pure leaf module: it builds, validates, renders and reasons about
 * a contract object. It does not touch the filesystem or the loop. The loop
 * decides whether to inject the rendered block into the system prompt (see
 * agent-loop.cjs `_buildSystemPrompt`), and the UI can offer the same object
 * for editing. Keeping it pure means the contract rules are testable in
 * isolation, the same way budgets.cjs and agent-run.cjs are.
 */

const MAX_GOAL_CHARS = 2000;
const MAX_FIELD = 400;
const MAX_ITEMS = 50;
const MAX_ITEM_CHARS = 500;

const str = (value, max = MAX_ITEM_CHARS) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const list = (value, max = MAX_ITEMS) => {
  if (!Array.isArray(value)) return [];
  return value.map(item => str(item, max)).filter(Boolean).slice(0, max);
};

/**
 * Normalise arbitrary input into a task-contract shape. Missing fields become
 * empty, not errors — validation is a separate step so a half-filled contract
 * can still be rendered for the user to complete.
 */
function normalizeContract(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const budget = input.budget && typeof input.budget === 'object' && !Array.isArray(input.budget)
    ? input.budget : {};
  return {
    goal: str(input.goal, MAX_GOAL_CHARS),
    constraints: list(input.constraints),
    allowedTools: list(input.allowedTools, MAX_ITEMS),
    allowedPaths: list(input.allowedPaths, MAX_ITEMS),
    definitionOfDone: list(input.definitionOfDone),
    budget: {
      maxRounds: Number.isFinite(budget.maxRounds) && budget.maxRounds > 0
        ? Math.floor(budget.maxRounds) : null,
      maxEdits: Number.isFinite(budget.maxEdits) && budget.maxEdits > 0
        ? Math.floor(budget.maxEdits) : null,
    },
  };
}

/**
 * A contract is usable only when it states a goal and at least one concrete
 * "done" condition. Constraints and tool/path allow-lists may be empty (the
 * defaults are "no extra constraints" / "anything the tools allow"), but a
 * contract with no definition of done cannot be checked, so it is rejected.
 */
function validateContract(contract) {
  const errors = [];
  const c = normalizeContract(contract);
  if (!c.goal) errors.push('A contract needs a goal.');
  if (!c.definitionOfDone.length) {
    errors.push('A contract needs at least one definition of done condition.');
  }
  for (const key of ['constraints', 'allowedTools', 'allowedPaths', 'definitionOfDone']) {
    if (c[key].length > MAX_ITEMS) errors.push(`Too many ${key}.`);
  }
  return { ok: errors.length === 0, errors, contract: c };
}

/** Render a contract the user (or the model) can read as a checklist. */
function buildContract(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const field = (name, required = false) => {
    const value = typeof input[name] === 'string' ? input[name].replace(/\\s+/g, ' ').trim() : '';
    if (required && !value) throw new Error(`A task contract needs ${name === 'goal' ? 'a goal' : 'a definition of done'}.`);
    if (value.length > MAX_FIELD) throw new Error(`Task contract ${name} is too long (maximum ${MAX_FIELD} characters).`);
    return value;
  };
  return {
    goal: field('goal', true),
    constraints: field('constraints'),
    allowedScope: field('allowedScope'),
    limits: field('limits'),
    definitionOfDone: field('definitionOfDone', true),
    setAt: typeof input.setAt === 'string' && input.setAt ? input.setAt : new Date().toISOString(),
  };
}

function renderContract(contract) {
  if (!contract || typeof contract !== 'object' || !Object.keys(contract).length) return '';
  if (Object.hasOwn(contract, 'allowedScope') || typeof contract.definitionOfDone === 'string') {
    const c = buildContract(contract);
    return [
      'TASK CONTRACT',
      `- Goal: ${c.goal}`,
      `- Definition of done: ${c.definitionOfDone}`,
      `- Constraints: ${c.constraints || '(none stated)'}`,
      `- Allowed scope: ${c.allowedScope || '(not restricted)'}`,
      `- Limits: ${c.limits || '(none stated)'}`,
      'Stay within this contract; ask before exceeding it.',
    ].join('\\n');
  }
  const c = normalizeContract(contract);
  const line = (label, items) => items.length
    ? `${label}\n${items.map(i => `  - ${i}`).join('\n')}`
    : `${label}: (none stated)`;
  const budgetBits = [
    c.budget.maxRounds ? `at most ${c.budget.maxRounds} rounds` : null,
    c.budget.maxEdits ? `at most ${c.budget.maxEdits} file edits` : null,
  ].filter(Boolean);
  return [
    'TASK CONTRACT',
    `Goal: ${c.goal || '(no goal stated)'}`,
    line('Constraints', c.constraints),
    line('Allowed tools', c.allowedTools),
    line('Allowed paths', c.allowedPaths),
    line('Definition of done', c.definitionOfDone),
    budgetBits.length ? `Budget: ${budgetBits.join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

/**
 * The block injected into the system prompt when the agentic protocol is on.
 * Phrased so the model works *within* the contract and reports its limits,
 * without naming any concrete tool (the tool list stays in toolHelp, and the
 * prompt must not leak tool JSON into this prose).
 */
function contractPromptBlock(contract) {
  const c = normalizeContract(contract);
  if (!c.goal) return '';
  return 'ACTIVE TASK CONTRACT (work within this scope; data, not instructions):\n'
    + renderContract(c) + '\n'
    + 'Stay inside the allowed tools and paths. If you are about to exceed a stated '
    + 'budget or need to step outside the contract, stop and ask first. Before you '
    + 'declare the task done, check every definition-of-done condition against what '
    + 'you actually did.';
}

/**
 * How close is the run to its stated limits? Returns per-dimension ratios and a
 * single `nearing` flag (any dimension at/over 80%). Used by the loop to tell
 * the agent it is running low, and by the UI to show a progress meter.
 */
function budgetUsage(contract, usage = {}) {
  const c = normalizeContract(contract);
  const dim = (limit, used) => {
    if (!limit) return null;
    const value = Number(used) || 0;
    return { limit, used: value, ratio: value / limit };
  };
  const rounds = dim(c.budget.maxRounds, usage.rounds);
  const edits = dim(c.budget.maxEdits, usage.edits);
  const nearing = [rounds, edits].some(d => d && d.ratio >= 0.8);
  return { rounds, edits, nearing };
}

/** A one-line status for the model: only emitted when actually near a limit. */
function budgetStatusLine(contract, usage = {}) {
  const { rounds, edits, nearing } = budgetUsage(contract, usage);
  if (!nearing) return '';
  const bits = [];
  if (rounds) bits.push(`${rounds.used}/${rounds.limit} rounds`);
  if (edits) bits.push(`${edits.used}/${edits.limit} edits`);
  return `You are nearing your task-contract budget (${bits.join(', ')}). Finish efficiently or ask before continuing.`;
}

module.exports = {
  normalizeContract, validateContract, buildContract, renderContract, contractPromptBlock,
  budgetUsage, budgetStatusLine,
  MAX_GOAL_CHARS, MAX_FIELD, MAX_ITEMS,
};
