'use strict';

module.exports = ({ FINISHED, cleanOutput }) => ({
  _peerStatus(rec) {
    if (FINISHED.has(rec.status)) return rec.status;
    if (rec.control?.paused) return 'paused';
    const status = rec.store?.get(rec.id)?.runState?.status;
    return ['waiting_input', 'waiting_edits'].includes(status) ? status : rec.status;
  },

  // Consume mail inside the existing turn, at a model-request boundary. The
  // scheduler retains mail during a user pause/review and after Stop; draining
  // must never start another conversation or release an approval gate.
  takePendingMessages(agentId) {
    const rec = this.agents.get(agentId);
    if (!rec || this.stopped || this.paused || rec.control?.paused) return [];
    const state = rec.store?.get(rec.id);
    if (['waiting_input', 'waiting_edits', 'stopped', 'skipped'].includes(this._peerStatus(rec))
      || Object.keys(state?.pendingEdits || {}).length) return [];
    if (!rec.inbox?.length) return [];
    return rec.inbox.splice(0);
  },

  status(agentId, callerId) {
    const rec = this._resolve(agentId, callerId);
    if (!rec) return this._notFound(agentId);
    if (rec.ambiguous) return { ok: false, error: `"${agentId}" is ambiguous.`, candidates: rec.ambiguous };
    const status = this._peerStatus(rec);
    if (!rec.store) {
      return {
        ok: true, agentId: rec.id, name: rec.name, model: rec.model, origin: rec.origin,
        depth: rec.depth, status, running: status === 'running',
        note: 'Has not started yet (queued in the crew).', inbox: (rec.inbox || []).length,
        output: '', error: null, todos: [],
      };
    }
    const todos = (rec.store.get(rec.id).todos || []).map(t => ({ text: t.text || t.content || '', status: t.status || '' }));
    return {
      ok: true,
      agentId: rec.id,
      name: rec.name,
      model: rec.model,
      origin: rec.origin,
      depth: rec.depth,
      status,
      running: status === 'running' || status === 'starting',
      ms: (rec.finishedAt || Date.now()) - rec.startedAt,
      messagesSent: rec.messagesSent,
      messagesReceived: rec.messagesReceived,
      inbox: (rec.inbox || []).length,
      todos,
      output: rec.output ? rec.output.slice(0, this.limits.outputPreview) : '',
      error: rec.error,
    };
  },

  transcript(agentId, callerId, limit = null) {
    const rec = this._resolve(agentId, callerId);
    if (!rec) return this._notFound(agentId);
    if (rec.ambiguous) return { ok: false, error: `"${agentId}" is ambiguous.`, candidates: rec.ambiguous };
    if (!rec.store) {
      return { ok: true, agentId: rec.id, name: rec.name, status: rec.status, count: 0, messages: [], note: 'Has not started yet.' };
    }
    // E14: transcriptMessages / transcriptChars are budgets fields. An explicit
    // caller limit still wins; otherwise the configured cap applies.
    const fallback = this.limits.transcriptMessages;
    const requested = Number(limit);
    const n = Math.max(1, Math.min(200, Number.isFinite(requested) && requested > 0 ? requested : fallback));
    const charCap = this.limits.transcriptChars;
    const messages = rec.store.get(rec.id).messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-n)
      .map(m => ({ role: m.role, content: cleanOutput(m.content).slice(0, charCap) }));
    return { ok: true, agentId: rec.id, name: rec.name, status: rec.status, count: messages.length, messages };
  },

  /* Block until a peer finishes. Cycle-checked: A awaiting B while B awaits A
   * would hang the crew, so refuse the edge that closes the loop. */
  async awaitAgent(agentId, callerId, { timeoutMs, signal } = {}) {
    const rec = this._resolve(agentId, callerId);
    if (!rec) return this._notFound(agentId);
    if (rec.ambiguous) return { ok: false, error: `"${agentId}" is ambiguous.`, candidates: rec.ambiguous };
    if (rec.id === callerId) return { ok: false, error: 'An agent cannot await itself.' };
    // Pending roster members and queued operator helpers need a scheduler
    // slot. Blocking the caller can occupy the only slot they could use.
    if ((rec.origin === 'roster' && rec.status === 'pending')
      || (rec.operatorAdded && rec.status === 'queued')) {
      return {
        ok: false,
        agentId: rec.id, name: rec.name, status: rec.status,
        error: `${rec.name} is ${rec.status} for team capacity. Do not await it while holding a team slot. Continue an independent part of your assignment, send the information it needs, or deliver your completed contribution and finish this turn so the scheduler can start it. Do not claim unfinished work is complete.`,
      };
    }
    const cycle = this._awaitCycle(callerId, rec.id);
    if (cycle) return { ok: false, error: `Circular await refused: ${cycle.join(' → ')}. Send the evidence your peer needs and continue independent work; repeated waits cannot resolve this dependency.` };

    // Nurse check-ins are a bounded slice of an otherwise longer dependency
    // wait, including saved/unlimited budgets. They do not fail the peer task.
    const requestedLimit = Math.max(1000, Number(timeoutMs) || this.awaitTimeoutMs);
    const limit = this.nurse?.enabled === true ? Math.min(30000, requestedLimit) : requestedLimit;
    const deadline = Date.now() + limit;
    this.awaiting.set(callerId, rec.id);
    try {
      for (;;) {
        const status = this._peerStatus(rec);
        if (this.stopped) return { ok: false, status, error: 'The crew run was stopped while awaiting.' };
        if (signal?.aborted) return { ok: false, status, error: 'Await interrupted.' };
        if (FINISHED.has(status)) break;
        if (['paused', 'waiting_input', 'waiting_edits'].includes(status)) {
          return { ok: false, agentId: rec.id, name: rec.name, status,
            error: `${rec.name} is ${status}; the pending user decision or review must be respected. Continue independent work or report this specific dependency. Do not repeat waits or bypass the user decision.` };
        }
        const caller = this.agents.get(callerId);
        if (caller?.inbox?.length) {
          // Leave ownership with the mailbox. AgentLoop consumes the messages
          // before its next request; this tool never loses or duplicates them.
          return { ok: true, waiting: true, messagesPending: true,
            agentId: rec.id, name: rec.name, status,
            output: String(rec.output || '').slice(0, this.limits.outputPreview),
            note: `Crew messages arrived for you while ${rec.name} is still ${status}. Read the incoming handoff and take the next useful action; this is not a completion result for ${rec.name}.` };
        }
        if (Date.now() >= deadline) {
          if (this.nurse?.enabled === true) {
            return { ok: true, waiting: true, checkIn: true,
              agentId: rec.id, name: rec.name, status,
              output: String(rec.output || '').slice(0, this.limits.outputPreview),
              note: `Team Nurse check-in after ${Math.round(limit / 1000)}s: ${rec.name} is still ${status}. Continue independent work or send a specific dependency request. New crew messages will be delivered at your next request. This is not proof of completion; do not repeat waits without new information.` };
          }
          return { ok: false, timedOut: true, status, agentId: rec.id, name: rec.name,
            output: String(rec.output || '').slice(0, this.limits.outputPreview),
            error: `Peer wait ended after ${Math.round(limit / 1000)}s; ${rec.name} is still ${status}. Continue independent work, send concrete evidence or a specific dependency request, and use incoming crew messages to resume dependent work. Do not repeat waits without new information or claim this peer has completed.` };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return {
        ok: rec.status === 'completed',
        agentId: rec.id, name: rec.name, status: rec.status,
        output: rec.output.slice(0, this.limits.outputPreview), error: rec.error,
        ms: (rec.finishedAt || Date.now()) - rec.startedAt,
      };
    } finally {
      this.awaiting.delete(callerId);
    }
  },

  _awaitCycle(callerId, targetId) {
    // Would caller→target close a loop through the existing await graph?
    const path = [callerId, targetId];
    let cur = targetId;
    for (let i = 0; i < this.agents.size + 2; i++) {
      const next = this.awaiting.get(cur);
      if (!next) return null;
      if (next === callerId) return [...path, next].map(id => this.agents.get(id)?.name || id);
      path.push(next);
      cur = next;
    }
    return null;
  },
});
