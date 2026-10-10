'use strict';

/* Reach Studio — uncertainty tracking (agentic capability 10).
 *
 * When an agent is unsure, it records the assumption, WHY it matters, and the
 * low-risk check it plans (read a file, run a targeted test). The open list is
 * rendered into the system prompt, so the model cannot quietly forget what it
 * is still guessing. Taking ANY tool action afterwards marks the assumption
 * "checked" — the record tool enforces that the check actually happens rather
 * than the assumption simply evaporating.
 *
 * Pure and leaf: state lives in the agent record the caller passes in
 * (agentStore.setRunState), which works for the durable chat store and the
 * crew's ephemeral MemoryStore alike.
 */

const MAX_OPEN = 5;
const MAX_TEXT = 300;

const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function openItems(runState) {
  const items = Array.isArray(runState?.uncertainties) ? runState.uncertainties : [];
  return items.filter(item => item && item.status === 'open');
}

/**
 * Record one uncertain assumption. Returns the agent record.
 * Every previously open item must have been checked since it was recorded, so
 * the agent cannot accumulate a wall of unverified guesses.
 */
function recordUncertainty(agentStore, agentId, { assumption, reason, check }) {
  const assumptionText = norm(assumption);
  const reasonText = norm(reason);
  const checkText = norm(check);
  if (!assumptionText) throw new Error('An uncertainty needs the assumption text.');
  if (!reasonText) throw new Error('An uncertainty needs the reason it matters.');
  if (!checkText) throw new Error('An uncertainty needs the planned low-risk check.');
  for (const text of [assumptionText, reasonText, checkText]) {
    if (text.length > MAX_TEXT) throw new Error('Uncertainty fields are capped at 300 characters.');
  }
  const record = agentStore.get(agentId);
  const runState = { ...(record?.runState || {}) };
  const items = Array.isArray(runState.uncertainties) ? runState.uncertainties.map(i => ({ ...i })) : [];
  const open = openItems(runState);
  if (open.length) {
    throw new Error(`Resolve the ${open.length} open uncertaint${open.length === 1 ? 'y' : 'ies'} first `
      + '(tool: "uncertainty", op: "resolve", id: ' + open[0].id + ').');
  }
  if (items.filter(i => i.status === 'resolved').length >= MAX_OPEN) {
    items.shift(); // rolling window of the last MAX_OPEN resolved items
  }
  const id = 'u-' + Math.random().toString(36).slice(2, 10);
  items.push({
    id, status: 'open',
    assumption: assumptionText, reason: reasonText, check: checkText,
    recordedAt: Date.now(), resolvedAt: null, resolution: null,
  });
  runState.uncertainties = items;
  agentStore.setRunState(agentId, runState);
  return record;
}

/** Mark one recorded assumption resolved, naming the check actually taken. */
function resolveUncertainty(agentStore, agentId, id, { checkTaken = '' } = {}) {
  const record = agentStore.get(agentId);
  const runState = { ...(record?.runState || {}) };
  const items = Array.isArray(runState.uncertainties) ? runState.uncertainties.map(i => ({ ...i })) : [];
  const item = items.find(i => i.id === id && i.status === 'open');
  if (!item) throw new Error('Unknown or already-resolved uncertainty: ' + String(id));
  item.status = 'resolved';
  item.resolvedAt = Date.now();
  item.resolution = norm(checkTaken) || item.check;
  runState.uncertainties = items;
  agentStore.setRunState(agentId, runState);
  return record;
}

/** Open items, newest first (for prompt rendering). */
function openList(runState) {
  return openItems(runState).slice().reverse();
}

/** The prompt block: '' when there is nothing open. */
function renderUncertaintyBlock(runState) {
  const open = openList(runState);
  if (!open.length) return '';
  const lines = open.map(item => `- [${item.id}] ${item.assumption} (why: ${item.reason}; planned check: ${item.check})`);
  return 'OPEN UNCERTAINTIES (resolve each with its planned check before consequential changes):\n'
    + lines.join('\n')
    + '\nResolve one with the "uncertainty" tool (op: "resolve", id, checkTaken) after you take the check.';
}

module.exports = { recordUncertainty, resolveUncertainty, openList, renderUncertaintyBlock, MAX_OPEN };
