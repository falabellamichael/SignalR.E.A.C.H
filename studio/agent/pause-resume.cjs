'use strict';

/* Reach Studio — shared pause/resume driver for agent runs.
 *
 * An AgentLoop can terminate in a PAUSED state instead of completed:
 *   waiting_edits — it proposed file edits that need the user's verdict
 *   waiting_input — it asked a question and needs an answer
 *
 * Treating a pause as a failure strands the edit card (nothing can ever
 * resume the agent) and kills crews mid-pipeline. This module is the single
 * implementation of "drive a loop to a terminal state, resolving pauses
 * through user callbacks" — used by BOTH TeamRunner roster members and
 * AgentNet spawned workers, so the semantics can never diverge.
 *
 * Contract:
 *   runToTerminal({ loop, store, agentId, isStopped, maxCycles,
 *                   getPendingEdits, clearPendingEdits,
 *                   awaitEditResolution, requestMemberAnswer,
 *                   onWaiting, onQuestion, onResumed, stopSignal })
 *   → { status, output, error, question, cycles }
 *
 * Returns the harvested terminal state. `ok` is the CALLER's decision
 * (crews add stopped/output checks on top of status === 'completed').
 */

const MAX_RESUME_CYCLES = 6;

function harvest(store, agentId, stopped) {
  const rec = store.get(agentId);
  const runState = rec.runState;
  const status = runState?.status || 'unknown';
  const raw = store.lastAssistantText(agentId);
  return { status, runState, raw, question: runState?.reason || null, stopped };
}

async function runToTerminal({
  loop, store, agentId,
  isStopped = () => false,
  maxCycles = MAX_RESUME_CYCLES,
  getPendingEdits = () => [],
  clearPendingEdits = () => {},
  awaitEditResolution = null,
  requestMemberAnswer = null,
  onWaiting = () => {},
  onQuestion = () => {},
  onResumed = () => {},
  stopSignal = () => Promise.resolve(null),   // resolves (to anything) on stop
  firstPrompt,
  control = null,
}) {
  let nextPrompt = firstPrompt;
  let cycles = 0;
  for (;;) {
    if (control) await control.wait(stopSignal);
    if (isStopped()) return { ...harvest(store, agentId, true), cycles };
    await loop.sendUserMessage(nextPrompt);
    if (control) await control.wait(stopSignal);
    const h = harvest(store, agentId, isStopped());
    if (h.stopped) return { ...h, cycles };
    if (control?.interrupted) {
      control.interrupted = false;
      if (h.status === 'stopped') {
        nextPrompt = 'Continue the original task from the saved conversation and tool results. Check the current state before repeating interrupted actions.';
        continue;
      }
    }
    if (h.status === 'completed') return { ...h, cycles };
    if (h.status !== 'waiting_edits' && h.status !== 'waiting_input') {
      return { ...h, cycles };   // failed / paused(round-limit) / unknown
    }
    if (cycles >= maxCycles) {
      return { ...h, cycles, error: `Paused ${cycles} times without finishing; stopped resuming.` };
    }
    cycles++;

    let resume = null;
    if (h.status === 'waiting_edits') {
      const edits = typeof getPendingEdits === 'function' ? (getPendingEdits() || []) : [];
      if (typeof awaitEditResolution !== 'function' || !edits.length) {
        return { ...h, cycles, error: 'Proposed edits could not be reviewed.' };
      }
      clearPendingEdits();
      onWaiting(edits);
      const decisions = await Promise.race([
        awaitEditResolution(edits.map(e => ({ editId: e.editId, path: e.path }))),
        stopSignal(),
      ]);
      if (control) await control.wait(stopSignal);
      if (isStopped()) return { ...harvest(store, agentId, true), cycles };
      if (!decisions || !decisions.length) {
        return { ...h, cycles, error: 'Proposed edits were not accepted.' };
      }
      if (!decisions.some(d => d.accepted)) {
        return { ...h, cycles, error: 'Proposed edits were not accepted.' };
      }
      resume = 'TOOL RESULTS\nThe user reviewed your proposed edits.\n'
        + decisions.map(d => `Edit ${d.path}: ${d.accepted ? 'ACCEPTED and written to disk.' : 'REJECTED by the user.'}`).join('\n')
        + '\nContinue your task from the current on-disk state. Do not re-propose an accepted edit.';
    } else {
      // waiting_input
      if (typeof requestMemberAnswer !== 'function') {
        return { ...h, cycles, error: 'No answer supplied.' };
      }
      const questionId = 'q-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      onQuestion(questionId, h.question || 'The agent needs input.');
      const answer = await Promise.race([
        requestMemberAnswer({ questionId, question: h.question || '' }),
        stopSignal(),
      ]);
      if (control) await control.wait(stopSignal);
      if (isStopped()) return { ...harvest(store, agentId, true), cycles };
      if (!answer || !String(answer).trim()) {
        return { ...h, cycles, error: 'No answer supplied to the agent.' };
      }
      resume = `ANSWER FROM THE USER: ${String(answer).trim()}\nContinue your task with this information.`;
    }

    onResumed(cycles, h.status);
    nextPrompt = resume;
  }
}

module.exports = { runToTerminal, MAX_RESUME_CYCLES };
